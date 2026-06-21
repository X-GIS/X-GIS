import { describe, it, expect } from 'vitest'
import { emitLineWgsl } from '../index'

// The line-pattern fragment loop computes per-pattern geometry then branches on
// the pattern `anchor` (REPEAT vs START/END/CENTER). A stray `cb.continue()`
// (outer builder) instead of `d.continue()` (the REPEAT if-block) emitted an
// UNCONDITIONAL `continue;` at the TOP of the loop body — making every pattern
// branch dead code (WGSL "code is unreachable" warning on the hero page) and
// silently dropping ALL line-pattern rendering.
//
// fail-before: revert line.ts:701 to `cb.continue()` and the `continue;`
// reappears between `let half_s` and the `if ((anchor == 0u))`, failing this.

describe('emitLineWgsl — line-pattern loop reachability', () => {
  for (const pick of [false, true]) {
    it(`pattern anchor block is reachable (no stray continue), pick=${pick}`, () => {
      const wgsl = emitLineWgsl(pick)
      const halfS = wgsl.indexOf('let half_s')
      const anchor = wgsl.indexOf('if ((anchor == 0u))')
      expect(halfS).toBeGreaterThan(-1)
      expect(anchor).toBeGreaterThan(halfS)
      // Between computing half_s and the anchor branch there must be NO
      // statement-level `continue;` — that would make the pattern code dead.
      const between = wgsl.slice(halfS, anchor)
      expect(between).not.toMatch(/\bcontinue\s*;/)
    })
  }
})
