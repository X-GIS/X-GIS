// iter-348 — uniform-ring mid-frame grow must not strand pre-grow draws.
//
// User report: lowering pitch + moving sometimes renders polygons/lines
// with wrong colours (e.g. land painted water-blue); `?compute=1` never
// breaks. Root: at high pitch the per-frame draw count crosses the
// uniform ring capacity, so `growUniformRing` fires MID-PASS. It creates
// a NEW buffer + rebuilds the tile bind groups, but tiles already drawn
// THIS frame recorded `setBindGroup` against the OLD buffer. The
// end-of-pass `flushUniformStaging` writes only the NEW buffer, so those
// pre-grow draws read the OLD buffer at slots that still hold the PREVIOUS
// frame's colours → stale fill colour (compute=1 uses a different uniform
// path → immune). Fix: on grow, push THIS frame's staged slots into the
// old buffer before retiring it. This test pins that write.

import { describe, it, expect } from 'vitest'
import { VectorTileRenderer } from './vector-tile-renderer'

// WebGPU bitflag globals aren't present in the node test env.
;(globalThis as { GPUBufferUsage?: unknown }).GPUBufferUsage ??= {
  UNIFORM: 0x40, COPY_DST: 0x08, VERTEX: 0x20, INDEX: 0x10, STORAGE: 0x80, COPY_SRC: 0x04,
}

const UNIFORM_SLOT = 256

interface FakeBuffer { id: string }

function makeVtr(uniformSlot: number, capacity: number) {
  const writes: { buf: FakeBuffer; bufOffset: number; dataLen: number }[] = []
  let created = 0
  const vtr = Object.create(VectorTileRenderer.prototype) as VectorTileRenderer
  const oldBuf: FakeBuffer = { id: 'old' }
  const inj = vtr as unknown as {
    device: unknown; uniformRing: FakeBuffer; uniformRingCapacity: number
    uniformSlot: number; uniformStaging: Uint8Array; retiredUniformRings: FakeBuffer[]
    rebuildTileBindGroups: () => void
  }
  inj.device = {
    createBuffer: () => ({ id: `new${created++}` } as FakeBuffer),
    queue: { writeBuffer: (buf: FakeBuffer, bufOffset: number, data: ArrayBuffer, _o: number, size: number) => {
      writes.push({ buf, bufOffset, dataLen: size })
    } },
  }
  inj.uniformRing = oldBuf
  inj.uniformRingCapacity = capacity
  inj.uniformSlot = uniformSlot
  // staging filled with a recognisable pattern; bytes 0..uniformSlot*SLOT
  // represent THIS frame's already-staged draws.
  inj.uniformStaging = new Uint8Array(capacity * UNIFORM_SLOT).fill(0xab)
  inj.retiredUniformRings = []
  inj.rebuildTileBindGroups = () => { /* no GPU in unit scope */ }
  return { vtr, inj, writes, oldBuf }
}

describe('iter-348 uniform-ring grow strands no pre-grow draws', () => {
  it('writes THIS frame staged slots into the old buffer before retiring it', () => {
    const { vtr, inj, writes, oldBuf } = makeVtr(5, 8) // 5 draws already this frame
    ;(vtr as unknown as { growUniformRing: (n: number) => void }).growUniformRing(9)
    // old buffer retired
    expect(inj.retiredUniformRings).toContain(oldBuf)
    // and it received THIS frame's 5 staged slots (so pre-grow draws bound
    // to it read current data, not last frame's colours)
    const oldWrite = writes.find(w => w.buf === oldBuf)
    expect(oldWrite, 'old buffer flushed on grow').toBeDefined()
    expect(oldWrite!.bufOffset).toBe(0)
    expect(oldWrite!.dataLen).toBe(5 * UNIFORM_SLOT)
    // capacity doubled past the requested minimum
    expect(inj.uniformRingCapacity).toBeGreaterThanOrEqual(9)
  })

  it('does not write the old buffer when no draws were recorded yet', () => {
    const { vtr, writes, oldBuf } = makeVtr(0, 8) // grow before any draw
    ;(vtr as unknown as { growUniformRing: (n: number) => void }).growUniformRing(9)
    expect(writes.find(w => w.buf === oldBuf), 'no stale write when uniformSlot=0').toBeUndefined()
  })
})
