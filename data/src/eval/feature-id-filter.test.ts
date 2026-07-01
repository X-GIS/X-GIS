// Mapbox `["id"]` accessor — resolves to `feature.id` (GeoJSON RFC
// 7946 §3.2). Same routing pattern as ["geometry-type"]: the
// converter lowers to `get("$featureId")` and the runtime filter-
// eval sites inject the synthetic `$featureId` prop from
// `feature.id` at evaluation time.

import { describe, it, expect } from 'vitest'
import { Lexer, Parser, lower, emitCommands, convertMapboxStyle } from '@xgis/compiler'
import { evalFilterExpr } from './filter-eval'

interface ShowLike {
  name?: string
  filterExpr: { ast: unknown } | null
}

// Mirror the runtime injection pattern: every filter-eval call site
// (feature-helpers.applyFilter, pmtiles-backend, mvt-worker) builds
// the props bag this way before evaluating.
const evalWithMeta = (
  ast: unknown,
  feature: { id?: string | number; geometry?: { type: string }; properties?: Record<string, unknown> },
): boolean => {
  const bag: Record<string, unknown> = { ...(feature.properties ?? {}) }
  if (feature.geometry) bag.$geometryType = feature.geometry.type
  if (feature.id !== undefined) bag.$featureId = feature.id
  return evalFilterExpr(ast, bag)
}

describe('feature-id filter routing — Mapbox ["id"] accessor', () => {
  const STYLE = {
    version: 8,
    sources: { v: { type: 'geojson', data: 'x.geojson' } },
    layers: [
      {
        id: 'select-by-id',
        type: 'fill',
        source: 'v',
        filter: ['==', ['id'], 42],
        paint: { 'fill-color': '#f00' },
      },
      {
        id: 'select-by-id-set',
        type: 'fill',
        source: 'v',
        filter: ['match', ['id'], [10, 20, 30], true, false],
        paint: { 'fill-color': '#0f0' },
      },
    ],
  }
  const xgis = convertMapboxStyle(STYLE as never)
  const tokens = new Lexer(xgis).tokenize()
  const ast = new Parser(tokens).parse()
  const cmds = emitCommands(lower(ast))
  const shows = cmds.shows as unknown as ShowLike[]

  it('converter no longer drops ["id"] — both shows get a filterExpr', () => {
    expect(shows.length).toBe(2)
    for (const s of shows) {
      expect(s.filterExpr, `missing filterExpr on ${s.name}`).toBeTruthy()
      expect(s.filterExpr!.ast).toBeTruthy()
    }
  })

  it('["==", ["id"], 42] matches the feature with id=42', () => {
    const filter = shows[0]!.filterExpr!.ast
    expect(evalWithMeta(filter, { id: 42 })).toBe(true)
    expect(evalWithMeta(filter, { id: 7 })).toBe(false)
    // Feature without an id: $featureId not injected, filter compares
    // null === 42 → false. Expected Mapbox parity.
    expect(evalWithMeta(filter, {})).toBe(false)
  })

  it('["match", ["id"], [10,20,30], true, false] matches the set', () => {
    const filter = shows[1]!.filterExpr!.ast
    expect(evalWithMeta(filter, { id: 10 })).toBe(true)
    expect(evalWithMeta(filter, { id: 20 })).toBe(true)
    expect(evalWithMeta(filter, { id: 30 })).toBe(true)
    expect(evalWithMeta(filter, { id: 11 })).toBe(false)
    expect(evalWithMeta(filter, {})).toBe(false)
  })

  it('string feature ids work too (GeoJSON allows string | number)', () => {
    const STYLE = {
      version: 8,
      sources: { v: { type: 'geojson', data: 'x.geojson' } },
      layers: [{
        id: 'X',
        type: 'fill',
        source: 'v',
        filter: ['==', ['id'], 'abc'],
        paint: { 'fill-color': '#f00' },
      }],
    }
    const xgis = convertMapboxStyle(STYLE as never)
    const tokens = new Lexer(xgis).tokenize()
    const cmds = emitCommands(lower(new Parser(tokens).parse()))
    const filter = (cmds.shows[0] as unknown as ShowLike).filterExpr!.ast
    expect(evalWithMeta(filter, { id: 'abc' })).toBe(true)
    expect(evalWithMeta(filter, { id: 'xyz' })).toBe(false)
  })

  it('combined ["id"] + ["geometry-type"] filter works', () => {
    const STYLE = {
      version: 8,
      sources: { v: { type: 'geojson', data: 'x.geojson' } },
      layers: [{
        id: 'X',
        type: 'fill',
        source: 'v',
        filter: ['all',
          ['==', ['geometry-type'], 'Polygon'],
          ['==', ['id'], 1],
        ],
        paint: { 'fill-color': '#f00' },
      }],
    }
    const xgis = convertMapboxStyle(STYLE as never)
    const tokens = new Lexer(xgis).tokenize()
    const cmds = emitCommands(lower(new Parser(tokens).parse()))
    const filter = (cmds.shows[0] as unknown as ShowLike).filterExpr!.ast
    expect(evalWithMeta(filter, { id: 1, geometry: { type: 'Polygon' }, properties: {} })).toBe(true)
    expect(evalWithMeta(filter, { id: 1, geometry: { type: 'LineString' }, properties: {} })).toBe(false)
    expect(evalWithMeta(filter, { id: 2, geometry: { type: 'Polygon' }, properties: {} })).toBe(false)
  })
})
