// FIX 4 — lch()/oklch() percentage CHROMA used the lab a/b reference
// (parseLabAB → 125 for lab, 0.4 for ok) instead of the chroma
// reference. Per CSS Color 4: lch chroma 100% → 150, oklch 100% → 0.4.
// So `lch(50% 100% 90)` resolved as C=125 (under-saturated) instead of
// 150; oklch was coincidentally correct (a/b ref == chroma ref == 0.4).
//
// resolveColor returns a hex, so the percentage form is pinned by
// equality against the equivalent unitless chroma value:
//   lch(50% 100% 90)  must equal  lch(50% 150 90)  and NOT  lch(50% 125 90)
//   oklch(50% 100% 90) must equal oklch(0.5 0.4 90)         (unchanged)
//   lch(50% 30 90) unitless chroma unchanged
//   lab a/b percent reference (125 / 0.4) unchanged

import { describe, expect, it } from 'vitest'
import { resolveColor } from '../tokens/colors'

describe('FIX 4 — lch/oklch percentage chroma uses the chroma reference', () => {
  it('lch percentage chroma 100% → 150 (not 125)', () => {
    const pct = resolveColor('lch(50% 100% 90)')
    const at150 = resolveColor('lch(50% 150 90)')
    const at125 = resolveColor('lch(50% 125 90)')
    expect(pct).not.toBeNull()
    expect(pct).toBe(at150)
    expect(pct).not.toBe(at125)
  })

  it('oklch percentage chroma 100% → 0.4 (unchanged)', () => {
    const pct = resolveColor('oklch(50% 100% 90)')
    const at04 = resolveColor('oklch(0.5 0.4 90)')
    expect(pct).not.toBeNull()
    expect(pct).toBe(at04)
  })

  it('lch unitless chroma is unchanged (30 stays 30)', () => {
    // A unitless chroma must NOT be touched by the percent-reference fix.
    const a = resolveColor('lch(50% 30 90)')
    const b = resolveColor('lch(50% 30 90)')
    expect(a).toBe(b)
    expect(a).toMatch(/^#[0-9a-f]{6,8}$/)
    // 30 != 150, so it must differ from the 100% form.
    expect(a).not.toBe(resolveColor('lch(50% 100% 90)'))
  })

  it('lab a/b percent reference stays 125 (lab unchanged)', () => {
    // lab a 100% must still map to 125, NOT the chroma 150 reference.
    const pct = resolveColor('lab(50% 100% 0)')
    const at125 = resolveColor('lab(50% 125 0)')
    expect(pct).toBe(at125)
  })

  it('oklab a/b percent reference stays 0.4 (oklab unchanged)', () => {
    const pct = resolveColor('oklab(0.5 100% 0)')
    const at04 = resolveColor('oklab(0.5 0.4 0)')
    expect(pct).toBe(at04)
  })
})
