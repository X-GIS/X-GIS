// #2326: expression-form ["in", needle, haystack] with a NON-literal
// haystack (a ["get", …] expression or a bare string) must lower to a
// membership / substring test, not to constant `false` / null.
// MapLibre's isExpressionFilter rule for `in` is
//   filter.length >= 3 && (typeof filter[1] !== 'string' || Array.isArray(filter[2]))
// so ["in", "foo", ["get", "name"]] IS the expression form (substring test).
// Pre-fix: only a `["literal", [...]]` haystack was recognised as the
// expression form, so any string second element fell to the legacy
// field-form branch, which rejected the non-scalar key and emitted
// `filter: false` — every feature dropped.

import { describe, it, expect } from 'vitest'
import { featureFilter } from '@maplibre/maplibre-gl-style-spec'
import { filterToXgis } from '../convert/expressions'
import { Lexer, Parser, lower, emitCommands, convertMapboxStyle } from '../index'
import { evaluate } from '../eval/evaluator'

function pullFilterAst(xgis: string): unknown {
  const tokens = new Lexer(xgis).tokenize()
  const ast = new Parser(tokens).parse()
  const cmds = emitCommands(lower(ast))
  return (cmds.shows[0] as unknown as { filterExpr: { ast: unknown } }).filterExpr.ast
}

function convertFilter(filter: unknown): string {
  return convertMapboxStyle({
    version: 8,
    sources: { v: { type: 'geojson', data: 'x.geojson' } },
    layers: [{ id: 'L', type: 'fill', source: 'v', filter, paint: { 'fill-color': '#000' } }],
  } as never)
}

describe('["in"] expression form with a non-literal haystack', () => {
  it('MapLibre oracle: ["in", "foo", ["get","name"]] is a substring test', () => {
    const f = featureFilter(['in', 'foo', ['get', 'name']] as never)
    const truth = f.filter(
      { zoom: 0 } as never,
      { type: 1, properties: { name: 'foobar' } } as never,
    )
    expect(truth).toBe(true)
  })

  it('["in", "foo", ["get","name"]] lowers to index_of(...) >= 0 with no warning', () => {
    const w: string[] = []
    const out = filterToXgis(['in', 'foo', ['get', 'name']], w)
    expect(w).toEqual([])
    expect(out).toBe('index_of("foo", .name) >= 0')
  })

  it('["in", ["get","x"], ["get","list"]] lowers to index_of(.x, .list) >= 0', () => {
    const w: string[] = []
    const out = filterToXgis(['in', ['get', 'x'], ['get', 'list']], w)
    expect(w).toEqual([])
    expect(out).toBe('index_of(.x, .list) >= 0')
  })

  it('["in", ["get","x"], "abc"] (string haystack) lowers to index_of(.x, "abc") >= 0', () => {
    const w: string[] = []
    const out = filterToXgis(['in', ['get', 'x'], 'abc'], w)
    expect(w).toEqual([])
    expect(out).toBe('index_of(.x, "abc") >= 0')
  })

  it('end-to-end: feature {name:"foobar"} passes the converted filter', () => {
    const xgis = convertFilter(['in', 'foo', ['get', 'name']])
    expect(xgis).not.toMatch(/filter:\s*false/)
    const ast = pullFilterAst(xgis)
    expect(evaluate(ast as never, { name: 'foobar' })).toBe(true)
    expect(evaluate(ast as never, { name: 'bar' })).toBe(false)
  })

  it('["in", "field", ["literal", "scalar"]] is expression form, not a legacy key', () => {
    // isExpressionFilter tests `Array.isArray(filter[2])` on the RAW
    // second element, and `["literal", "scalar"]` IS an array — so this
    // shape is the expression form: a substring test for "field" inside
    // the constant "scalar", which matches NO feature. Reading it as the
    // legacy one-key form would emit `.field == "scalar"` and keep
    // exactly the features MapLibre drops.
    const oracle = featureFilter(['in', 'field', ['literal', 'scalar']] as never)
    expect(
      oracle.filter({ zoom: 0 } as never, { type: 1, properties: { field: 'scalar' } } as never),
    ).toBe(false)

    const w: string[] = []
    const out = filterToXgis(['in', 'field', ['literal', 'scalar']], w)
    expect(w).toEqual([])
    expect(out).toBe('index_of("field", "scalar") >= 0')

    const ast = pullFilterAst(convertFilter(['in', 'field', ['literal', 'scalar']]))
    expect(evaluate(ast as never, { field: 'scalar' })).toBe(false)
  })
})
