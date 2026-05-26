// Earth-surface fill pre-pass.
//
// Replaces the prior tile-based / quad-mesh implementations after they
// kept colliding with the depth+stencil bookkeeping (background and
// the first user layer z-fighting under log-depth at high pitch).
// This renderer:
//
//   • Draws ONE clip-space fullscreen quad in the SAME render pass as
//     the rest of the opaque content, but FIRST — before raster, before
//     MapRenderer.renderToPass, before any vector-tile show.
//   • Uses depthCompare='always' + depthWriteEnabled=false so it neither
//     blocks nor influences the depth buffer. Subsequent draws behave
//     exactly as if the canvas had been cleared to bgFillRgba.
//   • Uses stencilCompare='always' + writeMask=0 so it doesn't poison
//     the stencil that primary tile draws rely on.
//
// Trade-off: in non-Mercator projections this paints "space" outside
// the globe with the bg color. Mapbox's globe renderer handles this
// with a sphere proxy, but for the projections currently shipped
// (Mercator + the 2D variants we support today) the projected earth
// surface fills the viewport and the quad result is visually identical
// to a clearValue. Globe-style projections can layer their own sphere
// proxy on top of this when added.
//
// Depth/stencil format is hard-coded to 'depth24plus-stencil8' to
// match the rest of the pipeline (gpu-shared.STENCIL_WRITE/TEST).

import type { GPUContext } from '../gpu/gpu'
import { isPickEnabled, getSampleCount } from '../gpu/gpu'
import { xlog } from '../log'
import {
  DEBUG_OVERDRAW,
  OVERDRAW_ACCUM_FORMAT,
  OVERDRAW_FS_SOURCE,
  OVERDRAW_BLEND_STATE,
  OVERDRAW_DEPTH_STENCIL,
} from '../debug-flags'
import { BundleCache } from './bundle-cache'
import { emitBgWgsl } from '../shader-dsl'

// The bg shader (world-extent quad + MVP + style fill colour) is now EMITTED
// from the shader DSL: shader-dsl/background.ts. The former __PICK_*__ marker
// variant is conditional DSL emission via emitBgWgsl(pickEnabled). buildPipeline
// + buildPipelineOverdraw below call it.

export class BackgroundRenderer {
  private device: GPUDevice
  private bgPipeline: GPURenderPipeline | null = null
  /** Debug-overdraw variant — same VS, FS replaced with constant
   *  output (`fs_overdraw`), color target swapped to r16float
   *  additive. Lazy-built on first render when DEBUG_OVERDRAW is on. */
  private bgPipelineOverdraw: GPURenderPipeline | null = null
  private bgUniformBuffer: GPUBuffer
  private bgBindGroup: GPUBindGroup | null = null
  private bgBindGroupLayout: GPUBindGroupLayout
  private fillRgba: [number, number, number, number] | null = null
  private uploadedRgba: [number, number, number, number] = [0, 0, 0, 0]
  private format: GPUTextureFormat
  // iter-196 — uniform layout grew to mat4(64) + vec2 cam_center(8) +
  // pad(8) + vec4 color(16) = 96 bytes. setMvp + setCamCenter populate
  // the matrix/cam slots per frame; setFill writes the colour slot.
  private uniformData = new Float32Array(24)
  private mvpDirty = true
  private camCenterDirty = true

  /** iter-213 (Phase RB.B sub-step) — caches the encoded
   *  GPURenderBundle for the bg's single draw. The bundle records
   *  [setPipeline, setBindGroup, draw(6)] once; subsequent frames
   *  reduce to one `executeBundles([bundle])` call. Uniform DATA
   *  (mvp / cam_center / color) still updates via `writeBuffer` —
   *  the bundle records the bind group REF, not the buffer bytes,
   *  so writes flow through. */
  private bundleCache: BundleCache

