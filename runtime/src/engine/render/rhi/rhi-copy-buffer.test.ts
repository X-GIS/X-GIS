// ═══ RHI buffer-copy contract (§4 unit 4 — the GPUArena compaction primitive) ═══
//
// Pins the two additive surfaces the VTR/GPUArena cluster needs:
//   • RhiBufferDesc.copySrc → WebGPU ORs in GPUBufferUsage.COPY_SRC, and ONLY
//     then (a no-copySrc buffer's usage flags are byte-identical to before).
//   • RhiCommandEncoder.copyBufferToBuffer → WebGPU forwards 1:1 to the native
//     GPUCommandEncoder (unwrapping the buffers); WebGL2 binds COPY_READ/WRITE
//     and issues gl.copyBufferSubData (a real byte round-trip on a fake GL).

import { describe, it, expect, beforeAll } from 'vitest'
import { WebGpuDevice, wrapWebGpuBuffer } from './rhi-webgpu'
import { WebGl2Device } from './rhi-webgl2'

beforeAll(() => {
  // bufUsage reads the GPUBufferUsage globals (absent under node/vitest).
  const g = globalThis as { GPUBufferUsage?: unknown }
  g.GPUBufferUsage ??= {
    MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8,
    INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
  }
})

const U = () => globalThis.GPUBufferUsage

describe('RhiBufferDesc.copySrc — WebGPU usage-flag byte-identity', () => {
  function recordingDevice() {
    const descs: GPUBufferDescriptor[] = []
    const device = { createBuffer: (d: GPUBufferDescriptor) => { descs.push(d); return {} as GPUBuffer } } as unknown as GPUDevice
    return { dev: new WebGpuDevice(device), descs }
  }

  it('a NO-copySrc buffer emits exactly the prior base|COPY_DST flags (no COPY_SRC)', () => {
    const { dev, descs } = recordingDevice()
    dev.createBuffer({ size: 64, usage: 'vertex', writable: true })
    dev.createBuffer({ size: 64, usage: 'index', writable: true })
    expect(descs[0].usage).toBe(U().VERTEX | U().COPY_DST)
    expect(descs[1].usage).toBe(U().INDEX | U().COPY_DST)
    // COPY_SRC bit must be absent — the byte-identity guarantee.
    expect(descs[0].usage & U().COPY_SRC).toBe(0)
  })

  it('copySrc:true ORs in COPY_SRC (the arena vertex/index VERTEX|COPY_DST|COPY_SRC)', () => {
    const { dev, descs } = recordingDevice()
    dev.createBuffer({ size: 64, usage: 'vertex', writable: true, copySrc: true })
    dev.createBuffer({ size: 64, usage: 'index', writable: true, copySrc: true })
    expect(descs[0].usage).toBe(U().VERTEX | U().COPY_DST | U().COPY_SRC)
    expect(descs[1].usage).toBe(U().INDEX | U().COPY_DST | U().COPY_SRC)
  })
})

describe('WebGpuCommandEncoder.copyBufferToBuffer — unwrap + 1:1 forward', () => {
  it('forwards the unwrapped native GPUBuffers + offsets/size to the raw encoder', () => {
    const calls: unknown[][] = []
    const rawEnc = { copyBufferToBuffer: (...a: unknown[]) => { calls.push(a) }, finish: () => ({}) }
    const submitted: unknown[] = []
    const device = {
      createCommandEncoder: () => rawEnc,
      queue: { submit: (b: unknown) => { submitted.push(b) } },
    } as unknown as GPUDevice
    const dev = new WebGpuDevice(device)

    const srcGpu = { __id: 'src' } as unknown as GPUBuffer
    const dstGpu = { __id: 'dst' } as unknown as GPUBuffer
    const enc = dev.createCommandEncoder('arena-compact-grow')
    enc.copyBufferToBuffer(wrapWebGpuBuffer(srcGpu), 4, wrapWebGpuBuffer(dstGpu), 8, 16)
    enc.finish()

    // Byte-identical to the raw `enc.copyBufferToBuffer(srcGpu, 4, dstGpu, 8, 16)`.
    expect(calls).toEqual([[srcGpu, 4, dstGpu, 8, 16]])
    expect(submitted.length).toBe(1)
  })
})

