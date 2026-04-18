// ═══ Shared WebGPU Constants & Helpers ═══
// Extracted from repeated patterns across MapRenderer, RasterRenderer,
// PointRenderer, and VectorTileRenderer. Avoids configuration drift.

// ── Blend States ──

/** Standard alpha blending — used by all renderers whose fragment
 *  shader emits NON-premultiplied (rgb, a). The blend factor multiplies
 *  rgb by a at write time. */
export const BLEND_ALPHA: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
}

/** Premultiplied alpha blending — for fragment shaders that already emit
 *  (rgb*a, a). Using BLEND_ALPHA on premultiplied output multiplies rgb
 *  by alpha a SECOND time, which silently darkens the result. */
export const BLEND_ALPHA_PREMULT: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
}

/** Max blending — keeps the maximum of src and dst per channel. Used by the
 *  translucent line offscreen pipeline so overlapping segments of a single
 *  layer don't accumulate alpha at corners / self-intersections. The
 *  composite pass then blends the offscreen onto the main target with
 *  per-layer opacity. */
export const BLEND_MAX: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
}

// ── Stencil States ──
//
// The polygon pipelines also write depth (`less-equal` test + write) so
// the opaque buffer carries meaningful depth values into the later
// points pass. Without it the depth buffer stayed at the initial clear
// (1.0) and point markers on the back side of a pitched / globe view
// drew through front-facing polygons that should occlude them. For the
// common top-down 2-D map every polygon is at z = 0, so `less-equal`
// still allows painter's order overwrite; the bug only manifests when
// the scene has real depth variation.

/** Stencil write: mark tile areas (compare=always, passOp=replace, mask=0xFF) */
export const STENCIL_WRITE: GPUDepthStencilState = {
  format: 'depth24plus-stencil8',
  depthCompare: 'less-equal',
  depthWriteEnabled: true,
  stencilFront: { compare: 'always', passOp: 'replace' },
  stencilBack: { compare: 'always', passOp: 'replace' },
  stencilWriteMask: 0xFF,
  stencilReadMask: 0xFF,
}

/** Stencil test: only draw where stencil=0 (fallback tiles, not covered by children) */
export const STENCIL_TEST: GPUDepthStencilState = {
  format: 'depth24plus-stencil8',
  depthCompare: 'less-equal',
  depthWriteEnabled: true,
  stencilFront: { compare: 'equal', passOp: 'keep' },
  stencilBack: { compare: 'equal', passOp: 'keep' },
  stencilWriteMask: 0x00,
  stencilReadMask: 0xFF,
}

/** Stencil disabled: always pass, no write (raster tiles, SDF line body) */
export const STENCIL_DISABLED: GPUDepthStencilState = {
  format: 'depth24plus-stencil8',
  depthCompare: 'always',
  depthWriteEnabled: false,
  stencilFront: { compare: 'always', passOp: 'keep' },
  stencilBack: { compare: 'always', passOp: 'keep' },
  stencilWriteMask: 0x00,
  stencilReadMask: 0x00,
}

/** Depth test + write, no stencil — point markers need occlusion when the
 *  camera is pitched so near points draw over far points regardless of the
 *  CPU-side feature order. `less-equal` lets same-depth fragments overwrite
 *  (preserves painter's order for top-down views where all z are equal). */
export const DEPTH_TEST_WRITE: GPUDepthStencilState = {
  format: 'depth24plus-stencil8',
  depthCompare: 'less-equal',
  depthWriteEnabled: true,
  stencilFront: { compare: 'always', passOp: 'keep' },
  stencilBack: { compare: 'always', passOp: 'keep' },
  stencilWriteMask: 0x00,
  stencilReadMask: 0x00,
}

// ── MSAA ──
// Sample count chosen at module load from `quality.ts` (default 4× desktop,
// 1× mobile / `?safe=1` / `?quality=performance|battery` / `?msaa=1|2`).
// Name `MSAA_4X` is historical — the actual count is whatever SAMPLE_COUNT
// resolves to. All render pipelines pick this up at creation; the 1×
// branch in `map.ts:renderFrame` handles the no-resolve direct-to-swapchain
// path.
import { SAMPLE_COUNT } from './gpu'
export const MSAA_STATE: GPUMultisampleState = { count: SAMPLE_COUNT }
/** @deprecated Use `MSAA_STATE` (count is no longer always 4). Alias kept
 *  for back-compat with existing imports. */
export const MSAA_4X = MSAA_STATE

// ── Buffer Helpers ──

/** Create a GPU buffer, write data, return the buffer */
export function uploadBuffer(
  device: GPUDevice,
  data: Float32Array | Uint32Array | Uint8Array,
  usage: GPUBufferUsageFlags,
  label?: string,
): GPUBuffer {
  const buf = device.createBuffer({
    size: Math.max(data.byteLength, 4),
    usage: usage | GPUBufferUsage.COPY_DST,
    label,
  })
  device.queue.writeBuffer(buf, 0, data)
  return buf
}

// ── World Wrapping ──

/** Earth circumference in Mercator meters */
export const WORLD_MERC = 40075016.686

/** World copy offsets: primary + N copies each side */
export const WORLD_COPIES = [-2, -1, 0, 1, 2]

/** Create an empty uniform buffer */
export function createUniformBuffer(device: GPUDevice, size: number, label?: string): GPUBuffer {
  return device.createBuffer({
    size,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    label,
  })
}
