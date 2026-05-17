// ═══════════════════════════════════════════════════════════════════
// Polygon shader marker drift invariants
// ═══════════════════════════════════════════════════════════════════
//
// Guard against the silent-no-op bug class that hid the OFM Bright
// school-fill regression (5-fix chain, commit 8e1aa08). The bug:
// `FILL_RETURN_MARKER` was set to `'out.color = u.fill_color;'`, but
// the actual line in `fs_fill` had grown to `'out.color = vec4<f32>(
// u.fill_color.rgb * wall_shade, u.fill_color.a);'`. `String.replace`
// silently returned the source unchanged when the marker missed —
// so every data-driven variant kept emitting the zero-uniform path
// and rendered as alpha=0 (invisible).
//
// These tests assert each marker constant is byte-identical to a
// substring that appears EXACTLY ONCE in `POLYGON_SHADER_SOURCE`.
// Any future shader edit that drifts the source line out of sync
// fails CI before the silent regression reaches production.
//
// Adding a new marker:
//   1. Add the `export const NEW_MARKER = '…';` next to the existing
//      ones in renderer.ts.
//   2. Add an `expectMarkerExactlyOnce(NEW_MARKER, 'reason')` line
//      to the suite below.

import { describe, expect, it } from 'vitest'
import {
  FILL_RETURN_MARKER,
  STROKE_RETURN_MARKER,
  PICK_FIELD_TOKEN,
  PICK_WRITE_TOKEN,
  POLYGON_SHADER_SOURCE,
} from './renderer'

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

function assertExactlyOnce(needle: string, label: string): void {
  const occurrences = countOccurrences(POLYGON_SHADER_SOURCE, needle)
  expect(occurrences, `${label} should appear EXACTLY ONCE in POLYGON_SHADER_SOURCE — found ${occurrences}`)
    .toBe(1)
}

describe('polygon shader markers — drift invariants', () => {
  it('FILL_RETURN_MARKER appears exactly once in the shader source', () => {
    // Drift here = the OFM Bright school-fill bug class. fs_fill's
    // `out.color = …;` line was renamed/extended → marker no longer
    // matches → every variant pipeline silently rendered legacy
    // uniform path.
    assertExactlyOnce(FILL_RETURN_MARKER, 'FILL_RETURN_MARKER')
  })

  it('STROKE_RETURN_MARKER appears exactly once', () => {
    assertExactlyOnce(STROKE_RETURN_MARKER, 'STROKE_RETURN_MARKER')
  })

  it('__PICK_FIELD__ token is present (regex-replaced)', () => {
    // Regex replace is forgiving — a missed token stays in the WGSL
    // and trips a compile error, but the failure is downstream and
    // late. Catch the deletion here.
    expect(POLYGON_SHADER_SOURCE).toContain(PICK_FIELD_TOKEN)
  })

  it('__PICK_WRITE__ token is present in both fs_fill and fs_stroke', () => {
    // Two occurrences expected: one in fs_fill, one in fs_stroke.
    // Deletion of EITHER breaks pick attachment writes for that
    // shader. Asserting count keeps the structural pairing intact.
    expect(countOccurrences(POLYGON_SHADER_SOURCE, PICK_WRITE_TOKEN))
      .toBeGreaterThanOrEqual(2)
  })

  it('marker substitution is non-empty (the replacement produces a different source)', () => {
    // Sanity: if FILL_RETURN_MARKER ever becomes the empty string
    // by accident, `String.replace('', …)` REPLACES AT POSITION 0
    // — every shader would prepend the variant fillExpr at the
    // very start of the source, almost certainly breaking the
    // module-level scope. Defend explicitly.
    expect(FILL_RETURN_MARKER.length).toBeGreaterThan(0)
    expect(STROKE_RETURN_MARKER.length).toBeGreaterThan(0)
  })

  it('per-fragment backface helper is called from all three polygon fragment shaders', () => {
    // Pins c205871 — fs_fill / fs_oit_translucent / fs_stroke each
    // discard back-hemisphere fragments via the
    // `polygon_cos_c_fragment(...)` helper (not via the interpolated
    // `input.cos_c < 0.0` varying that was the original cull). A
    // future refactor that drops the helper call from any of the
    // three frag shaders would silently leak fragments on globe /
    // ortho — pin the trio explicitly so that regression fails CI
    // instead of shipping as a back-hemisphere bleed-through.
    const callCount = countOccurrences(
      POLYGON_SHADER_SOURCE,
      'polygon_cos_c_fragment(input.abs_merc_x, input.abs_merc_y)',
    )
    expect(callCount, 'polygon_cos_c_fragment must be called by fs_fill, fs_oit_translucent, and fs_stroke')
      .toBe(3)
    // And confirm the helper itself is still defined exactly once.
    expect(countOccurrences(POLYGON_SHADER_SOURCE, 'fn polygon_cos_c_fragment')).toBe(1)
  })

  it('a simulated variant replace actually changes the shader (no silent no-op)', () => {
    // End-to-end: take the same string.replace path buildShader
    // does, and confirm the resulting source DIFFERS from the input.
    // If the marker has drifted to a no-match string, the output
    // would be byte-identical to the input → this test fires.
    const replacedFill = POLYGON_SHADER_SOURCE.replace(
      FILL_RETURN_MARKER,
      'out.color = vec4f(1.0, 0.0, 0.0, 1.0); // marker-drift-test',
    )
    expect(replacedFill).not.toBe(POLYGON_SHADER_SOURCE)
    expect(replacedFill).toContain('marker-drift-test')

    const replacedStroke = POLYGON_SHADER_SOURCE.replace(
      STROKE_RETURN_MARKER,
      'out.color = vec4f(0.0, 1.0, 0.0, 1.0); // marker-drift-test',
    )
    expect(replacedStroke).not.toBe(POLYGON_SHADER_SOURCE)
    expect(replacedStroke).toContain('marker-drift-test')
  })
})
