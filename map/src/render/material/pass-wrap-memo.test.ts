// ═══ #1582 sites 1+2 — the pass encoder was re-wrapped once per draw ═══
//
// `wrapWebGpuPass(encoder)` (rhi-webgpu.ts) allocates a real `WebGpuRenderPass`
// class instance with no memo — polygon-fill-material.ts called it once per
// fill draw, line-renderer.ts once per stroke draw, even though `encoder` is
// loop-invariant for the whole render call. `wrapWebGpuPassMemoized` shares
// ONE WeakMap between both call sites, mirroring the identical pattern
// already proven at render-loop.ts:108-125.

import { describe, expect, it, beforeEach } from 'vitest'
import { wrapWebGpuPassMemoized } from './pass-wrap-memo'
import {
  _setEnabled,
  resetAllocProfile,
  snapshotAllocProfile,
} from '../../__profile__/alloc-counter'

// Minimal fake native encoder — wrapWebGpuPass only stores the reference
// (WebGpuRenderPass's ctor is `constructor(private readonly enc) {}`), so a
// plain object satisfies it for this identity-focused gate.
function fakeEncoder(): GPURenderPassEncoder {
  return {} as GPURenderPassEncoder
}

describe('#1582 sites 1+2 — wrapWebGpuPassMemoized shares one wrapper per encoder', () => {
  it('the SAME encoder wrapped twice returns the SAME RhiRenderPass instance', () => {
    const enc = fakeEncoder()
    const a = wrapWebGpuPassMemoized(enc)
    const b = wrapWebGpuPassMemoized(enc)
    expect(b, 'a fill draw and a stroke draw against the same encoder must share one wrapper').toBe(
      a,
    )
  })

  it('CONTROL — two DIFFERENT encoders get two DIFFERENT wrappers, not one shared incorrectly', () => {
    const encA = fakeEncoder()
    const encB = fakeEncoder()
    const a = wrapWebGpuPassMemoized(encA)
    const b = wrapWebGpuPassMemoized(encB)
    expect(a, 'distinct encoders must not collapse to one wrapper').not.toBe(b)
  })

  describe('allocation profile', () => {
    beforeEach(() => {
      _setEnabled(true)
      resetAllocProfile()
    })

    it('bumps the miss counter once per DISTINCT encoder, not once per call', () => {
      const enc = fakeEncoder()
      // Simulates a fill draw + two stroke draws against the same encoder —
      // the shape sites 1 and 2 hit in one frame.
      wrapWebGpuPassMemoized(enc)
      wrapWebGpuPassMemoized(enc)
      wrapWebGpuPassMemoized(enc)

      const profile = snapshotAllocProfile()
      expect(profile['pass-wrap-memo.wrapWebGpuPassMemoized.miss']).toBe(1)
    })

    it('CONTROL — a NEW encoder next frame bumps the miss counter again (the memo is not stuck)', () => {
      wrapWebGpuPassMemoized(fakeEncoder())
      snapshotAllocProfile() // roll the per-frame delta window forward
      wrapWebGpuPassMemoized(fakeEncoder())
      const profile = snapshotAllocProfile()
      expect(profile['pass-wrap-memo.wrapWebGpuPassMemoized.miss']).toBe(1)
    })
  })
})
