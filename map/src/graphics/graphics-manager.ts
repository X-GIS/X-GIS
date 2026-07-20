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
import { RetainedArrowDraper } from '../render/material/arrow-retained-material'
import { RetainedCircleDraper } from '../render/material/circle-retained-material'
import { RetainedParticleDraper } from '../render/material/particle-retained-material'
import { packRetainedIconFeat, packRetainedIconTint } from './retained-icon-packer'
import { packRetainedArrowFeat, packRetainedArrowTint } from './retained-arrow-packer'
import { packRetainedCircleFeat, packRetainedCircleTint } from './retained-circle-packer'
import {
  packRetainedParticleFeat,
  packRetainedParticleTint,
  resolveParticleInstanceCount,
} from './retained-particle-packer'
import {
  packRetainedTextFeat,
  packRetainedTextTint,
  type GlyphShaper,
} from './retained-text-packer'
import type { DrawSpec, DrawHandle, IconUpdateTrigger, TextDrawSpec } from './graphics-types'
import { animTimePinnedSeconds } from '../debug-flags'
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

/** The GPU instance (draw) count for a batch. For every primitive this is one instance per data
 *  row — EXCEPT particle-flow, whose `data` is the per-gu FIELD that the packer EXPANDS into a
 *  FIXED pool of particles (design §2.3); its instance count is that fixed pool size, decoupled
 *  from the gu count and stable across a per-hour re-pack (design §5-Q6), so the fixed-size
 *  update()/DPR re-pack guards still hold. */
function instanceCountOf(spec: DrawSpec<unknown>): number {
  return spec.type === 'particle-flow' ? resolveParticleInstanceCount(spec) : spec.data.length
}

/** A live retained icon batch. The spec is retained so `update()` can re-run its
 *  accessors; the GPU buffers + bind group are null until materialised (a device
 *  exists). */
interface RetainedIconBatch {
  spec: DrawSpec<unknown>
  count: number
  featBuf: RhiBuffer | null
  tintBuf: RhiBuffer | null
  bindGroup: RhiBindGroup | null
  /** TEXT batches only: per-datum glyph-instance counts from the feat pack, cached so a color-only
   *  update rebuilds the tint buffer WITHOUT re-shaping. Null for icon/circle/arrow. */
  glyphCounts: Uint32Array | null
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
  private arrowDraper: RetainedArrowDraper | null = null
  private circleDraper: RetainedCircleDraper | null = null
  private particleDraper: RetainedParticleDraper | null = null
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
  /** The glyph-shaping seam for retained TEXT batches — a READ-ONLY view of the shared SDF glyph
   *  atlas (adapts `TextStage.host.ensureString` + `TextStage.gpu.pageSizePx`). Injected (not
   *  constructed here) so the packer never couples to TextStage internals and stays stub-testable;
   *  null until wired. A text batch cannot shape/pack until this is set (deferred, like a device). */
  private glyphShaper: GlyphShaper | null = null

  // ── Diagnostics (#797 P1 gate instrumentation) ─────────────────────────────
  // GPU-upload counters, incremented ONLY at the feat/tint writeBuffer sites
  // (materialise / update / dpr re-pack) — NEVER in renderRetained. A pan/zoom
  // loop that leaves these UNCHANGED proves the retained pack is not re-run on a
  // camera-only frame; an update({color}) bumping ONLY _tintWrites proves the
  // color path re-uploads only the tint attribute. Cheap integer increments.
  private _featWrites = 0
  private _tintWrites = 0
  /** Draw calls issued by the LAST renderRetained frame (reset every frame). The
   *  retained path issues exactly ONE instanced draw per world copy per drawable
   *  batch, so this is O(COPIES × batches) and NEVER grows with icon count — the
   *  EXACT (zero-slack) N-independence invariant (10k and 100k icons issue the
   *  identical draw-call count at a fixed view). A per-item fallback would make
   *  this = N. Summed from the drapers' real `pass.draw` count (executeItems). */
  private _lastFrameDrawCalls = 0
  /** Per-frame renderRetained CPU-time samples (ms), collected only when timing is
   *  enabled — for the N-independence gate (flat 10k vs 100k). Null = off. */
  private _timeSamples: number[] | null = null

