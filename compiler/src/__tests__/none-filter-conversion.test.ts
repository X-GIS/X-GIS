import { describe, it, expect } from 'vitest'
import { filterToXgis } from '../convert/expressions'
import { convertMapboxStyle, Lexer, Parser, lower } from '../index'

// Legacy `["none", ...]` filter combinator (Mapbox GL JS v0/v1 spec):
// a feature passes only if NONE of the sub-filters match, i.e.
// `!(f1 || f2 || …)`. Before the fix it had no handler, so it fell
// through unconverted → filterToXgis returned null → the layer's filter
// failed CLOSED to `filter: false` and the layer rendered nothing.
describe('legacy none-filter conversion', () => {
  it('single child → negated predicate, no warning', () => {
    const w: string[] = []
    expect(filterToXgis(['none', ['==', 'cls', 'lake']], w)).toBe('!((.cls == "lake"))')
    expect(w).toEqual([])
  })

  it('multiple children → negated OR', () => {
    const w: string[] = []
    expect(filterToXgis(['none', ['==', 'cls', 'lake'], ['==', 'cls', 'river']], w))
      .toBe('!((.cls == "lake") || (.cls == "river"))')
    expect(w).toEqual([])
  })

  it('empty none → true (accepts every feature)', () => {
    expect(filterToXgis(['none'], [])).toBe('true')
  })

  it('composes with has', () => {
    expect(filterToXgis(['none', ['has', 'name']], [])).toBe('!((.name != null))')
  })

  it('fail-closed when a sub-filter cannot convert (cannot widen)', () => {
    const w: string[] = []
    const out = filterToXgis(['none', ['within', { type: 'Polygon', coordinates: [] }]], w)
    expect(out).toBe('!(true)') // → false: renders nothing rather than over-rendering
    expect(w.some((m) => m.includes('none'))).toBe(true)
  })

  it('end-to-end: a none-filter layer survives convert → reparse → lower', () => {
    const style = {
      version: 8,
      sources: { s: { type: 'vector', url: 'https://x/t.json' } },
      layers: [{
        id: 'not_lakes', type: 'fill', source: 's', 'source-layer': 'water',
        filter: ['none', ['==', 'cls', 'lake']], paint: { 'fill-color': '#00f' },
      }],
    }
    const xgis = convertMapboxStyle(style)
    expect(xgis).toContain('filter: !((.cls == "lake"))')
    const scene = lower(new Parser(new Lexer(xgis).tokenize()).parse())
    expect(scene.renderNodes.length).toBe(1)
  })
})
