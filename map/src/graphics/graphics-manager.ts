// Graphics manager — the `map.graphics` host DRAWING API façade (#797).
//
// Phase 0 surface: addImage / hasImage / removeImage (host sprite images).
// Phase 1 surface: add / update / remove — RETAINED, geo-anchored icon batches
// that project on the GPU (via the reused point ladder + pointU frame uniform),
// so a camera move rewrites ONLY the frame uniform — the per-instance buffers are
// packed ONCE at add()/update() and never touched per frame (N-independent).
//
// The CPU registry is DEVICE-FREE and map-lifetime; the GPU atlas mirror + the
// retained draper + the batch buffers are per-run (re)built after each initGPU
// and dropped on scene swap, while the registry survives so host images persist.

import { HostImageRegistry } from '../sprite/host-image-registry'
import { HostSpriteAtlasGPU } from '../sprite/host-sprite-atlas-gpu'
import { HostSpriteAtlasRhi } from '../sprite/host-sprite-atlas-rhi'
import { RetainedIconDraper } from '../render/material/icon-retained-material'
import { packRetainedIconFeat, packRetainedIconTint } from './retained-icon-packer'
import type { IconDrawSpec, DrawHandle, IconUpdateTrigger } from './graphics-types'
import {
  writePointFrameUniform,
  pointUniformBytes,
  pointWorldCopies,
} from '../render/point-renderer'
import { worldCopyMercX } from '../render/point-feature-packer'
import { xlog } from '@xgis/shared'
import { pointU } from '../shaders/dsl/point'
import {
  uniformBlock,
  type UniformBlockOf,
  type RhiDevice,
  type RhiBuffer,
  type RhiBindGroup,
  type RhiRenderPass,
} from '@xgis/engine'
import type { Camera } from '../camera'

/** One full Mercator world-width in metres — the per-copy `world_offset` step
 *  the flat-Mercator shader branch adds (worldCopyMercX(0,1) = 1×WORLD_WIDTH). */
const WORLD_WIDTH = worldCopyMercX(0, 1)

/** A live retained icon batch. The spec is retained so `update()` can re-run its
 *  accessors; the GPU buffers + bind group are null until materialised (a device
 *  exists). */
interface RetainedIconBatch {
  spec: IconDrawSpec<unknown>
  count: number
  featBuf: RhiBuffer | null
  tintBuf: RhiBuffer | null
  bindGroup: RhiBindGroup | null
}

export class GraphicsManager {
  private readonly registry = new HostImageRegistry()
  /** The per-run GPU atlas mirror: the WebGPU-native twin, or the RHI-native
   *  twin on the WebGL2 backend (#823) — both pack through the shared
   *  HostAtlasPacker, so sprite coordinates are backend-identical. */
  private atlas: HostSpriteAtlasGPU | HostSpriteAtlasRhi | null = null

  // ── Phase 1 retained-batch state (per-run, built in attachDevice). ──
  private rhi: RhiDevice | null = null
  private draper: RetainedIconDraper | null = null
  private frameBlock: UniformBlockOf<typeof pointU> | null = null
  private _blockView: Float32Array | null = null
  private readonly batches: RetainedIconBatch[] = []
  /** Per-copy frame-uniform scratch (grown to peak world-copy count) — reused so
   *  the per-frame render allocates nothing proportional to icon count. */
  private readonly _copyScratch: Float32Array[] = []
  /** Buffers retired by remove()/rematerialise, destroyed at the START of the next
   *  renderRetained so any in-flight submit that bound them completes first
   *  (mirrors PointRenderer.retiredTilePointBuffers). */
  private readonly _retired: RhiBuffer[] = []
  /** DPR baked into the packed pixel sizes; a change re-packs (rare). */
  private dpr = 1
  /** Map repaint trigger (set by map.ts) so add()/update()/remove() repaint an
   *  idle map — mirrors addImage's markLabelDirty re-arm. */
  private repaintHook: (() => void) | null = null

  // ── Diagnostics (#797 P1 gate instrumentation) ─────────────────────────────
  // GPU-upload counters, incremented ONLY at the feat/tint writeBuffer sites
  // (materialise / update / dpr re-pack) — NEVER in renderRetained. A pan/zoom
  // loop that leaves these UNCHANGED proves the retained pack is not re-run on a
  // camera-only frame; an update({color}) bumping ONLY _tintWrites proves the
  // color path re-uploads only the tint attribute. Cheap integer increments.
  private _featWrites = 0
  private _tintWrites = 0
  /** Per-frame renderRetained CPU-time samples (ms), collected only when timing is
   *  enabled — for the N-independence gate (flat 10k vs 100k). Null = off. */
  private _timeSamples: number[] | null = null

