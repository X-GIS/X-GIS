// Pin compiler-side conversion of OFM road shield + road oneway
// patterns end-to-end. Runtime icon-along-line dispatch (iter 503)
// reads these ShowCommand fields:
//   - label.placement: 'line' (selects the line-label path)
//   - label.iconImage: string (constant) — direct dispatch
//   - label.iconImageExpr: { ast } (data-driven) — applyFeatureExprs evaluates
//
// User reported 2026-05-18 "도로 번호에 아이콘 안뜸" (road number
// icons not appearing). Iter 491 wired per-feature iconImageExpr
// dispatch for POINT placement; iter 503 extended dispatchIcon to
// LINE placement; this iter pins the compile-time half of both.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { optimize } from '../ir/optimize'
import { emitCommands } from '../ir/emit-commands'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function compileToShows(style: unknown): ReturnType<typeof emitCommands>['shows'] {
  const xgis = convertMapboxStyle(style as Parameters<typeof convertMapboxStyle>[0])
  const tokens = new Lexer(xgis).tokenize()
  const ast = new Parser(tokens).parse()
  const scene = lower(ast)
  return emitCommands(optimize(scene, ast)).shows
}

describe('road shield + oneway icon-along-line — compile-time wire-up', () => {
  it('OFM road_oneway shape: icon-only with symbol-placement=line', () => {
    const style = {
      version: 8,
      sources: { o: { type: 'vector', tiles: ['http://x/{z}/{x}/{y}.pbf'] } },
      layers: [{
        id: 'road_oneway',
        type: 'symbol',
        source: 'o',
        'source-layer': 'transportation',
        layout: {
          'icon-image': 'oneway',
          'icon-rotate': 90,
          'symbol-placement': 'line',
          'symbol-spacing': 75,
        },
        paint: { 'icon-opacity': 0.5 },
      }],
    }
    const shows = compileToShows(style)
    expect(shows.length).toBeGreaterThan(0)
    const s = shows.find(x => x.layerName === 'road_oneway')!
    expect(s).toBeDefined()
    expect(s.label).toBeDefined()
    expect(s.label!.placement).toBe('line')
    expect(s.label!.spacing).toBe(75)
    expect(s.label!.iconImage).toBe('oneway')
    expect(s.label!.iconRotate).toBe(90)
    expect(s.label!.iconOpacity).toBe(0.5)
  })

  it('OFM highway-shield-non-us shape: data-driven icon-image + symbol-placement=line', () => {
    // Mapbox `["concat", "road_", ["get", "ref_length"]]` evaluates
    // per-feature to "road_2" / "road_3" etc. — sprite atlas keys.
    const style = {
      version: 8,
      sources: { o: { type: 'vector', tiles: ['http://x/{z}/{x}/{y}.pbf'] } },
      layers: [{
        id: 'highway-shield-non-us',
        type: 'symbol',
        source: 'o',
        'source-layer': 'transportation_name',
        minzoom: 11,
        layout: {
          'icon-image': ['concat', 'road_', ['get', 'ref_length']],
          'symbol-placement': 'line',
          'symbol-spacing': 200,
          'text-field': ['to-string', ['get', 'ref']],
          'text-font': ['Noto Sans Regular'],
          'text-rotation-alignment': 'viewport',
          'text-size': 10,
        },
      }],
    }
    const shows = compileToShows(style)
    // sanitizeId converts `-` to `_` in layer names.
    const s = shows.find(x => (x.layerName ?? '').startsWith('highway_shield_non_us'))
    expect(s).toBeDefined()
    expect(s!.label).toBeDefined()
    expect(s!.label!.placement).toBe('line')
    expect(s!.label!.spacing).toBe(200)
    // Per-feature expression — runtime applyFeatureExprs evaluates
    // it against each feature's properties and writes the result
    // into effectiveDef.iconImage.
    expect((s!.label as { iconImage?: string }).iconImage).toBeUndefined()
    const ie = (s!.label as { iconImageExpr?: { ast: unknown } }).iconImageExpr
    expect(ie).toBeDefined()
    expect(ie!.ast).toBeDefined()
    // Viewport rotation → useTangentRotation=false → goes through
    // the emitLabelAlongSegment path (iter 503 added dispatchIcon
    // at the end of that helper).
    expect(s!.label!.rotationAlignment).toBe('viewport')
  })

  it('road_oneway icon-rotate=90 in IR (rotates the arrow 90° clockwise)', () => {
    const style = {
      version: 8,
      sources: { o: { type: 'vector', tiles: ['http://x/{z}/{x}/{y}.pbf'] } },
      layers: [{
        id: 'oneway', type: 'symbol', source: 'o', 'source-layer': 't',
        layout: { 'icon-image': 'oneway', 'icon-rotate': 90, 'symbol-placement': 'line' },
      }],
    }
    const shows = compileToShows(style)
    expect(shows[0]!.label!.iconRotate).toBe(90)
  })

  it('icon-only + line placement: label text is empty string (per converter contract)', () => {
    const style = {
      version: 8,
      sources: { o: { type: 'vector', tiles: ['http://x/{z}/{x}/{y}.pbf'] } },
      layers: [{
        id: 'iconly', type: 'symbol', source: 'o', 'source-layer': 't',
        layout: { 'icon-image': 'pin', 'symbol-placement': 'line' },
      }],
    }
    const shows = compileToShows(style)
    expect(shows[0]!.label).toBeDefined()
    // Empty-text label still triggers the line-label dispatch path
    // — addCurvedLineLabel returns early on empty text but the
    // subsequent dispatchIcon call (iter 503) still fires.
    expect(shows[0]!.label!.placement).toBe('line')
    expect(shows[0]!.label!.iconImage).toBe('pin')
  })

  it('icon-along-line for symbol-placement: ["step", ["zoom"], "point", N, "line"] — splits into _0 and _1', () => {
    // OFM step-placement convention. _0 = point at zoom < 11,
    // _1 = line at zoom ≥ 11. Both sub-layers carry icon-image so
    // shields work in both zoom ranges.
    const style = {
      version: 8,
      sources: { o: { type: 'vector', tiles: ['http://x/{z}/{x}/{y}.pbf'] } },
      layers: [{
        id: 'shield',
        type: 'symbol',
        source: 'o',
        'source-layer': 't',
        layout: {
          'icon-image': 'badge',
          'symbol-placement': ['step', ['zoom'], 'point', 11, 'line'],
          'text-field': '{ref}',
        },
      }],
    }
    const shows = compileToShows(style)
    // Step-placement splits into _0 / _1 sub-layers. layerName
    // carries the suffix.
    const shieldShows = shows.filter(s => (s.layerName ?? '').startsWith('shield'))
    expect(shieldShows.length).toBeGreaterThanOrEqual(2)
    const point = shieldShows.find(s => s.label?.placement !== 'line')
    const line = shieldShows.find(s => s.label?.placement === 'line')
    expect(point).toBeDefined()
    expect(line).toBeDefined()
    expect(point!.label!.iconImage).toBe('badge')
    expect(line!.label!.iconImage).toBe('badge')
  })
})
