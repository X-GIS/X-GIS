// Pin fail-CLOSED behaviour when an `["all", …]` filter drops a conjunct.
//
// Bug (A3): `all` means AND. When converting `["all", A, B]` where B is
// unconvertible (an op filterToXgis can't lower — e.g. `["distance", …]`),
// the converter dropped B and kept `A`. Dropping a conjunct from an AND
// makes the predicate MORE permissive — the layer then renders features
// the authored `all` constraint was meant to EXCLUDE (floods the layer).
//
// Fix: fail CLOSED. When `all` drops ≥1 conjunct, AND a literal `false`
// into the remaining chain so the whole predicate can never widen past
// the authored intent (consistent with #482's unconvertible-filter
// fail-closed). `any`/OR drops narrow the set (the safe direction), so
// they stay as-is.
//
// Fail-before: pre-fix `filterToXgis(["all", ==class, distance(geom)])`
// returned `.class == "park"` — the lowered predicate STILL MATCHES every
// park feature, including the ones the dropped conjunct would have
// excluded. The assertions below require the dropped-conjunct case to
// resolve to "match nothing" (contain a `false` term), NOT the bare
// widened conjunct.

import { describe, it, expect } from 'vitest'
import { filterToXgis } from '../convert/expressions'
import { convertLayer } from '../convert/layers'

// `["distance", <GeoJSON>]` — filterToXgis has no lowering for `distance`
// (KNOWN_UNSUPPORTED), so it returns null with a warning. The canonical
// unconvertible conjunct. (`within` was used here until it gained CPU
// support — see within-convert.test.ts.)
const UNCONVERTIBLE = [
  'distance',
  { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
] as unknown

describe('["all"] with a dropped conjunct fails closed (does not widen)', () => {
  it('all(convertible, unconvertible) → predicate cannot widen (AND-ed with false)', () => {
    const warnings: string[] = []
    const out = filterToXgis(
      ['all', ['==', ['get', 'class'], 'park'], UNCONVERTIBLE],
      warnings,
    )
    expect(out).not.toBeNull()
    const code = out as string
    // Fail-before: code === '.class == "park"' (the widened conjunct).
    // After: the chain must carry a `false` term so the whole predicate
    // can never accept the features the dropped conjunct would exclude.
    expect(code).toContain('false')
    // The surviving convertible conjunct is still present (we keep what
    // we can prove + AND false; we don't throw the whole filter away).
    expect(code).toContain('.class == "park"')
    // The drop is surfaced.
    expect(warnings.some(w => /\["all"\] dropped/.test(w))).toBe(true)
  })

  it('the widened conjunct alone is NOT the result (the actual bug shape)', () => {
    const warnings: string[] = []
    const out = filterToXgis(
      ['all', ['==', ['get', 'class'], 'park'], UNCONVERTIBLE],
      warnings,
    )
    // The exact bug: returning just `.class == "park"` (renders all parks
    // including the ones the dropped conjunct excluded). Must NOT happen.
    expect(out).not.toBe('.class == "park"')
  })

  it('fill layer with all(==, distance) filter → fail closed (false in filter line)', () => {
    const warnings: string[] = []
    const out = convertLayer(
      {
        id: 'parks', type: 'fill', source: 'osm', 'source-layer': 'landuse',
        filter: ['all', ['==', ['get', 'class'], 'park'], UNCONVERTIBLE],
        paint: { 'fill-color': '#0a0' },
      } as never,
      warnings,
    )
    expect(out).not.toBeNull()
    const code = out as string
    expect(/\bfilter:.*\bfalse\b/.test(code), `expected a fail-closed filter line\n${code}`).toBe(true)
  })

  it('regression: all() with ALL conjuncts convertible is unchanged (no false)', () => {
    const warnings: string[] = []
    const out = filterToXgis(
      ['all', ['==', ['get', 'class'], 'park'], ['==', ['get', 'area'], 'big']],
      warnings,
    )
    // parenthesize() wraps each comparison operand of the && chain.
    expect(out).toBe('(.class == "park") && (.area == "big")')
    expect(out).not.toContain('false')
    expect(warnings.some(w => /\["all"\] dropped/.test(w))).toBe(false)
  })

  it('regression: any() with a dropped arm stays as-is (OR narrows = safe direction)', () => {
    const warnings: string[] = []
    const out = filterToXgis(
      ['any', ['==', ['get', 'class'], 'park'], UNCONVERTIBLE],
      warnings,
    )
    // any drops narrow the accepted set (more restrictive) — the safe
    // direction — so the surviving arm is kept WITHOUT a false term.
    // (Single surviving arm, parenthesized by parenthesize().)
    expect(out).toBe('(.class == "park")')
    expect(out).not.toContain('false')
    expect(warnings.some(w => /\["any"\] dropped/.test(w))).toBe(true)
  })
})