  setRepaintHook(hook: () => void): void {
    this.repaintHook = hook
  }

  /** GPU-upload counters — see the diagnostics note. */
  getWriteCounts(): { featWrites: number; tintWrites: number } {
    return { featWrites: this._featWrites, tintWrites: this._tintWrites }
  }

  /** Enable/reset (or disable) per-frame renderRetained CPU timing. */
  setRenderTiming(on: boolean): void {
    this._timeSamples = on ? [] : null
  }

  /** Collected renderRetained CPU-time samples (ms) since the last enable. */
  getRenderTimeSamples(): readonly number[] {
    return this._timeSamples ?? []
  }

  /**
   * Register a host image into the sprite atlas under `name` (Mapbox
   * `map.addImage` parity). See the Phase-0 limitations note (host-only render,
   * no eviction, bounded page) — unchanged here.
   */
  addImage(name: string, image: ImageBitmap | ImageData): void {
    this.registry.addImage(name, image)
    this.atlas?.markDirty()
  }

  hasImage(name: string): boolean {
    return this.registry.hasImage(name)
  }

  removeImage(name: string): void {
    this.registry.removeImage(name)
  }

  // ── Phase 1 — retained geo-anchored icon batches ───────────────────────────

  /** Add a retained icon batch. Accessors run ONCE here (never per frame). The
   *  GPU buffers materialise immediately when a device exists, else on the next
   *  attachDevice. Register images (addImage) BEFORE add() so their sprites
   *  resolve (a missing sprite packs an invisible instance + warns). */
  add<D>(spec: IconDrawSpec<D>): DrawHandle {
    const batch: RetainedIconBatch = {
      spec: spec as IconDrawSpec<unknown>,
      count: spec.data.length,
      featBuf: null,
      tintBuf: null,
      bindGroup: null,
    }
    this.batches.push(batch)
    this.materialise(batch)
    this.repaintHook?.()
    return {
      get count() {
        return batch.count
      },
      update: (patch) => this.updateBatch(batch, patch.triggers),
      remove: () => this.removeBatch(batch),
    }
  }

  /** True when there is retained work to run the graphics pass for — at least one
   *  DRAWABLE batch (count > 0), OR pending buffers to drain. Gates
   *  SceneView.hasGraphics. Including `_retired` here is load-bearing: removing the
   *  LAST batch empties `batches`, so without it the pass would stop running and
   *  the retired buffers (freed at the top of renderRetained) would never drain —
   *  a leak. An empty-data batch (count 0) does NOT flip the gate, so a map with no
   *  visible host icons stays byte-identical. */
  hasRetainedBatches(): boolean {
    return this.batches.some((b) => b.count > 0) || this._retired.length > 0
  }

  /** Build (or rebuild) a batch's GPU buffers + cached bind group. No-op until a
   *  device is attached (deferred materialisation for pre-run add()). */
  private materialise(batch: RetainedIconBatch): void {
    if (!this.rhi || !this.atlas || !this.draper) return
    const feat = packRetainedIconFeat(batch.spec, this.atlas, this.dpr)
    const tint = packRetainedIconTint(batch.spec)
    if (batch.featBuf) this._retired.push(batch.featBuf)
    if (batch.tintBuf) this._retired.push(batch.tintBuf)
    batch.featBuf = this.rhi.createBuffer({
      size: Math.max(feat.byteLength, 16),
      usage: 'storage',
      writable: true,
      label: 'retained-icon-feat',
    })
    this.rhi.writeBuffer(batch.featBuf, 0, feat)
    this._featWrites++
    batch.tintBuf = this.rhi.createBuffer({
      size: Math.max(tint.byteLength, 16),
      usage: 'storage',
      writable: true,
      label: 'retained-icon-tint',
    })
    this.rhi.writeBuffer(batch.tintBuf, 0, tint)
    this._tintWrites++
    // Atlas view/sampler are Phase-0 stable-identity → the bind group is built ONCE.
    // rhiView/rhiSampler are backend-blind (the WebGPU atlas wraps its native
    // handles; the RHI atlas hands its own through).
    batch.bindGroup = this.draper.makeBatchBindGroup(
      batch.featBuf,
      batch.tintBuf,
      this.atlas.rhiView(),
      this.atlas.rhiSampler(),
    )
    batch.count = batch.spec.data.length
  }