// ── WebGL2: a REAL byte round-trip through gl.copyBufferSubData ───────────────
// Minimal fake GL that actually stores buffer bytes so the copy is verifiable
// (no real GPU in vitest). Models the subset WebGl2Device's vertex/index path
// + the copy encoder touch: createBuffer/bindBuffer/bufferData/bufferSubData/
// copyBufferSubData, plus the SAMPLER_* + texture stubs the ctor reads.
interface FakeBuf { bytes: Uint8Array }
function fakeGl(): WebGL2RenderingContext {
  const ARRAY_BUFFER = 0x8892, ELEMENT_ARRAY_BUFFER = 0x8893, UNIFORM_BUFFER = 0x8a11
  const COPY_READ_BUFFER = 0x8f36, COPY_WRITE_BUFFER = 0x8f37
  const bound = new Map<number, FakeBuf | null>()
  const gl = {
    ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER, UNIFORM_BUFFER, COPY_READ_BUFFER, COPY_WRITE_BUFFER,
    DYNAMIC_DRAW: 0x88e8,
    SAMPLER_2D: 0x8b5e, SAMPLER_CUBE: 0x8b60, SAMPLER_3D: 0x8b5f, SAMPLER_2D_ARRAY: 0x8dc1,
    createBuffer: (): FakeBuf => ({ bytes: new Uint8Array(0) }),
    bindBuffer: (target: number, buf: FakeBuf | null) => { bound.set(target, buf) },
    bufferData: (target: number, size: number) => {
      const b = bound.get(target) as FakeBuf
      b.bytes = new Uint8Array(size)
    },
    bufferSubData: (target: number, offset: number, data: ArrayBufferView) => {
      const b = bound.get(target) as FakeBuf
      b.bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offset)
    },
    copyBufferSubData: (readT: number, writeT: number, srcOff: number, dstOff: number, size: number) => {
      const s = bound.get(readT) as FakeBuf
      const d = bound.get(writeT) as FakeBuf
      d.bytes.set(s.bytes.subarray(srcOff, srcOff + size), dstOff)
    },
    // texture stubs the storage-buffer path would touch (unused here).
    createTexture: () => ({}), bindTexture: () => {},
  }
  return gl as unknown as WebGL2RenderingContext
}

describe('WebGl2 copyBufferToBuffer — gl.copyBufferSubData byte round-trip', () => {
  it('relocates bytes from src[srcOffset] to dst[dstOffset] (the arena ping-pong)', () => {
    const gl = fakeGl()
    const dev = new WebGl2Device(gl)
    const src = dev.createBuffer({ size: 16, usage: 'vertex', writable: true })
    const dst = dev.createBuffer({ size: 16, usage: 'vertex', writable: true })
    // Source bytes 0..15 = [10,11,...,25]; copy [4..12) → dst[0..8).
    const payload = new Uint8Array(16)
    for (let i = 0; i < 16; i++) payload[i] = 10 + i
    dev.writeBuffer(src, 0, payload)

    const enc = dev.createCommandEncoder()
    enc.copyBufferToBuffer(src, 4, dst, 0, 8)
    enc.finish()

    // Read the fake dst buffer's bytes back through the same fake-GL handle.
    const dstBuf = (dst as unknown as { buf: FakeBuf }).buf
    expect(Array.from(dstBuf.bytes.subarray(0, 8))).toEqual([14, 15, 16, 17, 18, 19, 20, 21])
    // Untouched tail stays zero.
    expect(Array.from(dstBuf.bytes.subarray(8, 16))).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })

  it('beginRenderPass on the copy encoder still fail-CLOSES (MRT = full-frame phase)', () => {
    const enc = new WebGl2Device(fakeGl()).createCommandEncoder()
    expect(() => enc.beginRenderPass({ colorAttachments: [] }))
      .toThrow(/beginRenderPass.*not yet supported|full-frame phase/)
  })
})
