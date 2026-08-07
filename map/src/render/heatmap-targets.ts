// ═══════════════════════════════════════════════════════════════════
// Heatmap density render targets (data-viz target schema)
// ═══════════════════════════════════════════════════════════════════
//
// The DATA-VIZ ownership half of the heatmap render-target lifecycle (#1000,
// relocated from @xgis/rhi-webgpu). @xgis/map is the content layer, so it owns
// what a heatmap density buffer IS — the accum + blur target pair, their
// r16float format, and the ensure-on-canvas-size / destroy lifecycle:
//
//   - accum : r16float density-accumulation target (additive Gaussian splats)
//   - blur  : r16float ping-pong target for the separable Gaussian
//
// One RHI target set (#1046 F3b Inc-2c): HeatmapRenderer.renderChainRhi
// allocates through the neutral `RhiDevice` texture primitives — the backend
// never learns what a heatmap is. (The former parallel NATIVE
// createRenderTarget pair retired with the native heatmap-pass body; this file
// no longer touches @xgis/rhi-webgpu. A forced-WebGL2 twin frame used to share
// this same target set through a second entry point that #1046 Inc-F3b deleted.)

import type { RhiDevice, RhiTexture, RhiTextureView } from '@xgis/engine'

/** Heatmap density-accumulation target format — single 16-bit float so the
 *  additive sum of overlapping Gaussian splats can grow well past 1 without
 *  saturating (the compose pass normalises by `heatmap-intensity`). Both the
 *  accum target and the blur ping-pong target use this format. Data-viz
 *  content, so it lives in the content layer (was gpu-shared.ts's until
 *  #1000). An opaque string literal — content never names a native format
 *  type (raw-WebGPU ratchet), mirroring palette-textures.ts. */
const HEATMAP_DENSITY_FORMAT = 'r16float' as const

/** Owns the two heatmap density targets (accum + blur) + their recreate-on-
 *  resize lifecycle. Lazily allocated by `ensureRhi()` ONLY when a heatmap
 *  layer is present, so a style with no heatmap allocates nothing
 *  (byte-identical default path). The heatmap render paths read the views;
 *  the map's destroy path calls `destroy()`. */
export class HeatmapTargets {
  private accumRhi: RhiTexture | null = null
  private blurRhi: RhiTexture | null = null
  private accumViewRhiV: RhiTextureView | null = null
  private blurViewRhiV: RhiTextureView | null = null
  /** Size the density targets were last allocated at (recreate gate). */
  private widthRhi = 0
  private heightRhi = 0
  /** The device the currently-cached targets were allocated on (`null` until
   *  the first `ensureRhi`). A `map.run()` re-entry destroys the old device +
   *  acquires a new one at the same canvas size, so the size-keyed gate below
   *  would hand a render pass a texture owned by the DESTROYED device (#737).
   *  Keying on the device makes this self-heal: on a new device, drop the
   *  cached targets (already freed with the destroyed device — null, don't
   *  destroy) + zero the size tracker so the next `ensureRhi` reallocates. */
  private deviceRhi: RhiDevice | null = null

  /** Default view of the RHI accum target (null until `ensureRhi`). */
  get accumViewRhi(): RhiTextureView | null {
    return this.accumViewRhiV
  }
  /** Default view of the RHI blur target (null until `ensureRhi`). */
  get blurViewRhi(): RhiTextureView | null {
    return this.blurViewRhiV
  }

  /** Lazily (re)allocate the r16float accum + blur density targets on the
   *  given RHI device at canvas size. No-op when unchanged; recreates on
   *  resize or device swap (self-heal above). `usage: render|sample` so the
   *  accum pass draws into it and the blur/compose passes texelFetch it. */
  ensureRhi(device: RhiDevice, w: number, h: number): void {
    if (device !== this.deviceRhi) {
      this.deviceRhi = device
      this.accumRhi = null
      this.blurRhi = null
      this.accumViewRhiV = null
      this.blurViewRhiV = null
      this.widthRhi = 0
      this.heightRhi = 0
    }
    if (this.accumRhi && this.widthRhi === w && this.heightRhi === h) return
    if (this.accumRhi) device.destroyTexture(this.accumRhi)
    if (this.blurRhi) device.destroyTexture(this.blurRhi)
    this.accumRhi = device.createTexture({
      width: w,
      height: h,
      format: HEATMAP_DENSITY_FORMAT,
      usage: ['render', 'sample'],
      label: 'heatmap-accum-rhi',
    })
    this.blurRhi = device.createTexture({
      width: w,
      height: h,
      format: HEATMAP_DENSITY_FORMAT,
      usage: ['render', 'sample'],
      label: 'heatmap-blur-rhi',
    })
    this.accumViewRhiV = device.createView(this.accumRhi)
    this.blurViewRhiV = device.createView(this.blurRhi)
    this.widthRhi = w
    this.heightRhi = h
  }

  /** Release the density targets (destroy + null). Called from the map's
   *  destroy() / re-init path. Safe to call when nothing was allocated. */
  destroy(): void {
    if (this.deviceRhi && this.accumRhi) this.deviceRhi.destroyTexture(this.accumRhi)
    if (this.deviceRhi && this.blurRhi) this.deviceRhi.destroyTexture(this.blurRhi)
    this.accumRhi = null
    this.blurRhi = null
    this.accumViewRhiV = null
    this.blurViewRhiV = null
    this.widthRhi = 0
    this.heightRhi = 0
  }
}