  /** Re-run the named accessors and re-upload their attribute(s). `color`
   *  re-uploads ONLY the tint buffer (one writeBuffer, no bind-group rebuild —
   *  the buffer identity is stable); any other trigger re-packs the feat buffer. */
  private updateBatch(batch: RetainedIconBatch, triggers: readonly IconUpdateTrigger[]): void {
    if (!this.rhi || !this.atlas || batch.featBuf === null || batch.tintBuf === null) return
    // Phase-1 contract: update() re-runs accessors on the FIXED data set — it never
    // resizes. The feat/tint buffers were sized to the add()-time count, so a longer
    // `data` would overflow the writeBuffer (and a shorter one would leave a stale
    // draw count). Adding/removing rows is a later phase (append); reject a size
    // change LOUDLY here rather than corrupt the buffer or read past it.
    if (batch.spec.data.length !== batch.count) {
      xlog.warn(
        `[X-GIS graphics] update() cannot change the batch size (was ${batch.count}, now ` +
          `${batch.spec.data.length}) — re-add the batch instead`,
      )
      return
    }
    if (triggers.includes('color')) {
      this.rhi.writeBuffer(batch.tintBuf, 0, packRetainedIconTint(batch.spec))
      this._tintWrites++
    }
    if (triggers.some((t) => t !== 'color')) {
      this.rhi.writeBuffer(batch.featBuf, 0, packRetainedIconFeat(batch.spec, this.atlas, this.dpr))
      this._featWrites++
    }
    this.repaintHook?.()
  }

  private removeBatch(batch: RetainedIconBatch): void {
    const i = this.batches.indexOf(batch)
    if (i < 0) return
    this.batches.splice(i, 1)
    if (batch.featBuf) this._retired.push(batch.featBuf)
    if (batch.tintBuf) this._retired.push(batch.tintBuf)
    batch.featBuf = batch.tintBuf = batch.bindGroup = null
    batch.count = 0
    this.repaintHook?.()
  }

  /** Draw every live retained batch across the visible world copies. Called from
   *  the graphics pass. Per frame this does O(COPIES) uniform writes + O(COPIES ×
   *  batches) draws — ZERO work proportional to icon count (the N-independence
   *  gate). */
  renderRetained(
    pass: RhiRenderPass,
    frame: { matrix: Float32Array; logDepthFc: number; eye?: readonly [number, number, number] },
    camera: Camera,
    projType: number,
    projCenterLon: number,
    projCenterLat: number,
    canvasWidth: number,
    canvasHeight: number,
    dpr: number,
  ): void {
    // Drain buffers retired by a prior frame's remove()/rematerialise (their
    // submit has returned; safe to destroy now).
    if (this._retired.length > 0) {
      for (const b of this._retired) this.rhi?.destroyBuffer(b)
      this._retired.length = 0
    }
    if (!this.draper || !this.frameBlock || this._blockView === null) return
    this.applyDpr(dpr)

    const drawable = this.batches.filter((b) => b.bindGroup !== null && b.count > 0)
    if (drawable.length === 0) return

    // Per-frame CPU-time sample (gate: this must be FLAT across icon count — the
    // work below is O(COPIES × batches), never O(N)).
    const t0 = this._timeSamples !== null ? performance.now() : 0

    // Base frame uniform (circle_params defaults to 0). Reused verbatim from the
    // point path so the DSFUN camera anchor stays single-authority.
    writePointFrameUniform(
      this.frameBlock,
      frame,
      camera,
      projType,
      projCenterLon,
      projCenterLat,
      canvasWidth,
      canvasHeight,
    )
    // One frame-uniform snapshot per visible world copy — each with its own
    // world_offset poked into circle_params.x (dead-for-icons). Copies are 1..~5
    // (only flat Mercator at low zoom fans out), so this is O(1) in icon count.
    const copies = pointWorldCopies(projType, camera, canvasWidth, canvasHeight, dpr)
    const perCopy: Float32Array[] = []
    for (let i = 0; i < copies.length; i++) {
      this.frameBlock.set.circle_params(copies[i]! * WORLD_WIDTH, 0, 0, 0)
      if (i >= this._copyScratch.length) {
        this._copyScratch.push(new Float32Array(this.frameBlock.byteLength / 4))
      }
      this._copyScratch[i]!.set(this._blockView)
      perCopy.push(this._copyScratch[i]!)
    }

    // Every batch shares the SAME per-copy frame uniform (the camera/projection is
    // batch-independent), so passing one `perCopy` array to each batch's draw is
    // correct even though executeItems re-writes the pool slots per batch: each
    // pool slot ends holding its own copy's world_offset at draw time. If a future
    // change makes the frame uniform batch-specific (e.g. per-batch opacity), this
    // reuse must be revisited (write the pool once, rebind per batch).
    for (const b of drawable) this.draper.draw(pass, b.bindGroup!, perCopy, b.count)

    if (this._timeSamples !== null) this._timeSamples.push(performance.now() - t0)
  }

