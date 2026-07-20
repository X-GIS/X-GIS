// ═══════════════════════════════════════════════════════════════════
// Heatmap density render targets (data-viz target schema)
// ═══════════════════════════════════════════════════════════════════
//
// The DATA-VIZ ownership half of the heatmap render-target lifecycle (#1000,
// relocated from @xgis/rhi-webgpu). @xgis/map is the content layer, so it owns
// what a heatmap density buffer IS — the accum + blur target pair, their format
// (HEATMAP_DENSITY_FORMAT), and the ensure-on-canvas-size / destroy lifecycle:
//
//   - accum : r16float density-accumulation target (additive Gaussian splats)
//   - blur  : r16float ping-pong target for the separable Gaussian
//
// It DRIVES the backend's generic `createRenderTarget` / `destroyRenderTarget`
// primitive with a size + format; the backend adapter never learns what a
// heatmap is. Byte-identical to the former `RenderTargets.ensureHeatmap` /
// `destroyHeatmap`: same two r16float single-sample RENDER_ATTACHMENT |
// TEXTURE_BINDING targets, same 'heatmap-accum' / 'heatmap-blur' labels, same
// resize gate + device-identity self-heal. Mirrors the palette relocation's
// render/palette-textures.ts split.

import {
  createRenderTarget,
  destroyRenderTarget,
  type RenderTarget,
  type RenderTargetDevice,
  type RenderTargetView,
} from '@xgis/rhi-webgpu'
import type { RhiDevice, RhiTexture, RhiTextureView } from '@xgis/engine'

/** Heatmap density-accumulation target format — single 16-bit float so the
 *  additive sum of overlapping Gaussian splats can grow well past 1 without
 *  saturating (the compose pass normalises by `heatmap-intensity`). Both the
 *  accum target and the blur ping-pong target use this format. Data-viz content,
 *  so it lives in the content layer (was gpu-shared.ts's until #1000).
 *
 *  Typed via `as const` (the literal `'r16float'`, structurally a valid
 *  `GPUTextureFormat`) rather than an explicit `: GPUTextureFormat` annotation:
 *  naming the native WebGPU type in @xgis/map would trip the raw-WebGPU ratchet
 *  — content routes formats as opaque strings, mirroring palette-textures.ts. */
export const HEATMAP_DENSITY_FORMAT = 'r16float' as const

/** Owns the two heatmap density targets (accum + blur) + their recreate-on-
 *  resize lifecycle. Lazily allocated by `ensure()` ONLY when a heatmap layer is
 *  present, so a style with no heatmap allocates nothing (byte-identical default
 *  path). The heatmap pass reads the views; the map's destroy path calls
 *  `destroy()`. Single owner, mirroring the backend's former RenderTargets
 *  heatmap block one-to-one. */
export class HeatmapTargets {
  private accum: RenderTarget | null = null
  private blur: RenderTarget | null = null
  /** Size the density targets were last allocated at (recreate gate). */
  private width = 0
  private height = 0
  /** The device the currently-cached targets were allocated on (`null` until the
   *  first `ensure`). A `map.run()` re-entry destroys the old device + acquires a
   *  new one at the same canvas size, so the size-keyed gate below would hand a
   *  render pass a texture owned by the DESTROYED device (#737). Keying on the
   *  device makes this self-heal: on a new device, drop the cached targets (they
   *  are already freed with the destroyed device — null, don't destroy) + zero
   *  the size tracker so the next `ensure` reallocates fresh. */
  private device: RenderTargetDevice | null = null

  /** Default view of the accum target (null until `ensure`). */
  get accumView(): RenderTargetView | null {
    return this.accum?.view ?? null
  }
  /** Default view of the blur target (null until `ensure`). */
  get blurView(): RenderTargetView | null {
    return this.blur?.view ?? null
  }

  /** Lazily (re)allocate the accum + blur density targets at canvas size.
   *  No-op when unchanged; never allocates in the default no-heatmap path (the
   *  pass gates on `scene.hasHeatmap` before calling). Recreates on resize or
   *  device swap. Byte-identical to the former `RenderTargets.ensureHeatmap`. */
  ensure(device: RenderTargetDevice, w: number, h: number): void {
    if (device !== this.device) {
      // New device — the old targets are freed with the destroyed device; null
      // (don't destroy) so the recreate below allocates fresh on the live device.
      this.device = device
      this.accum = null
      this.blur = null
      this.width = 0
      this.height = 0
    }
    if (this.accum && this.width === w && this.height === h) return
    if (this.accum) destroyRenderTarget(this.accum)
    if (this.blur) destroyRenderTarget(this.blur)
    this.accum = createRenderTarget(device, {
      width: w,
      height: h,
      format: HEATMAP_DENSITY_FORMAT,
      label: 'heatmap-accum',
    })
    this.blur = createRenderTarget(device, {
      width: w,
      height: h,
      format: HEATMAP_DENSITY_FORMAT,
      label: 'heatmap-blur',
    })
    this.width = w
    this.height = h
  }

  // ── Forced-WebGL2 twin targets (#1060) ──
  // The native createRenderTarget path above threads a GPUDevice (WebGPU only);
  // the twin frame (renderFrameViaRhi) has no native device, so the same two
  // r16float render+sample targets re-originate through the RHI seam. Kept as a
  // parallel set (not a union) so the WebGPU path stays byte-identical.
  private accumRhi: RhiTexture | null = null
  private blurRhi: RhiTexture | null = null
  private accumViewRhiV: RhiTextureView | null = null
  private blurViewRhiV: RhiTextureView | null = null
  private widthRhi = 0
  private heightRhi = 0
  private deviceRhi: RhiDevice | null = null

  /** Default view of the RHI accum target (null until `ensureRhi`). */
  get accumViewRhi(): RhiTextureView | null {
    return this.accumViewRhiV
  }
  /** Default view of the RHI blur target (null until `ensureRhi`). */
  get blurViewRhi(): RhiTextureView | null {
    return this.blurViewRhiV
  }

  /** RHI twin of `ensure`: lazily (re)allocate the r16float accum + blur density
   *  targets on the given RHI device at canvas size. Same resize + device-swap
   *  self-heal discipline. `usage: render|sample` so the accum pass draws into
   *  it and the blur/compose passes texelFetch it. */
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
    if (this.accum) destroyRenderTarget(this.accum)
    if (this.blur) destroyRenderTarget(this.blur)
    this.accum = null
    this.blur = null
    this.width = 0
    this.height = 0
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
