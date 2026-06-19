import { describe, it, expect } from 'vitest'
import { dispatchCenterKey } from './label-pass'

// #402-C — the label rebake-skip replays the prior frame's baked screen-px icons
// while the dispatch centre-key is unchanged. The buggy key quantized the camera
// centre to INTEGER Mercator metres (centerX|0); at z22 1 m ≈ 54 px, so a
// sub-metre drag kept the key (and the icons/shields) frozen while the GPU road
// moved smoothly → snap jitter / off-road desync. dispatchCenterKey now
// quantizes to ~1 CSS px (centre/mpp) so it ticks per px of pan at any zoom.
describe('dispatchCenterKey — px-quantized rebake centre key (#402-C)', () => {
  const cx = 14_117_000, cy = 4_517_000 // ~Seoul, Mercator metres

  it('z22: a sub-metre pan (0.4 m ≈ 21 px) changes the key → icons rebake/track', () => {
    expect(dispatchCenterKey(cx, cy, 22)).not.toBe(dispatchCenterKey(cx + 0.4, cy, 22))
    // The OLD integer-metre key did NOT change for that pan — the freeze (proof
    // the px-quantization is what fixes it):
    expect(`${cx | 0},${cy | 0}`).toBe(`${(cx + 0.4) | 0},${cy | 0}`)
  })

  it('z22: a ~5 px pan (0.1 m) changes the key', () => {
    expect(dispatchCenterKey(cx, cy, 22)).not.toBe(dispatchCenterKey(cx + 0.1, cy, 22))
  })

  it('low zoom (z2): a sub-metre pan does NOT change the key (no wasteful per-metre rebake)', () => {
    expect(dispatchCenterKey(cx, cy, 2)).toBe(dispatchCenterKey(cx + 0.4, cy, 2))
  })

  it('y axis quantizes the same way', () => {
    expect(dispatchCenterKey(cx, cy, 22)).not.toBe(dispatchCenterKey(cx, cy + 0.4, 22))
  })
})