  /** Re-pack every batch's feat buffer when the DPR changes (rare — a window
   *  moving between hidpi/lodpi displays). Baked into the pixel size at pack time
   *  so the shader stays a pure px→NDC transform. */
  private applyDpr(dpr: number): void {
    const d = dpr > 0 ? dpr : 1
    if (d === this.dpr) return
    this.dpr = d
    if (!this.rhi || !this.atlas) return
    for (const b of this.batches) {
      if (b.featBuf === null) continue
      // Same fixed-size contract as updateBatch — skip a batch whose data length
      // drifted from its buffer capacity (out-of-contract mutation; updateBatch warns).
      if (b.spec.data.length !== b.count) continue
      this.rhi.writeBuffer(b.featBuf, 0, packRetainedIconFeat(b.spec, this.atlas, d))
      this._featWrites++
    }
  }

  // ── internal (map.ts only) ─────────────────────────────────────────────

  /** Attach a freshly-initialised GPU device — builds the per-run atlas mirror +
   *  the retained draper, and (re)materialises any batches added before the
   *  device existed. Called after each initGPU in run()/runBinary().
   *
   *  The draper's Material is SINGLE-SAMPLE (sampleCount 1): the graphics pass
   *  draws onto the already-resolved swapchain (ctx.screenView) AFTER the label
   *  pass resolved MSAA — same strategy as the heatmap / overdraw-compose passes.
   *  Icons need no MSAA (raster edges are texture-alpha; there is no SDF host
   *  path yet), so this sidesteps the resolve-ownership hazard entirely. */
  attachDevice(device: GPUDevice, rhi: RhiDevice, format: GPUTextureFormat): void {
    // #823 — on the WebGL2 backend `device` is the no-op Proxy stub
    // (initGPUForcedWebGL2), so the WebGPU atlas would silently upload nothing;
    // build the RHI-native twin instead (same shared packer → same coordinates).
    this.atlas =
      rhi.backend === 'webgl2'
        ? new HostSpriteAtlasRhi(rhi, this.registry)
        : new HostSpriteAtlasGPU(device, this.registry)
    this.rhi = rhi
    this.draper = new RetainedIconDraper(rhi, format, 1, pointUniformBytes())
    this.frameBlock = uniformBlock(pointU)
    this._blockView = new Float32Array(this.frameBlock.buffer)
    for (const b of this.batches) this.materialise(b)
  }

  /** The per-run WebGPU atlas mirror, or null before attachDevice — and null on
   *  the WebGL2 backend (#823), whose consumers (label pass / icon stage) never
   *  run there. The retained-icon path reads `this.atlas` directly instead. */
  hostAtlas(): HostSpriteAtlasGPU | null {
    return this.atlas instanceof HostSpriteAtlasGPU ? this.atlas : null
  }

  /** True when at least one host image is registered. */
  hasAnyImage(): boolean {
    return this.registry.size > 0
  }

  /** Drop the per-run GPU atlas + retained batch buffers on a scene swap /
   *  destroy. The registry + the batch SPECS are KEPT so a re-load re-materialises
   *  host images + retained batches into the new device. */
  destroyGpu(): void {
    this.atlas?.destroy()
    this.atlas = null
    for (const b of this._retired) this.rhi?.destroyBuffer(b)
    this._retired.length = 0
    for (const b of this.batches) {
      if (b.featBuf) this.rhi?.destroyBuffer(b.featBuf)
      if (b.tintBuf) this.rhi?.destroyBuffer(b.tintBuf)
      b.featBuf = b.tintBuf = b.bindGroup = null
    }
    this.rhi = null
    this.draper = null
    this.frameBlock = null
    this._blockView = null
  }
}
