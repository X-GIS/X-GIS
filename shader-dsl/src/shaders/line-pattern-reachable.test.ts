import { describe, it, expect } from 'vitest'
import { emitLineWgsl } from '../index'

// The line-pattern fragment loop computes per-pattern geometry then branches on
// the pattern `anchor` (REPEAT vs START/END/CENTER). A stray `cb.continue()`
// (outer builder) instead of `d.continue()` (the REPEAT if-block) emitted an
// UNCONDITIONAL `continue;` at the TOP of the loop body — making every pattern
// branch dead code (WGSL "code is unreachable" warning on the hero page) and
// silently dropping ALL line-pattern rendering.
//
// fail-before: revert line.ts:701 to `cb.continue()` and a bare `continue;`
// reappears between the per-pattern `id == 0u` skip and the `anchor == 0u`
// branch, failing this.
//
// NOTE (cse-inline migration): the per-pattern geometry (`half_s`, `anchor`)
// used to be hand `let` bindings but is now written inline — and because those
// values depend on the loop index `k`, the cse auto-cache CANNOT hoist them
// (it only hoists input-only exprs), so they are spliced into each use site
// with NO emitted `let half_s` / `let anchor` line. This test therefore pins
// the STABLE structural tokens that prove the same reachability, not the old
// binding names:
//   - the anchor branch: the inlined `(... >> 6u) & 3u) == 0u` compare. The
//     `>> 6u` shift (anchor field = bits 6-7) is its unique signature, distinct
//     from the per-pattern `id == 0u` skips elsewhere in the shader.
//   - the per-pattern id-skip immediately preceding it: `... .id == 0u` guarding
//     a wrapped `continue;`. Located as the LAST `.id == 0u` before the anchor
//     branch, so it is THIS loop's skip (not the early-discard loop's earlier in
//     compute_line_color). The dead-code window starts AFTER that skip's own
//     (legitimate, wrapped) continue.

describe('emitLineWgsl — line-pattern loop reachability', () => {
  // The anchor branch condition, inlined: `(((<flags> >> 6u) & 3u) == 0u)`.
  const ANCHOR_BRANCH = />>\s*6u\)\s*&\s*3u\)\s*==\s*0u/
  // The per-pattern id-skip condition: `(layer.patterns[k].id == 0u)`.
  const ID_SKIP = /\.id\s*==\s*0u/g

  for (const pick of [false, true]) {
    it(`pattern anchor block is reachable (no stray continue), pick=${pick}`, () => {
      const wgsl = emitLineWgsl(pick)

      // Locate the anchor==0 branch (the head of the per-pattern body).
      const anchorMatch = wgsl.match(ANCHOR_BRANCH)
      expect(anchorMatch).not.toBeNull()
      const anchor = wgsl.indexOf(anchorMatch![0])
      expect(anchor).toBeGreaterThan(-1)

      // The per-pattern id-skip is the LAST `.id == 0u` before the anchor branch
      // (this loop's skip, not the early-discard loop's earlier in the fn).
      let idSkip = -1
      for (const m of wgsl.matchAll(ID_SKIP)) {
        if (m.index! < anchor) idSkip = m.index!
        else break
      }
      expect(idSkip).toBeGreaterThan(-1)

      // Start the dead-code window AFTER that id-skip's own (wrapped, legitimate)
      // `continue;`, exactly as the original test started after `let half_s`.
      const idSkipContinue = wgsl.indexOf('continue', idSkip)
      expect(idSkipContinue).toBeGreaterThan(-1)
      expect(idSkipContinue).toBeLessThan(anchor)
      const windowStart = idSkipContinue + 'continue'.length

      // Between the id-skip and the anchor branch there must be NO statement-level
      // `continue;` — a bare continue here makes the whole pattern body dead code.
      const between = wgsl.slice(windowStart, anchor)
      expect(between).not.toMatch(/\bcontinue\s*;/)
    })
  }
})
