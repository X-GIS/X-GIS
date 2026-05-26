// ═══════════════════════════════════════════════════════════════════
// Marker drift invariants — line / raster / background renderers
// ═══════════════════════════════════════════════════════════════════
//
// Sibling of polygon-shader-markers.test.ts. Each renderer carries
// its own shader source with `__PICK_FIELD__` / `__PICK_WRITE__`
// (plus `__PICK_OUT_FIELD__` for background) regex-replaced at
// build time. Regex replace is more forgiving than literal
// string.replace — a missed token simply STAYS in the WGSL, where
// it produces a "unresolved identifier __PICK_WRITE__" compile
// error on first pipeline build. That's already a fail-fast, but:
//
//   - The error surfaces LATE — at pipeline create time, far
//     downstream from the actual edit that dropped the token.
//   - A deletion that removes the LAST occurrence of a token from
//     the shader source produces NO compile error (no reference
//     left to be unresolved). The renderer silently skips a paint
//     step (e.g. pick attachment write) until someone notices in
//     a screenshot.
//
// Asserting EVERY token is present + appears at least once gives
// early surface-area coverage for the silent-deletion case.

import { describe, expect, it } from 'vitest'
import { LINE_SHADER_SOURCE } from './line-renderer'
// NOTE: the background shader no longer uses __PICK_*__ markers — it is emitted
// from the shader DSL (shader-dsl/background.ts) with conditional pick emission.
// Its pick-variant coverage lives in shader-dsl/background-dsl.test.ts.

function countOccurrences(source: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let from = 0
  while (true) {
    const i = source.indexOf(needle, from)
    if (i < 0) return count
    count++
    from = i + needle.length
  }
}

describe('line-renderer shader markers', () => {
  it('__PICK_FIELD__ token present', () => {
    expect(LINE_SHADER_SOURCE).toContain('__PICK_FIELD__')
  })

  it('__PICK_WRITE__ token present', () => {
    expect(LINE_SHADER_SOURCE).toContain('__PICK_WRITE__')
  })

  it('regex replace simulation actually changes the shader source', () => {
    // If the token has been silently deleted, the replacement
    // becomes a no-op and the output equals the input.
    const replaced = LINE_SHADER_SOURCE
      .replace(/__PICK_FIELD__/g, '@location(1) @interpolate(flat) pick: vec2<u32>,')
      .replace(/__PICK_WRITE__/g, 'out.pick = vec2<u32>(0u, 0u);')
    expect(replaced).not.toBe(LINE_SHADER_SOURCE)
  })
})

describe('PICK token count sanity (multiplicity invariant)', () => {
  it('LINE_SHADER_SOURCE: __PICK_FIELD__ ×1, __PICK_WRITE__ ×2', () => {
    expect(countOccurrences(LINE_SHADER_SOURCE, '__PICK_FIELD__')).toBe(1)
    // iter-185 added fs_line_pattern (line-pattern Stage 2) which also
    // emits a __PICK_WRITE__. Count is now 2: fs_line + fs_line_pattern.
    expect(countOccurrences(LINE_SHADER_SOURCE, '__PICK_WRITE__')).toBe(2)
  })
})
