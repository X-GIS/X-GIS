// Unit tests for FrameArena (Plan AAA Phase B.1, iter-239).
// Pins:
//   - alloc + alignment
//   - allocF32 / allocU32 / allocI32 share underlying buffer
//   - watermark resets on beginFrame
//   - capacity grow on peak >= GROW_TRIGGER × cap
//   - reserve() pre-grows + invalidates buffer
//   - alloc overflow throws
//   - stats reflect current state

import { describe, it, expect } from 'vitest'
import { FrameArena } from './frame-arena'

describe('FrameArena — alloc + alignment', () => {
  it('alloc returns Uint8Array view with requested byte length', () => {
    const a = new FrameArena(1024)
    const view = a.alloc(64)
    expect(view.byteLength).toBe(64)
    expect(view.byteOffset).toBe(0)
  })

  it('sequential allocs are contiguous (4-byte aligned)', () => {
    const a = new FrameArena(1024)
    const v1 = a.alloc(10)  // 10 bytes, aligned to 4 = 12 bytes
    const v2 = a.alloc(20)  // starts at offset 12
    expect(v1.byteOffset).toBe(0)
    expect(v2.byteOffset).toBe(12)
  })

  it('alignment honored (16-byte align)', () => {
    const a = new FrameArena(1024)
    a.alloc(5)               // bumps watermark to 8 (4-aligned)
    const v = a.alloc(16, 16)  // next 16-aligned = 16
    expect(v.byteOffset).toBe(16)
  })

  it('allocF32 + allocU32 + allocI32 produce typed views with correct count', () => {
    const a = new FrameArena(1024)
    const f = a.allocF32(8)
    const u = a.allocU32(4)
    const i = a.allocI32(2)
    expect(f.length).toBe(8)
    expect(u.length).toBe(4)
    expect(i.length).toBe(2)
    // Verify they share the same underlying ArrayBuffer.
    expect(f.buffer).toBe(u.buffer)
    expect(u.buffer).toBe(i.buffer)
  })
})

describe('FrameArena — beginFrame + grow', () => {
  it('beginFrame resets watermark to 0', () => {
    const a = new FrameArena(1024)
    a.alloc(100)
    expect(a.getStats().usedBytes).toBe(100)
    a.beginFrame()
    expect(a.getStats().usedBytes).toBe(0)
  })

  it('beginFrame tracks peak across frames', () => {
    const a = new FrameArena(1024)
    a.alloc(200)
    a.beginFrame()
    a.alloc(80)
    a.beginFrame()
    expect(a.getStats().peakBytes).toBe(200)
  })

  it('capacity grows when peak hits 0.9× cap at beginFrame', () => {
    const a = new FrameArena(1024)
    a.alloc(950)  // ~0.93 × 1024 — over GROW_TRIGGER 0.9
    a.beginFrame()
    expect(a.getStats().capacityBytes).toBe(1536)  // 1024 × 1.5
    expect(a.getStats().grows).toBe(1)
  })

  it('capacity stable when peak below trigger', () => {
    const a = new FrameArena(1024)
    a.alloc(500)  // ~0.49 × 1024 — under trigger
    a.beginFrame()
    expect(a.getStats().capacityBytes).toBe(1024)
    expect(a.getStats().grows).toBe(0)
  })
})

describe('FrameArena — reserve + overflow', () => {
  it('reserve pre-grows capacity', () => {
    const a = new FrameArena(1024)
    a.reserve(8192)
    expect(a.getStats().capacityBytes).toBeGreaterThanOrEqual(8192)
    expect(a.getStats().grows).toBe(1)
  })

  it('reserve is no-op when already large enough', () => {
    const a = new FrameArena(1024)
    a.reserve(512)  // smaller than current
    expect(a.getStats().capacityBytes).toBe(1024)
    expect(a.getStats().grows).toBe(0)
  })

  it('alloc throws RangeError on overflow', () => {
    const a = new FrameArena(64)
    expect(() => a.alloc(128)).toThrowError(/FrameArena overflow/)
  })
})

describe('FrameArena — stats', () => {
  it('frames counter bumps per beginFrame', () => {
    const a = new FrameArena()
    expect(a.getStats().frames).toBe(0)
    a.beginFrame()
    a.beginFrame()
    a.beginFrame()
    expect(a.getStats().frames).toBe(3)
  })

  it('initial stats: cap >= initial, all counters 0', () => {
    const a = new FrameArena(1024)
    const s = a.getStats()
    expect(s.capacityBytes).toBe(1024)
    expect(s.usedBytes).toBe(0)
    expect(s.peakBytes).toBe(0)
    expect(s.frames).toBe(0)
    expect(s.grows).toBe(0)
  })

  it('default constructor size 64 KB', () => {
    const a = new FrameArena()
    expect(a.getStats().capacityBytes).toBe(64 * 1024)
  })
})

describe('FrameArena — semantic invariants', () => {
  it('typed-array writes survive within a frame', () => {
    const a = new FrameArena(1024)
    const f = a.allocF32(4)
    f[0] = 1.5
    f[1] = -2.25
    f[2] = 0.0
    f[3] = 100.0
    expect(f[0]).toBe(1.5)
    expect(f[1]).toBe(-2.25)
    expect(f[3]).toBe(100.0)
  })

  it('two F32 views allocated in same frame share memory contiguously', () => {
    const a = new FrameArena(1024)
    const f1 = a.allocF32(2)
    const f2 = a.allocF32(2)
    f1[0] = 1
    f1[1] = 2
    f2[0] = 3
    f2[1] = 4
    // Sub-views share the same backing buffer at consecutive offsets.
    expect(f2.byteOffset).toBe(f1.byteOffset + 8)
    expect(f1.buffer).toBe(f2.buffer)
  })

  it('after grow, prior subview is INVALID (new backing buffer)', () => {
    const a = new FrameArena(1024)
    const f1 = a.allocF32(2)
    f1[0] = 42
    a.alloc(950)  // push peak past trigger
    a.beginFrame()  // grow fires here
    const f2 = a.allocF32(2)
    expect(f2.buffer).not.toBe(f1.buffer)  // different backing
    // f1's memory is detached from arena; reading it doesn't reflect
    // arena state. (Not asserted as invariant — just documents that
    // sub-views must not outlive grow events.)
  })
})