  setRepaintHook(hook: () => void): void {
    this.repaintHook = hook
  }

  /** Inject (or clear) the retained-text glyph shaper — the read-only glyph-atlas seam. Setting it
   *  (re)materialises any TEXT batches added before it existed (order-independent, like a deferred
   *  device); the shaper's atlas re-arm feeds the same async-land repaint path as labels. */
  setGlyphShaper(shaper: GlyphShaper | null): void {
    this.glyphShaper = shaper
    if (shaper) {
      for (const b of this.batches) {
        if (b.spec.type === 'text' && b.featBuf === null) this.materialise(b)
      }
    }
  }

  /** GPU-upload counters — see the diagnostics note. */
  getWriteCounts(): { featWrites: number; tintWrites: number } {
    return { featWrites: this._featWrites, tintWrites: this._tintWrites }
  }

  /** Draw calls issued by the last renderRetained frame — see the field note.
   *  The #797 P1 draw-call N-independence gate reads this at a fixed view for
   *  10k vs 100k icons and asserts they are identical (and O(COPIES), not O(N)). */
  getLastFrameDrawCalls(): number {
    return this._lastFrameDrawCalls
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
  add<D>(spec: DrawSpec<D>): DrawHandle<D> {
    // A handle owns ONE OR MORE batches: add() seeds it with one; append() links
    // more. Each appended batch is a NORMAL entry in `this.batches`, so
    // renderRetained / applyDpr / destroyGpu / the retired-drain all handle it with
    // ZERO extra machinery, and an append never touches the seed batch's buffers
    // (the appended rows live in their OWN feat/tint buffers — the strongest
    // "existing-row bytes untouched" guarantee, and the seed's accessors never
    // re-run). Icon/arrow batches never append → `owned` stays [seed], so their
    // lifecycle stays byte-identical.
    const seedSpec = spec as DrawSpec<unknown>
    const owned: RetainedIconBatch[] = [this.makeBatch(seedSpec)]
    this.repaintHook?.()
    return {
      get count() {
        let c = 0
        for (const b of owned) c += b.count
        return c
      },
      update: (patch) => {
        for (const b of owned) this.updateBatch(b, patch.triggers)
      },
      append: (data) => {
        if (data.length === 0) return
        // Pack ONLY the appended rows: a shallow sub-spec reuses the seed's type +
        // accessors with the new data, run through the SAME materialise path.
        const sub = { ...seedSpec, data } as DrawSpec<unknown>
        owned.push(this.makeBatch(sub))
        this.repaintHook?.()
      },
      remove: () => {
        for (const b of owned) this.removeBatch(b)
        owned.length = 0
      },
    }
  }

  /** Create + materialise a retained batch and register it for drawing. Shared by
   *  add() (the seed batch) and append() (each appended batch — a separate pack). */
  private makeBatch(spec: DrawSpec<unknown>): RetainedIconBatch {
    const batch: RetainedIconBatch = {
      spec,
      count: instanceCountOf(spec),
      featBuf: null,
      tintBuf: null,
      bindGroup: null,
      glyphCounts: null,
    }
    this.batches.push(batch)
    this.materialise(batch)
    return batch
  }

  /** True when there is retained work to run the graphics pass for — at least one
   *  DRAWABLE batch (count > 0), OR pending buffers to drain. Gates
   *  SceneView.hasGraphics. Including `_retired` here is load-bearing: removing the
   *  LAST batch empties `batches`, so without it the pass would stop running and
   *  the retired buffers (freed at the top of renderRetained) would never drain —
   *  a leak. An empty-data batch (count 0) does NOT flip the gate, so a map with no
   *  visible host icons stays byte-identical. */
  hasRetainedBatches(): boolean {
    // A batch counts only once it is DRAWABLE (has a bind group). For icon/circle/arrow a
    // materialised count>0 batch always has one, so this is unchanged for them; a retained TEXT
    // batch has no bind group until the (pending) SDF text draper lands, so a text-only map stays
    // byte-identical / no-pass — it is packed + uploaded but not yet drawn.
    return this.batches.some((b) => b.count > 0 && b.bindGroup !== null) || this._retired.length > 0
  }

  /** Build (or rebuild) a batch's GPU buffers + cached bind group. No-op until a
   *  device is attached (deferred materialisation for pre-run add()). */
  private materialise(batch: RetainedIconBatch): void {
    const spec = batch.spec
    if (spec.type === 'text') {
      this.materialiseText(batch, spec)
      return
    }
    if (
      !this.rhi ||
      !this.atlas ||
      !this.draper ||
      !this.arrowDraper ||
      !this.circleDraper ||
      !this.particleDraper
    )
      return
    const feat =
      spec.type === 'arrow'
        ? packRetainedArrowFeat(spec, this.dpr)
        : spec.type === 'circle'
          ? packRetainedCircleFeat(spec, this.dpr)
          : spec.type === 'particle-flow'
            ? packRetainedParticleFeat(spec, this.dpr)
            : packRetainedIconFeat(spec, this.atlas, this.dpr)
    const tint =
      spec.type === 'arrow'
        ? packRetainedArrowTint(spec)
        : spec.type === 'circle'
          ? packRetainedCircleTint(spec)
          : spec.type === 'particle-flow'
            ? packRetainedParticleTint(spec)
            : packRetainedIconTint(spec)
    if (batch.featBuf) this._retired.push(batch.featBuf)
    if (batch.tintBuf) this._retired.push(batch.tintBuf)
    batch.featBuf = this.rhi.createBuffer({
      size: Math.max(feat.byteLength, 16),
      usage: 'storage',
      writable: true,
      label:
        spec.type === 'arrow'
          ? 'retained-arrow-feat'
          : spec.type === 'circle'
            ? 'retained-circle-feat'
            : spec.type === 'particle-flow'
              ? 'retained-particle-feat'
              : 'retained-icon-feat',
    })
    this.rhi.writeBuffer(batch.featBuf, 0, feat)
    this._featWrites++
    batch.tintBuf = this.rhi.createBuffer({
      size: Math.max(tint.byteLength, 16),
      usage: 'storage',
      writable: true,
      label:
        spec.type === 'arrow'
          ? 'retained-arrow-tint'
          : spec.type === 'circle'
            ? 'retained-circle-tint'
            : spec.type === 'particle-flow'
              ? 'retained-particle-tint'
              : 'retained-icon-tint',
    })
    this.rhi.writeBuffer(batch.tintBuf, 0, tint)
    this._tintWrites++
    // Bind group built ONCE (stable buffers; icon's atlas view/sampler are stable-identity;
    // the arrow has no atlas). A camera-only frame never rebuilds it. rhiView/rhiSampler are
    // backend-blind (the WebGPU atlas wraps its native handles; the RHI atlas hands its own
    // through).
    batch.bindGroup =
      spec.type === 'arrow'
        ? this.arrowDraper.makeBatchBindGroup(batch.featBuf, batch.tintBuf)
        : spec.type === 'circle'
          ? this.circleDraper.makeBatchBindGroup(batch.featBuf, batch.tintBuf)
          : spec.type === 'particle-flow'
            ? this.particleDraper.makeBatchBindGroup(batch.featBuf, batch.tintBuf)
            : this.draper.makeBatchBindGroup(
                batch.featBuf,
                batch.tintBuf,
                this.atlas.rhiView(),
                this.atlas.rhiSampler(),
              )
    batch.count = instanceCountOf(spec)
  }

  /** Materialise a retained TEXT batch: SHAPE + pack the per-glyph feat/tint buffers ONCE and upload
   *  them (one writeBuffer each). Deferred until BOTH a device and a glyph shaper exist (the shaper
   *  is the read-only glyph-atlas seam — see setGlyphShaper). NOTE: the GPU render side (the SDF text
   *  draper + glyph-atlas bind group + instanced draw) is the PENDING Phase-2b GPU step; until it
   *  lands `bindGroup` stays null, so the batch is packed + uploaded but not drawn (and never flips
   *  the render gate). `glyphCounts` is cached so a color-only update re-packs tint without shaping. */
  private materialiseText(batch: RetainedIconBatch, spec: TextDrawSpec<unknown>): void {
    if (!this.rhi || !this.glyphShaper) return
    const { feat, glyphCounts } = packRetainedTextFeat(spec, this.glyphShaper, this.dpr)
    const tint = packRetainedTextTint(spec, glyphCounts)
    if (batch.featBuf) this._retired.push(batch.featBuf)
    if (batch.tintBuf) this._retired.push(batch.tintBuf)
    batch.featBuf = this.rhi.createBuffer({
      size: Math.max(feat.byteLength, 16),
      usage: 'storage',
      writable: true,
      label: 'retained-text-feat',
    })
    this.rhi.writeBuffer(batch.featBuf, 0, feat)
    this._featWrites++
    batch.tintBuf = this.rhi.createBuffer({
      size: Math.max(tint.byteLength, 16),
      usage: 'storage',
      writable: true,
      label: 'retained-text-tint',
    })
    this.rhi.writeBuffer(batch.tintBuf, 0, tint)
    this._tintWrites++
    batch.glyphCounts = glyphCounts
    batch.count = spec.data.length
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
    if (instanceCountOf(batch.spec) !== batch.count) {
      xlog.warn(
        `[X-GIS graphics] update() cannot change the batch size (was ${batch.count}, now ` +
          `${instanceCountOf(batch.spec)}) — re-add the batch instead`,
      )
      return
    }
    const spec = batch.spec
    if (spec.type === 'particle-flow') {
      // A particle's colour follows its home-gu ALLOCATION (which lives in the feat pack), so tint
      // and feat must stay in lockstep — any particle update re-packs BOTH (update() is the ≤1 Hz
      // per-hour re-pack, off the hot path). No color-only tint fast path here by construction.
      if (triggers.length === 0) return
      this.rhi.writeBuffer(batch.tintBuf, 0, packRetainedParticleTint(spec))
      this._tintWrites++
      this.rhi.writeBuffer(batch.featBuf, 0, packRetainedParticleFeat(spec, this.dpr))
      this._featWrites++
      this.repaintHook?.()
      return
    }
    if (spec.type === 'text') {
      // Text: 'color' re-packs ONLY the tint buffer (reusing the cached glyphCounts — no re-shape);
      // any other trigger re-shapes + re-packs ONLY the feat buffer. Same dirty-range boundary as
      // the circle path (one attribute buffer touched per trigger class).
      if (this.glyphShaper) {
        if (triggers.includes('color') && batch.glyphCounts) {
          this.rhi.writeBuffer(batch.tintBuf, 0, packRetainedTextTint(spec, batch.glyphCounts))
          this._tintWrites++
        }
        if (triggers.some((t) => t !== 'color')) {
          const { feat, glyphCounts } = packRetainedTextFeat(spec, this.glyphShaper, this.dpr)
          this.rhi.writeBuffer(batch.featBuf, 0, feat)
          this._featWrites++
          batch.glyphCounts = glyphCounts
        }
      }
      this.repaintHook?.()
      return
    }
    if (triggers.includes('color')) {
      this.rhi.writeBuffer(
        batch.tintBuf,
        0,
        spec.type === 'arrow'
          ? packRetainedArrowTint(spec)
          : spec.type === 'circle'
            ? packRetainedCircleTint(spec)
            : packRetainedIconTint(spec),
      )
      this._tintWrites++
    }
    if (triggers.some((t) => t !== 'color')) {
      this.rhi.writeBuffer(
        batch.featBuf,
        0,
        spec.type === 'arrow'
          ? packRetainedArrowFeat(spec, this.dpr)
          : spec.type === 'circle'
            ? packRetainedCircleFeat(spec, this.dpr)
            : packRetainedIconFeat(spec, this.atlas, this.dpr),
      )
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
    // Reset the per-frame draw-call count FIRST (before any early return), so a
    // frame with nothing drawable honestly reports 0 and the gate reads the most
    // recent frame's true count.
    this._lastFrameDrawCalls = 0
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
      dpr,
    )
    // One frame-uniform snapshot per visible world copy — each with its own
    // world_offset poked into circle_params.x (dead-for-icons). Copies are 1..~5
    // (only flat Mercator at low zoom fans out), so this is O(1) in icon count.
    const copies = pointWorldCopies(projType, camera, canvasWidth, canvasHeight, dpr)
    // Animation clock (design §3.0): a scalar `t` (seconds) rides the FREE circle_params.y lane of
    // the per-copy frame uniform (which the retained path already writes O(1)/frame, and which the
    // icon/arrow/circle shaders do NOT read). Written nonzero ONLY when a particle batch is
    // drawable, so a non-particle frame is byte-identical (y = 0 as before — zero pointU bloat, the
    // §5-Q2 constraint). Pinned by ?animt / __xgisAnimT for the §5 deterministic-probe capture,
    // else the live performance.now(). O(1) in particle count — the only new per-frame cost.
    const hasParticles = drawable.some((b) => b.spec.type === 'particle-flow')
    const animT = hasParticles ? (animTimePinnedSeconds() ?? performance.now() / 1000) : 0
    const perCopy: Float32Array[] = []
    for (let i = 0; i < copies.length; i++) {
      this.frameBlock.set.circle_params(copies[i]! * WORLD_WIDTH, animT, 0, 0)
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
    for (const b of drawable) {
      const draper =
        b.spec.type === 'arrow'
          ? this.arrowDraper
          : b.spec.type === 'circle'
            ? this.circleDraper
            : b.spec.type === 'particle-flow'
              ? this.particleDraper
              : this.draper
      // Sum the drapers' REAL draw-call count (one instanced draw per world copy).
      // This is O(COPIES × batches), never O(N) — the draw-call N-independence gate.
      this._lastFrameDrawCalls += draper?.draw(pass, b.bindGroup!, perCopy, b.count) ?? 0
    }

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
      // Same fixed-size contract as updateBatch — skip a batch whose instance count
      // drifted from its buffer capacity (out-of-contract mutation; updateBatch warns).
      if (instanceCountOf(b.spec) !== b.count) continue
      const s = b.spec
      if (s.type === 'text') {
        if (this.glyphShaper) {
          const { feat, glyphCounts } = packRetainedTextFeat(s, this.glyphShaper, d)
          this.rhi.writeBuffer(b.featBuf, 0, feat)
          this._featWrites++
          b.glyphCounts = glyphCounts
        }
        continue
      }
      this.rhi.writeBuffer(
        b.featBuf,
        0,
        s.type === 'arrow'
          ? packRetainedArrowFeat(s, d)
          : s.type === 'circle'
            ? packRetainedCircleFeat(s, d)
            : s.type === 'particle-flow'
              ? packRetainedParticleFeat(s, d)
              : packRetainedIconFeat(s, this.atlas, d),
      )
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
    this.arrowDraper = new RetainedArrowDraper(rhi, format, 1, pointUniformBytes())
    this.circleDraper = new RetainedCircleDraper(rhi, format, 1, pointUniformBytes())
    this.particleDraper = new RetainedParticleDraper(rhi, format, 1, pointUniformBytes())
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
    this.arrowDraper = null
    this.circleDraper = null
    this.particleDraper = null
    this.frameBlock = null
    this._blockView = null
  }
}
