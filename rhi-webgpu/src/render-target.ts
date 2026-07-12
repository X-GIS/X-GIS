// ═══════════════════════════════════════════════════════════════════
// Generic offscreen render-target primitive (create texture + view)
// ═══════════════════════════════════════════════════════════════════
//
// Content-blind backend primitive: the WebGPU adapter knows how to allocate a
// single-sample colour attachment of a given size/format that a pass can render
// into AND later sample (RENDER_ATTACHMENT | TEXTURE_BINDING) — it does NOT know
// what a heatmap density target, an OIT accumulator, or any data-viz buffer IS.
// The data-viz target SCHEMA (which targets exist, their format, the ensure/
// destroy lifecycle keyed on canvas size, HEATMAP_DENSITY_FORMAT) is style-domain
// content and lives in @xgis/map (render/heatmap-targets.ts, #1000). This module
// is the neutral half the heatmap render-target block left behind: the heatmap
// knowledge relocated UP to the content layer, and a backend that only speaks
// generic GPU vocabulary (texture, view, format) stays behind — mirroring the
// palette upload's data-texture.ts split.

/** Opaque GPU-texture handle for the content layer. Aliased so @xgis/map can
 *  hold the created target without naming raw WebGPU (mirroring the RHI's opaque
 *  `Rhi*` handles + data-texture.ts's `DataTexture`). */
export type RenderTargetTexture = GPUTexture

/** Opaque GPU-texture-view handle — the render/sample attachment the content
 *  layer binds, without naming `GPUTextureView`. */
export type RenderTargetView = GPUTextureView

/** Opaque device handle the content layer threads into `createRenderTarget` —
 *  same rationale as {@link RenderTargetTexture}: content names this, not `GPUDevice`. */
export type RenderTargetDevice = GPUDevice

export interface RenderTargetDesc {
  width: number
  height: number
  format: GPUTextureFormat
  label: string
}

/** A created offscreen render target: the texture + its default view, minted
 *  together so the content layer holds one view per texture (no per-frame
 *  `createView`) for the texture's lifetime. */
export interface RenderTarget {
  texture: RenderTargetTexture
  view: RenderTargetView
}

/** Create a single-sample RENDER_ATTACHMENT | TEXTURE_BINDING colour target at
 *  the given size/format + its default view. The two usages are the generic
 *  "a pass draws into it, a later pass samples it" offscreen-target shape. */
export function createRenderTarget(
  device: RenderTargetDevice,
  desc: RenderTargetDesc,
): RenderTarget {
  const texture = device.createTexture({
    label: desc.label,
    size: { width: desc.width, height: desc.height },
    format: desc.format,
    sampleCount: 1,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  })
  return { texture, view: texture.createView() }
}

/** Destroy a render target's backing texture. Safe on an already-destroyed
 *  texture (`.destroy()` is idempotent per the WebGPU spec). */
export function destroyRenderTarget(target: RenderTarget): void {
  target.texture.destroy()
}
