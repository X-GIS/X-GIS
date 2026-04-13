// ═══ Shared WebGPU Constants & Helpers ═══
// Extracted from repeated patterns across MapRenderer, RasterRenderer,
// PointRenderer, and VectorTileRenderer. Avoids configuration drift.

// ── Blend States ──

/** Standard alpha blending — used by all renderers */
export const BLEND_ALPHA: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
}

// ── Stencil States ──

/** Stencil write: mark tile areas (compare=always, passOp=replace, mask=0xFF) */
export const STENCIL_WRITE: GPUDepthStencilState = {
  format: 'stencil8',
  stencilFront: { compare: 'always', passOp: 'replace' },
  stencilBack: { compare: 'always', passOp: 'replace' },
  stencilWriteMask: 0xFF,
  stencilReadMask: 0xFF,
}

/** Stencil test: only draw where stencil=0 (fallback tiles, not covered by children) */
export const STENCIL_TEST: GPUDepthStencilState = {
  format: 'stencil8',
  stencilFront: { compare: 'equal', passOp: 'keep' },
  stencilBack: { compare: 'equal', passOp: 'keep' },
  stencilWriteMask: 0x00,
  stencilReadMask: 0xFF,
}

/** Stencil disabled: always pass, no write (raster tiles, SDF points) */
export const STENCIL_DISABLED: GPUDepthStencilState = {
  format: 'stencil8',
  stencilFront: { compare: 'always', passOp: 'keep' },
  stencilBack: { compare: 'always', passOp: 'keep' },
  stencilWriteMask: 0x00,
  stencilReadMask: 0x00,
}

// ── MSAA ──

export const MSAA_4X: GPUMultisampleState = { count: 4 }

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
