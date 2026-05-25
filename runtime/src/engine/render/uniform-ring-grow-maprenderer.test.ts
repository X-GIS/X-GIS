// iter-348 parity — MapRenderer's uniform-ring mid-frame grow must not
// strand pre-grow draws (the same fix VTR carries; see uniform-ring-grow
// .test.ts). MapRenderer grows mid-frame only during warmup (registered-
// layer count bounded + uniformRingCapacity sticky), so this was a latent
// warmup transient rather than VTR's steady-state high-pitch bug — but the
// stale-old-buffer mechanism is identical. This pins the old-buffer flush.

import { describe, it, expect } from 'vitest'
import { MapRenderer } from './renderer'

;(globalThis as { GPUBufferUsage?: unknown }).GPUBufferUsage ??= {
  UNIFORM: 0x40, COPY_DST: 0x08, VERTEX: 0x20, INDEX: 0x10, STORAGE: 0x80, COPY_SRC: 0x04,
}

const UNIFORM_SLOT = 256

interface FakeBuffer { id: string }

function makeRenderer(uniformSlot: number, capacity: number) {
  const writes: { buf: FakeBuffer; bufOffset: number; dataLen: number }[] = []
  let created = 0
  const r = Object.create(MapRenderer.prototype) as MapRenderer
  const oldBuf: FakeBuffer = { id: 'old' }
  const fakeView = { id: 'view' }
  const inj = r as unknown as {
    ctx: unknown; uniformBuffer: FakeBuffer; uniformRingCapacity: number
    uniformSlot: number; uniformStaging: Uint8Array; retiredUniformRings: FakeBuffer[]
    bindGroupLayout: unknown; featureBindGroupLayout: unknown
    paletteColorAtlasView: unknown; paletteSampler: unknown; spriteAtlasView: unknown
    layers: unknown[]
  }
  inj.ctx = {
    device: {
      createBuffer: () => ({ id: `new${created++}` } as FakeBuffer),
      createBindGroup: () => ({ id: 'bg' }),
      queue: { writeBuffer: (buf: FakeBuffer, bufOffset: number, _d: ArrayBuffer, _o: number, size: number) => {
        writes.push({ buf, bufOffset, dataLen: size })
      } },
    },
  }
  inj.uniformBuffer = oldBuf
  inj.uniformRingCapacity = capacity
  inj.uniformSlot = uniformSlot
  inj.uniformStaging = new Uint8Array(capacity * UNIFORM_SLOT).fill(0xcd)
  inj.retiredUniformRings = []
  inj.bindGroupLayout = {}
  inj.featureBindGroupLayout = {}
  inj.paletteColorAtlasView = fakeView
  inj.paletteSampler = fakeView
  inj.spriteAtlasView = fakeView
  inj.layers = [] // no per-layer bind groups to rebuild
  return { r, inj, writes, oldBuf }
}

describe('iter-348 MapRenderer uniform-ring grow strands no pre-grow draws', () => {
  it('writes THIS frame staged slots into the old buffer before retiring it', () => {
    const { r, inj, writes, oldBuf } = makeRenderer(5, 8)
    ;(r as unknown as { growUniformRing: (n: number) => void }).growUniformRing(9)
    expect(inj.retiredUniformRings).toContain(oldBuf)
    const oldWrite = writes.find(w => w.buf === oldBuf)
    expect(oldWrite, 'old buffer flushed on grow').toBeDefined()
    expect(oldWrite!.bufOffset).toBe(0)
    expect(oldWrite!.dataLen).toBe(5 * UNIFORM_SLOT)
    expect(inj.uniformRingCapacity).toBeGreaterThanOrEqual(9)
  })

  it('does not write the old buffer when no draws were recorded yet', () => {
    const { r, writes, oldBuf } = makeRenderer(0, 8)
    ;(r as unknown as { growUniformRing: (n: number) => void }).growUniformRing(9)
    expect(writes.find(w => w.buf === oldBuf), 'no stale write when uniformSlot=0').toBeUndefined()
  })
})
