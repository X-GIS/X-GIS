// Pin iter 492 icon-opacity edge-case behavior on the converter side.
// The happy path (0.5 → show.iconOpacity === 0.5) is incidentally
// covered by icon-along-line-conversion.test.ts:57 and
// icon-rotation-alignment-map-tangent.test.ts:96, but the bounds /
// non-constant / default-suppression edges have no dedicated gate.
// Without one, a regression that flipped the default-suppression
// branch (`!== 1` collapsing to `!= null`) would silently start
// emitting `label-icon-opacity-1` on every symbol layer and pay the
// per-vertex alpha cost for a no-op.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle, Lexer, Parser, lower, emitCommands } from '../index'

function compileShow(paint: Record<string, unknown>): {
  show: { label?: { iconOpacity?: number } }
  warnings: string
} {
  const style = {
    version: 8,
    sources: { v: { type: 'vector' as const, url: 'x.pmtiles' } },
    layers: [{
      id: 'sym',
      type: 'symbol' as const,
      source: 'v',
      'source-layer': 'poi',
      layout: { 'icon-image': 'marker' },
      paint,
    }],
  }
  const warnings: string[] = []
  const xgis = convertMapboxStyle(style as never, {
    coverage: { sources: [], layers: [], warnings },
  })
  const cmds = emitCommands(lower(new Parser(new Lexer(xgis).tokenize()).parse()))
  return {
    show: cmds.shows[0] as unknown as { label?: { iconOpacity?: number } },
    warnings: warnings.join('\n'),
  }
}

describe('icon-opacity — iter 492 edge cases', () => {
  it('default (omitted) → show.iconOpacity undefined', () => {
    const { show } = compileShow({})
    expect(show.label?.iconOpacity).toBeUndefined()
  })

  it('explicit 1 → suppressed (no-op), iconOpacity undefined', () => {
    // Default 1 must NOT emit the utility — otherwise every layer
    // pays the per-vertex alpha attribute for no behavioral change.
    const { show } = compileShow({ 'icon-opacity': 1 })
    expect(show.label?.iconOpacity).toBeUndefined()
  })

  it('0.5 → show.iconOpacity 0.5', () => {
    const { show } = compileShow({ 'icon-opacity': 0.5 })
    expect(show.label?.iconOpacity).toBe(0.5)
  })

  it('0 → show.iconOpacity 0 (icons fully hidden)', () => {
    // Critical: 0 must NOT be treated as omitted. Mapbox spec allows
    // 0 as a valid "hide via paint" sentinel without setting visibility.
    const { show } = compileShow({ 'icon-opacity': 0 })
    expect(show.label?.iconOpacity).toBe(0)
  })

  it('negative → clamped to 0', () => {
    const { show } = compileShow({ 'icon-opacity': -0.5 })
    expect(show.label?.iconOpacity).toBe(0)
  })

  it('> 1 → clamped to 1 (emits no-op utility — harmless)', () => {
    // 1.5 trips the `!== 1` gate so the utility IS emitted, but
    // post-clamp lands at 1.0 — same as the default. Threading this
    // case through is wasteful but never visually wrong; pinning the
    // value here so a future simplification doesn't accidentally
    // amplify an out-of-spec input.
    const { show } = compileShow({ 'icon-opacity': 1.5 })
    expect(show.label?.iconOpacity).toBe(1)
  })

  it('zoom-interp → non-constant warning, no iconOpacity', () => {
    const { show, warnings } = compileShow({
      'icon-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0, 14, 1],
    })
    expect(show.label?.iconOpacity).toBeUndefined()
    expect(warnings).toContain('icon-opacity non-constant form not yet supported')
  })

  it('data-driven match → non-constant warning, no iconOpacity', () => {
    const { show, warnings } = compileShow({
      'icon-opacity': ['match', ['get', 'class'], 'shop', 0.6, 1],
    })
    expect(show.label?.iconOpacity).toBeUndefined()
    expect(warnings).toContain('icon-opacity non-constant form not yet supported')
  })

  it('v8 literal-wrap [\"literal\", 0.4] → unwrapped to 0.4', () => {
    // unwrapLiteralScalar runs before the typeof gate; strict-tooling
    // chains that emit `["literal", 0.4]` instead of bare 0.4 must
    // still hit the constant path, not the warning branch.
    const { show, warnings } = compileShow({ 'icon-opacity': ['literal', 0.4] })
    expect(show.label?.iconOpacity).toBe(0.4)
    expect(warnings).not.toContain('icon-opacity non-constant form')
  })

  it('NaN → silently dropped (Number.isFinite gate, no utility emitted)', () => {
    // NaN can't appear in valid JSON so this is a defence-in-depth
    // guard, not a hot path. typeof NaN === 'number' AND
    // !Number.isFinite(NaN) so it falls through both branches: no
    // utility, no warning. The critical invariant is that NaN does
    // NOT emit `label-icon-opacity-NaN` which would parseFloat to
    // NaN at lower-time and propagate into per-vertex alpha as a
    // poison value.
    const { show, warnings } = compileShow({ 'icon-opacity': NaN })
    expect(show.label?.iconOpacity).toBeUndefined()
    expect(warnings).not.toContain('icon-opacity-NaN')
  })
})
