import { describe, it, expect } from 'vitest'
import { PROJECTION_CONSTS } from './projections'
import { ECEF_CONSTS } from './ecef'

// Guard for the ConstDecl dual-value agreement surface: each module const carries a `wgslValue`
// (truncated f32 shader literal) and a `cpuValue` (full-precision f64 the oracle uses). Most consts
// have IDENTICAL values; only PI/DEG2RAD intentionally diverge (an f32-truncation that, if folded,
// would shift the #392-sensitive reverse-projection precision). This test makes that intent explicit
// and catches the footgun: an ACCIDENTAL mismatch (a fat-fingered wgslValue) on a const that should
// not diverge, or a divergence whose wgslValue isn't a plausible truncation of cpuValue.
const INTENTIONAL_PRECISION_SPLIT = new Set(['PI', 'DEG2RAD'])

const ALL = [...PROJECTION_CONSTS, ...ECEF_CONSTS]

describe('ConstDecl wgslValue ↔ cpuValue precision split', () => {
  for (const c of ALL) {
    if (c.valueExpr !== undefined) continue // non-scalar consts use valueExpr, not the dual scalars
    it(`'${c.name}' diverges only when intentional`, () => {
      if (c.wgslValue === c.cpuValue) return // no divergence — always safe
      // Diverges → must be a documented precision split, and the f32 literal must be a plausible
      // truncation of the f64 value (a relative match), not an accidental wrong number.
      expect(INTENTIONAL_PRECISION_SPLIT.has(c.name)).toBe(true)
      expect(Math.abs(c.wgslValue - c.cpuValue) / Math.abs(c.cpuValue)).toBeLessThan(1e-6)
    })
  }

  it('every allowlisted precision-split const exists and actually diverges (no stale allowlist)', () => {
    for (const name of INTENTIONAL_PRECISION_SPLIT) {
      const c = ALL.find((d) => d.name === name)
      expect(c, `allowlisted '${name}' not found among the consts`).toBeDefined()
      expect(c!.wgslValue, `allowlisted '${name}' no longer diverges — remove it from the allowlist`).not.toBe(c!.cpuValue)
    }
  })
})
