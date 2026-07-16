// ═══ Neutral render context (#834 map→engine) ═══
//
// The backend-neutral frame/boot context a consumer threads through its
// renderers: the injected RHI device plus host + per-frame metadata. It names
// NO native GPU type, so a package that depends on @xgis/engine alone stays
// backend-neutral by construction. A concrete backend handle extends it — e.g.
// @xgis/rhi-webgpu's `interface GPUContext extends RenderContext { device;
// context }`, so a real GPUContext is structurally a RenderContext.
//
// Lives in @xgis/engine, NOT @xgis/rhi: a "render HARDWARE interface" describes
// GPU resources (buffers, textures, pipelines, passes), not a host canvas or a
// per-frame render-loop state. Bundling those with a device is an engine
// composition concern, not a hardware one — so the context family (this type,
// RhiDeviceLostInfo, BackendChoice) belongs one layer up from the RHI.

import type { RhiDevice, RhiTextureFormat } from '@xgis/rhi'

/** Backend-neutral device-lost payload. A backend's native lost-info
 *  (WebGPU's `GPUDeviceLostInfo`, whose `reason` narrows `string`) is
 *  structurally assignable to this, so the boot forwards it unchanged. */
export interface RhiDeviceLostInfo {
  readonly reason: string
  readonly message: string
}

/** The GPU backend a renderer runs on. `'auto'` resolves to the platform
 *  default (WebGPU) unless a dev override forces WebGL2. Construction-immutable
 *  (a canvas's drawing-context type is sticky once acquired). Names the public
 *  backend-selection option a host exposes. */
export type BackendChoice = 'auto' | 'webgpu' | 'webgl2'

/** Backend-neutral render context — everything a renderer legitimately reads
 *  that is NOT a native GPU handle. `format` is the neutral swapchain format
 *  (always a member of {@link RhiTextureFormat}); `rhi` is the injected backend
 *  device; the rest is frame/host metadata + the device-lost signals. A concrete
 *  backend context extends this with its native device/surface objects. */
export interface RenderContext {
  format: RhiTextureFormat
  canvas: HTMLCanvasElement
  sampleCount: number
  /** The injected backend RHI device — the SINGLE instance every renderer
   *  routes resource creation through. */
  rhi: RhiDevice
  timestampQuerySupported: boolean
  timestampInsidePassesSupported: boolean
  float32FilterableSupported: boolean
  /** Validation error queue (a backend's uncaptured-error sink; empty/inert on
   *  backends without validation). Tests poll it; production ignores it. */
  _validationErrors: { message: string; t: number }[]
  /** Set once the device is lost; the render loop stops issuing GPU work. */
  deviceLost: boolean
  /** Host hook fired once on device loss. */
  onDeviceLost?: (info: RhiDeviceLostInfo) => void
  /** Library-internal device-loss hook — the composition root (map) registers its
   *  bounded auto-recovery here (a fresh run() through initGPU). Fired AFTER the
   *  public `onDeviceLost` hook and isolated from it (a throwing host hook must not
   *  kill recovery). Skipped on intentional teardown ('destroyed'). Not public. */
  onDeviceLostInternal?: (info: RhiDeviceLostInfo) => void
}
