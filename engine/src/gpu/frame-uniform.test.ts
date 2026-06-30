import { describe, it, expect, vi, beforeAll } from 'vitest'

beforeAll(() => {
  if (typeof globalThis.GPUBufferUsage === 'undefined') {
    ;(globalThis as unknown as { GPUBufferUsage: Record<string, number> }).GPUBufferUsage = {
      MAP_READ: 0x0001, MAP_WRITE: 0x0002,
      COPY_SRC: 0x0004, COPY_DST: 0x0008,
      INDEX: 0x0010, VERTEX: 0x0020,
      UNIFORM: 0x0040, STORAGE: 0x0080,
      INDIRECT: 0x0100, QUERY_RESOLVE: 0x0200,
    }
  }
})

import { FrameUniform, FRAME_UNIFORM_SIZE_BYTES, WGSL_FRAME_UNIFORM } from './frame-uniform'

// Lightweight Camera stub matching `getFrameView`'s contract.
function fakeCamera(opts: { matrix?: Float32Array; logDepthFc?: number; zoom?: number } = {}): {
  zoom: number
  getFrameView(w: number, h: number, dpr: number): { matrix: Float32Array; far: number; logDepthFc: number }
} {
  const matrix = opts.matrix ?? new Float32Array(16).fill(0).map((_, i) => i + 1)
  const logDepthFc = opts.logDepthFc ?? 0.5
  return {
    zoom: opts.zoom ?? 0,
    getFrameView: () => ({ matrix, far: 1e7, logDepthFc }),
  }
}

function fakeDevice(): { device: GPUDevice; writes: { offset: number; bytes: Uint8Array }[] } {
  const writes: { offset: number; bytes: Uint8Array }[] = []
  const buffer = { destroy: vi.fn() } as unknown as GPUBuffer
  const device = {
    createBuffer: vi.fn(() => buffer),
    queue: {
      writeBuffer: vi.fn((_buf: GPUBuffer, offset: number, src: ArrayBuffer, srcOffset: number, size: number) => {
        const slice = new Uint8Array(src, srcOffset, size)
        writes.push({ offset, bytes: new Uint8Array(slice) })
      }),
    },
  } as unknown as GPUDevice
  return { device, writes }
}

describe('FrameUniform', () => {
  it('writes mvp + projection + viewport once per frame', () => {
    const { device, writes } = fakeDevice()
    const fu = new FrameUniform(device)
    const cam = fakeCamera({ zoom: 4 })
    fu.setFrame(1, cam as never, 1, 127.5, 36.5, 800, 600, 2)
    expect(writes).toHaveLength(1)
    expect(writes[0]!.offset).toBe(0)
    expect(writes[0]!.bytes.byteLength).toBe(FRAME_UNIFORM_SIZE_BYTES)
    const f32 = new Float32Array(writes[0]!.bytes.buffer, writes[0]!.bytes.byteOffset, FRAME_UNIFORM_SIZE_BYTES / 4)
    // MVP at offset 0..15
    for (let i = 0; i < 16; i++) expect(f32[i]).toBeCloseTo(i + 1)
    // proj_params: type, centerLon, centerLat, logDepthFc
    expect(f32[16]).toBe(1)
    expect(f32[17]).toBeCloseTo(127.5)
    expect(f32[18]).toBeCloseTo(36.5)
    expect(f32[19]).toBeCloseTo(0.5)
    // viewport: w, h, mpp, dpr
    expect(f32[20]).toBe(800)
    expect(f32[21]).toBe(600)
    expect(f32[22]).toBeGreaterThan(0)  // metersPerPixel(4) > 0
    expect(f32[23]).toBe(2)
  })

  it('deduplicates writes within the same frameTag', () => {
    const { device, writes } = fakeDevice()
    const fu = new FrameUniform(device)
    const cam = fakeCamera()
    fu.setFrame(42, cam as never, 0, 0, 0, 800, 600, 1)
    fu.setFrame(42, cam as never, 0, 0, 0, 800, 600, 1)
    fu.setFrame(42, cam as never, 0, 0, 0, 800, 600, 1)
    expect(writes).toHaveLength(1)
  })

  it('re-writes when frameTag advances', () => {
    const { device, writes } = fakeDevice()
    const fu = new FrameUniform(device)
    const cam = fakeCamera()
    fu.setFrame(1, cam as never, 0, 0, 0, 800, 600, 1)
    fu.setFrame(2, cam as never, 0, 0, 0, 800, 600, 1)
    expect(writes).toHaveLength(2)
  })

  it('exports a WGSL struct declaration for shader consumers', () => {
    expect(WGSL_FRAME_UNIFORM).toContain('struct FrameUniform')
    expect(WGSL_FRAME_UNIFORM).toContain('mvp: mat4x4<f32>')
    expect(WGSL_FRAME_UNIFORM).toContain('proj_params: vec4<f32>')
    expect(WGSL_FRAME_UNIFORM).toContain('viewport: vec4<f32>')
  })

  it('meters-per-pixel scales by 2^zoom', () => {
    const { device, writes } = fakeDevice()
    const fu = new FrameUniform(device)
    fu.setFrame(1, fakeCamera({ zoom: 0 }) as never, 0, 0, 0, 800, 600, 1)
    fu.setFrame(2, fakeCamera({ zoom: 1 }) as never, 0, 0, 0, 800, 600, 1)
    const mpp0 = new Float32Array(writes[0]!.bytes.buffer, writes[0]!.bytes.byteOffset + 88, 1)[0]!
    const mpp1 = new Float32Array(writes[1]!.bytes.buffer, writes[1]!.bytes.byteOffset + 88, 1)[0]!
    expect(mpp0 / mpp1).toBeCloseTo(2, 2)
  })
})
