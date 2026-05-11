// Regression: Mapbox ["geometry-type"] filters must route features
// correctly through the converter + filter-eval pipeline.
//
// Original failure: convertMapboxStyle dropped `["geometry-type"]`
// to `null`, which then bubbled through the parent match into a
// no-filter layer. OFM Bright's water_name source layer has two
// sibling layers split by geometry-type (`water_name_point_label`
// for Point/MultiPoint, `water_name_line_label` for LineString).
// With the filter dropped, BOTH layers iterated EVERY water_name
// feature, so:
//   1. Point features got labeled twice (point + along-path).
//   2. LineString features got labeled as points at the wrong
//      anchor (the centroid of pointVertices).
//
// Fix: ["geometry-type"] now lowers to `get("$geometryType")` and
// the runtime injects `$geometryType` from `feature.geometry.type`
// into the props bag at filter-eval time.

import { describe, it, expect } from 'vitest'
import { Lexer, Parser, lower, emitCommands, convertMapboxStyle } from '@xgis/compiler'
import { evalFilterExpr } from './filter-eval'

interface ShowLike {
  name?: string
  sourceLayer?: string
  filterExpr: { ast: unknown } | null
}

// The two water_name layers as they appear in OFM Bright. Inlined
// so the test is self-contained.
const WATER_NAME_STYLE = {
  version: 8,
  sources: {
    openmaptiles: { type: 'vector', url: 'https://example/planet' },
  },
  layers: [
    {
      id: 'water_name_point_label',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'water_name',
      filter: ['match', ['geometry-type'], ['MultiPoint', 'Point'], true, false],
      layout: { 'text-field': ['get', 'name'] },
    },
    {
      id: 'water_name_line_label',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'water_name',
      filter: ['match', ['geometry-type'], ['LineString'], true, false],
      layout: { 'text-field': ['get', 'name'], 'symbol-placement': 'line' },
    },
  ],
}

function buildShows(): ShowLike[] {
  const xgis = convertMapboxStyle(WATER_NAME_STYLE as never)
  const tokens = new Lexer(xgis).tokenize()
  const ast = new Parser(tokens).parse()
  const scene = lower(ast)
  const cmds = emitCommands(scene)
  return cmds.shows as unknown as ShowLike[]
}

// Mirror the runtime filter eval path: pmtiles-backend / mvt-worker /
// feature-helpers inject `$geometryType` from `feature.geometry.type`
// before calling evalFilterExpr.
const evalWithGeom = (
  ast: unknown,
  geom: { type: string } | undefined,
  props: Record<string, unknown>,
): boolean =>
  evalFilterExpr(ast, geom ? { ...props, $geometryType: geom.type } : props)

describe('geometry-type filter routing — OFM Bright water_name layers', () => {
  const shows = buildShows()

  it('emits two shows with non-null filterExpr (drop bug regression)', () => {
    expect(shows.length).toBeGreaterThanOrEqual(2)
    for (const s of shows) {
      expect(s.filterExpr, `${s.name} missing filterExpr`).toBeTruthy()
      expect(s.filterExpr!.ast, `${s.name} ast is null`).toBeTruthy()
    }
  })

  it('Point feature routes to water_name_point_label only', () => {
    const matched = shows.filter(s =>
      evalWithGeom(s.filterExpr!.ast, { type: 'Point' }, { name: 'Lake Tahoe' }))
    expect(matched.length).toBe(1)
    expect(matched[0]!.sourceLayer).toBe('water_name')
  })

  it('MultiPoint feature routes to water_name_point_label only', () => {
    const matched = shows.filter(s =>
      evalWithGeom(s.filterExpr!.ast, { type: 'MultiPoint' }, { name: 'X' }))
    expect(matched.length).toBe(1)
  })

  it('LineString feature routes to water_name_line_label only', () => {
    const matched = shows.filter(s =>
      evalWithGeom(s.filterExpr!.ast, { type: 'LineString' }, { name: 'Mississippi' }))
    expect(matched.length).toBe(1)
  })

  it('Polygon water_name feature matches neither layer (Mapbox parity)', () => {
    const matched = shows.filter(s =>
      evalWithGeom(s.filterExpr!.ast, { type: 'Polygon' }, { name: 'X' }))
    expect(matched.length).toBe(0)
  })

  it('feature without geometry rejected (no $geometryType injected)', () => {
    const matched = shows.filter(s =>
      evalWithGeom(s.filterExpr!.ast, undefined, { name: 'X' }))
    expect(matched.length).toBe(0)
  })
})

describe('hand-written xgis: get("$geometryType") evaluator round-trip', () => {
  const src = `
source openmaptiles { type: pmtiles, url: "x.pmtiles" }
layer point_only {
  source: openmaptiles
  sourceLayer: "water_name"
  filter: get("$geometryType") == "Point"
  | label-[.name]
}
`
  const tokens = new Lexer(src).tokenize()
  const ast = new Parser(tokens).parse()
  const scene = lower(ast)
  const cmds = emitCommands(scene)
  const shows = cmds.shows as unknown as ShowLike[]

  it('the get("$geometryType") accessor evaluates via injected props', () => {
    expect(shows.length).toBe(1)
    const ast = shows[0]!.filterExpr!.ast
    expect(evalWithGeom(ast, { type: 'Point' }, {})).toBe(true)
    expect(evalWithGeom(ast, { type: 'LineString' }, {})).toBe(false)
    expect(evalWithGeom(ast, undefined, {})).toBe(false)
  })
})
