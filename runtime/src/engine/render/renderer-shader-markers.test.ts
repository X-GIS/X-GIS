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
import { RASTER_SHADER_SOURCE } from './raster-renderer'
import { BG_SHADER_SOURCE } from './background-renderer'

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

describe('raster-renderer shader markers', () => {
  it('__PICK_FIELD__ token present', () => {
    expect(RASTER_SHADER_SOURCE).toContain('__PICK_FIELD__')
  })

  it('__PICK_WRITE__ token present', () => {
    expect(RASTER_SHADER_SOURCE).toContain('__PICK_WRITE__')
  })

  it('regex replace simulation actually changes the shader source', () => {
    const replaced = RASTER_SHADER_SOURCE
      .replace(/__PICK_FIELD__/g, '@location(1) @interpolate(flat) pick: vec2<u32>,')
      .replace(/__PICK_WRITE__/g, 'out.pick = vec2<u32>(0u, 0u);')
    expect(replaced).not.toBe(RASTER_SHADER_SOURCE)
  })
})

describe('background-renderer shader markers', () => {
  it('__PICK_FIELD__ token present', () => {
    expect(BG_SHADER_SOURCE).toContain('__PICK_FIELD__')
  })

  it('__PICK_OUT_FIELD__ token present (background-specific output struct token)', () => {
    expect(BG_SHADER_SOURCE).toContain('__PICK_OUT_FIELD__')
  })

  it('__PICK_WRITE__ token present', () => {
    expect(BG_SHADER_SOURCE).toContain('__PICK_WRITE__')
  })

  it('three-token regex replace simulation actually changes the shader', () => {
    const replaced = BG_SHADER_SOURCE
      .replace(/__PICK_FIELD__/g, '@location(0) @interpolate(flat) _pad: u32,')
      .replace(/__PICK_OUT_FIELD__/g, '@location(1) pick: vec2<u32>,')
      .replace(/__PICK_WRITE__/g, 'out.pick = vec2<u32>(0u, 0u);')
    expect(replaced).not.toBe(BG_SHADER_SOURCE)
  })

  it('no stray token name typos — every PICK_* substring in source matches a known token', () => {
    // Catches a misnaming like `__PICK_FELD__` (typo) that produces
    // an unresolved identifier far downstream. Allowed tokens are
    // the exact three the renderer replaces.
    const known = new Set(['__PICK_FIELD__', '__PICK_OUT_FIELD__', '__PICK_WRITE__'])
    // Find every `__PICK_…__` substring and assert it's known.
    const matches = BG_SHADER_SOURCE.match(/__PICK_[A-Z_]+__/g) ?? []
    for (const m of matches) {
      expect(known.has(m), `unknown PICK token in BG_SHADER_SOURCE: "${m}"`).toBe(true)
    }
  })
})

describe('PICK token count sanity (multiplicity invariant)', () => {
  it('LINE_SHADER_SOURCE: __PICK_FIELD__ ×1, __PICK_WRITE__ ×1', () => {
    expect(countOccurrences(LINE_SHADER_SOURCE, '__PICK_FIELD__')).toBe(1)
    expect(countOccurrences(LINE_SHADER_SOURCE, '__PICK_WRITE__')).toBe(1)
  })

  it('RASTER_SHADER_SOURCE: __PICK_FIELD__ ×1, __PICK_WRITE__ ×1', () => {
    expect(countOccurrences(RASTER_SHADER_SOURCE, '__PICK_FIELD__')).toBe(1)
    expect(countOccurrences(RASTER_SHADER_SOURCE, '__PICK_WRITE__')).toBe(1)
  })

  it('BG_SHADER_SOURCE: three tokens each appear exactly once', () => {
    expect(countOccurrences(BG_SHADER_SOURCE, '__PICK_FIELD__')).toBe(1)
    expect(countOccurrences(BG_SHADER_SOURCE, '__PICK_OUT_FIELD__')).toBe(1)
    expect(countOccurrences(BG_SHADER_SOURCE, '__PICK_WRITE__')).toBe(1)
  })
})
