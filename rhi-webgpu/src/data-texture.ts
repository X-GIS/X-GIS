// ═══════════════════════════════════════════════════════════════════
// Generic 2D data-texture upload (create + write packed texels)
// ═══════════════════════════════════════════════════════════════════
//
// Content-blind backend primitive: the WebGPU adapter knows how to put N
// bytes into a GPU texture of a given size/format — it does NOT know what a
// palette, a colour gradient, or a heatmap IS. The data-viz palette SCHEMA
// (which textures exist, their formats, GRADIENT_WIDTH, the per-gradient
// atlas-row layout) is style-domain content and lives in @xgis/map
// (render/palette-textures.ts, #1000). This module is the neutral half the
// former palette-texture.ts upload path left behind: the palette knowledge
// relocated UP to the content layer, and a backend that only speaks generic
// GPU vocabulary (texture, format, bytesPerRow) stays behind.
//
// The PURE packing half (PackedPalette / GRADIENT_WIDTH / packPalette) is
// itself style-domain math and lives one layer further up, in @xgis/compiler.

/** Opaque GPU-texture handle for the content layer. Aliased so @xgis/map can
 *  hold the created textures without naming raw WebGPU (mirroring the RHI's
 *  opaque `Rhi*` handles). The palette bind path still reads the native view
 *  off it via `.createView()` until that path routes through the RHI. */
export type DataTexture = GPUTexture

/** Opaque device handle the content layer threads into the upload calls —
 *  same rationale as {@link DataTexture}: content code names this, not `GPUDevice`. */
export type DataTextureDevice = GPUDevice

export interface DataTextureDesc {
  width: number
  height: number
  format: GPUTextureFormat
  label: string
}

/** Create a 2D sampled + copy-dst texture. Extents are floored to ≥1 (WebGPU
 *  rejects a zero-size texture) so an empty pool still yields a bindable 1×1
 *  stub — the caller need not branch on emptiness. */
export function createDataTexture(device: DataTextureDevice, desc: DataTextureDesc): DataTexture {
  return device.createTexture({
    label: desc.label,
    size: { width: Math.max(desc.width, 1), height: Math.max(desc.height, 1) },
    format: desc.format,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
}

/** Write a `width`×`height` texel region (rows strided by `bytesPerRow`) into
 *  `texture` at its top-left origin. A thin wrapper over `queue.writeTexture`
 *  so the content layer never touches the native queue. */
export function writeDataTexture(
  device: DataTextureDevice,
  texture: DataTexture,
  data: BufferSource,
  bytesPerRow: number,
  width: number,
  height: number,
): void {
  device.queue.writeTexture({ texture }, data, { bytesPerRow }, { width, height })
}
