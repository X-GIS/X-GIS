// Pin fail-CLOSED behaviour for an authored-but-UNCONVERTIBLE filter.
//
// Bug: every layer converter shared the body
//   if (layer.filter !== undefined) {
//     const f = filterToXgis(layer.filter, warnings)
//     if (f) lines.push(`  filter: ${f}`)
//   }
// When `layer.filter` IS authored but UNCONVERTIBLE (an op filterToXgis
// can't lower — e.g. `["feature-state", …]`), filterToXgis returns null,
// the `if (f)` gate skips the push, and the layer emits NO filter line.
// A filter-less layer renders EVERY feature → fail-OPEN, the exact
// opposite of the spec intent that an unknown/unsatisfiable predicate
// EXCLUDES features (a `["feature-state", …]` filter that drops out
// would render ALL features, not none).
//
// Fix: fail CLOSED — emit the literal `filter: false`, which the
// compiler evaluator + both runtime filter-eval paths resolve to "match
// nothing" (zero features). The fail-before assertion below: the output
// must NOT be a filter-less layer block — it must be fail-closed.

import { describe, it, expect } from 'vitest'
import { convertLayer } from '../convert/layers'

// A `["feature-state", …]` filter — filterToXgis has no lowering for the
// `feature-state` op (expressions.ts KNOWN_UNSUPPORTED — needs the
// setFeatureState/hover runtime subsystem), so it returns null with a
// warning. The canonical over-permissive case. (`within` then `distance`
// were used here until each gained CPU support.)
const UNCONVERTIBLE = ['feature-state', 'hover'] as unknown

/** A converted layer is "fail-closed" iff it either drops every feature
 *  via `filter: false` (or equivalent match-nothing literal) OR is
 *  SKIPPED entirely. It is fail-OPEN (the bug) iff it emits a layer
 *  block with NO filter line — that renders all features. */
function assertFailClosed(out: string | null): void {
  expect(out).not.toBeNull()
  const code = out as string
  const isMatchNothing = /\bfilter:\s*false\b/.test(code)
  const isSkipped = /\/\/\s*SKIPPED/.test(code)
  const emitsLayerBlock = /^\s*layer\s/m.test(code)
  // The bug shape: a layer block is emitted with no filter line.
  const failOpen = emitsLayerBlock && !isMatchNothing && !/\bfilter:/.test(code)
  expect(failOpen, `fail-OPEN: layer renders ALL features (no filter line)\n${code}`).toBe(false)
  expect(isMatchNothing || isSkipped, `expected fail-closed (filter:false or SKIPPED)\n${code}`).toBe(true)
}

describe('unconvertible filter fails closed (not open)', () => {
  it('fill layer with ["feature-state"] filter → filter: false (match nothing), NOT filter-less', () => {
    const warnings: string[] = []
    const out = convertLayer(
      { id: 'water', type: 'fill', source: 'osm', 'source-layer': 'water', filter: UNCONVERTIBLE, paint: { 'fill-color': '#00f' } } as never,
      warnings,
    )
    assertFailClosed(out)
    // filterToXgis's own "not supported" warning still surfaces the loss.
    expect(warnings.some(w => /feature-state/i.test(w))).toBe(true)
  })

  it('circle layer with unconvertible filter → fail closed', () => {
    const warnings: string[] = []
    const out = convertLayer(
      { id: 'pts', type: 'circle', source: 'osm', 'source-layer': 'poi', filter: UNCONVERTIBLE, paint: { 'circle-color': '#00f' } } as never,
      warnings,
    )
    assertFailClosed(out)
  })

  it('symbol layer with unconvertible filter → fail closed', () => {
    const warnings: string[] = []
    const out = convertLayer(
      { id: 'lbl', type: 'symbol', source: 'osm', 'source-layer': 'place', filter: UNCONVERTIBLE, layout: { 'text-field': '{name}' } } as never,
      warnings,
    )
    assertFailClosed(out)
  })

  it('heatmap layer with unconvertible filter → fail closed', () => {
    const warnings: string[] = []
    const out = convertLayer(
      { id: 'hm', type: 'heatmap', source: 'osm', 'source-layer': 'poi', filter: UNCONVERTIBLE } as never,
      warnings,
    )
    assertFailClosed(out)
  })

  it('regression: a CONVERTIBLE filter still emits its lowered form (not false)', () => {
    const warnings: string[] = []
    const out = convertLayer(
      { id: 'lakes', type: 'fill', source: 'osm', 'source-layer': 'water', filter: ['==', ['get', 'class'], 'lake'], paint: { 'fill-color': '#00f' } } as never,
      warnings,
    )
    expect(out).toContain('filter: .class == "lake"')
    expect(out).not.toContain('filter: false')
  })

  it('regression: a layer with NO filter authored emits no filter line', () => {
    const warnings: string[] = []
    const out = convertLayer(
      { id: 'plain', type: 'fill', source: 'osm', 'source-layer': 'water', paint: { 'fill-color': '#00f' } } as never,
      warnings,
    )
    expect(out).not.toContain('filter:')
  })

  it('regression: a wrapped-null filter ("no filter" per spec) still emits no filter line, NOT false', () => {
    // `["literal", null]` means "accept every feature" per Mapbox spec —
    // distinct from an unconvertible op. Must stay fail-OPEN here (it is
    // intentional, spec-faithful "no filter").
    const warnings: string[] = []
    const out = convertLayer(
      { id: 'all', type: 'fill', source: 'osm', 'source-layer': 'water', filter: ['literal', null] as unknown, paint: { 'fill-color': '#00f' } } as never,
      warnings,
    )
    expect(out).not.toContain('filter:')
  })
})