  constructor(ctx: GPUContext) {
    this.device = ctx.device
    this.format = ctx.format
    this.bundleCache = new BundleCache(ctx.device)
    // iter-196 — uniform binding moved to VERTEX | FRAGMENT visibility
    // because the world-extent vertex stage now reads mvp + cam_center.
    this.bgBindGroupLayout = this.device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
      label: 'bg-bgl',
    })
    this.bgUniformBuffer = this.device.createBuffer({
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'bg-uniform',
    })
    this.bgBindGroup = this.device.createBindGroup({
      layout: this.bgBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.bgUniformBuffer } }],
      label: 'bg-bg',
    })
  }

  /** Set the earth-surface fill color. Pass null to disable rendering
   *  (canvas clearValue then dominates). Caller writes
   *  `[r, g, b, a]` in 0..1 floats. */
  setFill(rgba: [number, number, number, number] | null): void {
    if (rgba === null) { this.fillRgba = null; return }
    // Defensive: reject non-array, wrong-length, or non-finite channel.
    // Pre-fix a NaN channel propagated to the WebGPU clear-value and
    // some drivers produced undefined behaviour (transparent black on
    // M1, opaque black on NV, magenta on AMD). Mirror of palette.ts
    // addColor channel sanitisation.
    if (!Array.isArray(rgba) || rgba.length !== 4
        || !Number.isFinite(rgba[0]) || !Number.isFinite(rgba[1])
        || !Number.isFinite(rgba[2]) || !Number.isFinite(rgba[3])) {
      xlog.warn(`[X-GIS] BackgroundRenderer.setFill: rejected non-finite RGBA ${JSON.stringify(rgba)}`)
      return
    }
    this.fillRgba = rgba
  }

  hasFill(): boolean {
    return this.fillRgba !== null
  }

  /** Lazy build — pipeline depends on isPickEnabled / getSampleCount,
   *  which can flip at runtime via setQuality. Call rebuild() when
   *  those change. */
  private buildPipeline(): GPURenderPipeline {
    const pickEnabled = isPickEnabled()
    const code = emitBgWgsl(pickEnabled)
    const module = this.device.createShaderModule({ code, label: 'bg-shader' })
    return this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.bgBindGroupLayout],
        label: 'bg-pl',
      }),
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module, entryPoint: 'fs',
        // No alpha blend — opaque fill, replaces the existing color
        // attachment contents. This is intentional: bg is the first
        // draw in the opaque pass; nothing should be UNDER it.
        targets: pickEnabled
          ? [{ format: this.format }, { format: 'rg32uint' as GPUTextureFormat, writeMask: 0 }]
          : [{ format: this.format }],
      },
      primitive: { topology: 'triangle-list' },
      // depth-test ALWAYS + write OFF: never block, never claim depth.
      // Subsequent draws compare against the cleared depth (1.0) as if
      // bg had never run.
      // stencil ALWAYS / writeMask 0: don't disturb the stencil bookkeeping
      // primary/fallback paths rely on.
      depthStencil: {
        format: 'depth24plus-stencil8',
        depthCompare: 'always',
        depthWriteEnabled: false,
        stencilFront: { compare: 'always', passOp: 'keep' },
        stencilBack: { compare: 'always', passOp: 'keep' },
        stencilWriteMask: 0x00,
        stencilReadMask: 0x00,
      },
      multisample: { count: getSampleCount() },
      label: 'bg-pipeline',
    })
  }

  /** Debug-overdraw pipeline — additive accumulation into the
   *  r16float overdraw RT. Shares the same VS as the main pipeline
   *  (a fullscreen quad needs no projection), so the only differences
   *  are the FS entry point, the color target format/blend, and the
   *  depth-stencil state (always-pass, no writes — counts SUBMITTED
   *  overdraw to match the MapLibre debug convention). */
  private buildPipelineOverdraw(): GPURenderPipeline {
    // Reuse the same vertex shader; replace FS by appending the
    // shared overdraw FS. The BG shader's fs_main entry stays alive
    // but is unused in this pipeline.
    const code = emitBgWgsl(false) + OVERDRAW_FS_SOURCE
    const module = this.device.createShaderModule({ code, label: 'bg-overdraw-shader' })
    return this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.bgBindGroupLayout],
        label: 'bg-overdraw-pl',
      }),
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module, entryPoint: 'fs_overdraw',
        targets: [{ format: OVERDRAW_ACCUM_FORMAT, blend: OVERDRAW_BLEND_STATE }],
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: OVERDRAW_DEPTH_STENCIL,
      multisample: { count: 1 },
      label: 'bg-overdraw-pipeline',
    })
  }

  /** iter-222 — BundleCache stats accessor for the map-level stats
   *  panel. Returns lifetime hits/misses across this renderer's
   *  cached bundle variants (main / overdraw / pick combinations).
   *  iter-228 widens to also report LRU evictions so the global
   *  panel can surface cap pressure. */
  getBundleStats(): { hits: number; misses: number; evictions: number } {
    const s = this.bundleCache.getStats()
    return { hits: s.hits, misses: s.misses, evictions: s.evictions }
  }

  /** Rebuild pipeline (call from setQuality reroll). */
  rebuildForQuality(): void {
    this.bgPipeline = null
    this.bgPipelineOverdraw = null
    // iter-213 — pipeline rebuild invalidates the bundle cache;
    // bundles record pipeline references that just became stale.
    this.bundleCache.invalidateAll()
  }

  render(pass: GPURenderPassEncoder): void {
    if (!this.fillRgba) return
    // iter-196 — uniform write covers mat4 (offset 0..63) + cam_center
    // (64..71) + pad (72..79) + color (80..95). mvpDirty +
    // camCenterDirty + per-channel colour diff gate the writeBuffer
    // so a stationary camera doesn't touch the uniform every frame.
    // iter-213 — uniform updates stay OUTSIDE the bundle. Bundle
    // records the bind group ref, not buffer bytes; writeBuffer
    // through the same bind group reaches the GPU on the next draw.
    if (!DEBUG_OVERDRAW) {
      const colorChanged = this.fillRgba[0] !== this.uploadedRgba[0]
        || this.fillRgba[1] !== this.uploadedRgba[1]
        || this.fillRgba[2] !== this.uploadedRgba[2]
        || this.fillRgba[3] !== this.uploadedRgba[3]
      if (colorChanged) {
        this.uniformData[20] = this.fillRgba[0]
        this.uniformData[21] = this.fillRgba[1]
        this.uniformData[22] = this.fillRgba[2]
        this.uniformData[23] = this.fillRgba[3]
        this.uploadedRgba[0] = this.fillRgba[0]
        this.uploadedRgba[1] = this.fillRgba[1]
        this.uploadedRgba[2] = this.fillRgba[2]
        this.uploadedRgba[3] = this.fillRgba[3]
      }
      if (this.mvpDirty || this.camCenterDirty || colorChanged) {
        this.device.queue.writeBuffer(this.bgUniformBuffer, 0, this.uniformData)
        this.mvpDirty = false
        this.camCenterDirty = false
      }
    }

    // iter-213 (Phase RB.B) — encode the bg's [setPipeline,
    // setBindGroup, draw(6)] into a cached GPURenderBundle. The cache
    // key captures every variant that affects the bundle's recorded
    // commands or descriptor:
    //   - DEBUG_OVERDRAW flag (different pipeline + color format)
    //   - isPickEnabled flag (additional rg32uint color attachment)
    //   - sampleCount (MSAA changes pipeline + bundle attachment)
    // rebuildForQuality() invalidates the entire cache via
    // bundleCache.invalidateAll so a quality flip cleanly re-encodes.
    const pickOn = isPickEnabled()
    const overdraw = DEBUG_OVERDRAW
    const samples = getSampleCount()
    const key = `bg-${overdraw ? 'od' : 'main'}-${pickOn ? 'pick' : 'no'}-msaa${samples}`
    const colorFormats: (GPUTextureFormat | null)[] = overdraw
      ? [OVERDRAW_ACCUM_FORMAT]
      : pickOn
        ? [this.format, 'rg32uint']
        : [this.format]
    const bundle = this.bundleCache.getOrEncode(key, {
      colorFormats,
      depthStencilFormat: 'depth24plus-stencil8',
      sampleCount: samples,
      // The bg's owning pass (map.ts:3455 subPass) writes depth +
      // stencil from subsequent tile draws → bundle must declare
      // both writeable.
      depthReadOnly: false,
      stencilReadOnly: false,
      label: key,
    }, encoder => {
      if (overdraw) {
        if (!this.bgPipelineOverdraw) this.bgPipelineOverdraw = this.buildPipelineOverdraw()
        encoder.setPipeline(this.bgPipelineOverdraw)
      } else {
        if (!this.bgPipeline) this.bgPipeline = this.buildPipeline()
        encoder.setPipeline(this.bgPipeline)
      }
      encoder.setBindGroup(0, this.bgBindGroup!)
      encoder.draw(6)
    })
    pass.executeBundles([bundle])
  }

  /** iter-196 — push the camera MVP matrix into the bg uniform.
   *  Caller (map.ts renderFrame) sets per frame, before render(). */
  setMvp(mvp: ArrayLike<number>): void {
    for (let i = 0; i < 16; i++) this.uniformData[i] = mvp[i] as number
    this.mvpDirty = true
  }

  /** iter-196 — push camera centre (Mercator metres) into the bg
   *  uniform. World-extent vertices subtract this to get RTC coords
   *  before applying the MVP. */
  setCamCenter(x: number, y: number): void {
    this.uniformData[16] = x
    this.uniformData[17] = y
    this.uniformData[18] = 0  // pad
    this.uniformData[19] = 0
    this.camCenterDirty = true
  }
}
