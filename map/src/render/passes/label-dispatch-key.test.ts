import { describe, it, expect } from 'vitest'
import { WORLD_MERC, TILE_PX } from '@xgis/geo'
import { Camera } from '../../camera'
import { dispatchCenterKey } from './label-pass'

// dispatchCenterKey now quantizes by a caller-supplied `mpp` (the single
// effective-mpp authority), not an internal 2^zoom (#964). Above the sub-cap band
// effective === raw, so the #402-C cases below feed the raw mpp at their zoom —
// byte-identical to the pre-#964 (centre / (WORLD_MERC/TILE_PX/2^zoom)) form.
const rawMpp = (zoom: number): number => WORLD_MERC / TILE_PX / Math.pow(2, zoom)

// #402-C — the label rebake-skip replays the prior frame's baked screen-px icons
// while the dispatch centre-key is unchanged. The buggy key quantized the camera
// centre to INTEGER Mercator metres (centerX|0); at z22 1 m ≈ 54 px, so a
// sub-metre drag kept the key (and the icons/shields) frozen while the GPU road
// moved smoothly → snap jitter / off-road desync. dispatchCenterKey now
// quantizes to ~1 CSS px (centre/mpp) so it ticks per px of pan at any zoom.
describe('dispatchCenterKey — px-quantized rebake centre key (#402-C)', () => {
  const cx = 14_117_000,
    cy = 4_517_000 // ~Seoul, Mercator metres

  it('z22: a sub-metre pan (0.4 m ≈ 21 px) changes the key → icons rebake/track', () => {
    expect(dispatchCenterKey(cx, cy, rawMpp(22))).not.toBe(
      dispatchCenterKey(cx + 0.4, cy, rawMpp(22)),
    )
    // The OLD integer-metre key did NOT change for that pan — the freeze (proof
    // the px-quantization is what fixes it):
    expect(`${cx | 0},${cy | 0}`).toBe(`${(cx + 0.4) | 0},${cy | 0}`)
  })

  it('z22: a ~5 px pan (0.1 m) changes the key', () => {
    expect(dispatchCenterKey(cx, cy, rawMpp(22))).not.toBe(
      dispatchCenterKey(cx + 0.1, cy, rawMpp(22)),
    )
  })

  it('low zoom (z2): a sub-metre pan does NOT change the key (no wasteful per-metre rebake)', () => {
    expect(dispatchCenterKey(cx, cy, rawMpp(2))).toBe(dispatchCenterKey(cx + 0.4, cy, rawMpp(2)))
  })

  it('y axis quantizes the same way', () => {
    expect(dispatchCenterKey(cx, cy, rawMpp(22))).not.toBe(
      dispatchCenterKey(cx, cy + 0.4, rawMpp(22)),
    )
  })
})

// #964 — the live path (execute) feeds dispatchCenterKey the CAPPED effective mpp
// (camera.effectiveMpp), NOT the raw WORLD_MERC/TILE_PX/2^zoom. In the frozen
// sub-cap band the on-screen pan is governed by the capped scale, so the key must
// quantize by it to keep ticking per TRUE on-screen px. This pins that authority
// choice: with a REAL Camera at z0 on a tall viewport (cap binds), a pan that is
// ≥1 capped px but <1 raw px TICKS the effective key yet leaves the raw key FROZEN
// — i.e. a raw-mpp revert (label-pass.ts:582) would freeze the label rebake there.
//
// NOTE: the live consumer inlines the quantization (P3 zero-alloc), so this is an
// AUTHORITY-level gate (like #739's merc-z0 harness) — it drives dispatchCenterKey
// with the real Camera.effectiveMpp vs raw, not the inlined execute() site.
describe('dispatchCenterKey — sub-cap band quantizes by the capped effective mpp (#964)', () => {
  it('z0 tall viewport: a ≥1-capped-px pan ticks the effective key but not the raw key', () => {
    const cssH = 1080
    const dpr = 1
    const cam = new Camera(0, 0, 0)
    cam.projType = 0
    cam.globeMode = false

    const eff = cam.effectiveMpp(0, cssH, dpr) // capped (the cap binds at z0/cssH=1080)
    const raw = rawMpp(0)
    // Fixture sanity: the cap MUST bind here or the gate proves nothing (raw ≠ capped).
    expect(eff).toBeLessThan(raw)

    // 1.5 capped px is ≥1 px under the capped authority but <1 px under raw
    // (1.5 · eff/raw ≈ 0.71 raw px). centreX 0 sits on a px boundary for both.
    const panM = eff * 1.5
    // Capped authority (what the fixed live path feeds): the key TICKS → labels rebake.
    expect(dispatchCenterKey(0, 0, eff)).not.toBe(dispatchCenterKey(panM, 0, eff))
    // Raw mpp (the #964 revert): the key stays FROZEN → labels lag the frozen-view pan.
    expect(dispatchCenterKey(0, 0, raw)).toBe(dispatchCenterKey(panM, 0, raw))
  })
})
