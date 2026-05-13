// Pre-fix: `stroke-[<expr>]` bracket bindings fell through every named
// arm in lower.ts's binding-form handler. Mapbox's
// `paint.line-width: ["interpolate", …]` (which the converter emits as
// `stroke-[interpolate_exp(zoom, …)]`) silently collapsed to the
// default 1 px width. OFM Bright's entire highway network rendered as
// hair-thin lines and minor / path / track classes effectively
// disappeared on a beige background.
//
// Fix: route `stroke-[<expr>]` based on the inner expression's shape:
//   - interpolate-by-zoom colour stops → `strokeColor: 'zoom-interp'`
//   - interpolate-by-zoom numeric stops → `stroke.widthZoomStops`
//     (per-frame renderer interp against camera zoom — supersedes the
//     prior `widthExpr` path that baked at tile-decode zoom)
//   - any other numeric expression → `stroke.widthExpr` (per-feature
//     case / match width baked by the worker)

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle, Lexer, Parser, lower, emitCommands } from '../index'

describe('stroke binding routing — paint.line-width interpolate-by-zoom', () => {
  it('Mapbox line-width interpolate(zoom) lowers to stroke.widthZoomStops', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'road',
        type: 'line',
        source: 'v',
        'source-layer': 'transportation',
        paint: {
          'line-color': '#fff',
          'line-width': ['interpolate', ['exponential', 1.2], ['zoom'],
            13.5, 0,
            14, 2.5,
            20, 11.5],
        },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    const tokens = new Lexer(xgis).tokenize()
    const ast = new Parser(tokens).parse()
    const scene = lower(ast)
    const node = scene.renderNodes[0]
    // Pure zoom-driven width → goes via the `zoom-interpolated`
    // discriminant (per-frame renderer interp), NOT `data-driven`
    // (which would freeze the width at tile-decode zoom in the worker).
    expect(node!.stroke.width.kind).toBe('zoom-interpolated')
    if (node!.stroke.width.kind !== 'zoom-interpolated') return
    expect(node!.stroke.width.stops.length).toBe(3)
    expect(node!.stroke.width.base).toBeCloseTo(1.2, 4)
  })

  it('Mapbox line-width interpolate(zoom) threads through paintShapes.strokeWidth', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'road',
        type: 'line',
        source: 'v',
        'source-layer': 'transportation',
        paint: {
          'line-color': '#fff',
          'line-width': ['interpolate', ['exponential', 1.2], ['zoom'],
            14, 2.5, 20, 11.5],
        },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    const cmds = emitCommands(lower(new Parser(new Lexer(xgis).tokenize()).parse()))
    const s = cmds.shows[0]!
    expect(s.paintShapes.strokeWidth.kind).toBe('zoom-interpolated')
    expect((s.paintShapes.strokeWidth as { stops: unknown[] }).stops).toHaveLength(2)
    expect(s.strokeWidthExpr).toBeUndefined()
  })

  it('constant line-width still routes through scalar strokeWidth', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'road',
        type: 'line',
        source: 'v',
        'source-layer': 'transportation',
        paint: { 'line-color': '#fff', 'line-width': 3.5 },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    const cmds = emitCommands(lower(new Parser(new Lexer(xgis).tokenize()).parse()))
    const s = cmds.shows[0] as unknown as { strokeWidthExpr?: unknown; strokeWidth: number }
    expect(s.strokeWidth).toBe(3.5)
    expect(s.strokeWidthExpr).toBeUndefined()
  })

  it('Mapbox line-color interpolate-by-zoom routes to strokeColor zoom-interpolated', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'road',
        type: 'line',
        source: 'v',
        'source-layer': 'transportation',
        paint: {
          'line-color': ['interpolate', ['linear'], ['zoom'],
            10, '#fff',
            18, '#888'],
          'line-width': 2,
        },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    const scene = lower(new Parser(new Lexer(xgis).tokenize()).parse())
    const node = scene.renderNodes[0]
    // Until ColorValue gains a `zoom-interpolated` variant for stroke,
    // lower.ts collapses zoom-color stops to the last-stop constant.
    // Pin that behaviour so the regression is caught either way.
    expect(node!.stroke.color.kind).toBe('constant')
    if (node!.stroke.color.kind !== 'constant') return
    // 18% interpolation between #fff and #888 picks #888 (last stop).
    expect(node!.stroke.color.rgba[0]).toBeCloseTo(0x88 / 255, 2)
  })

  it('end-to-end: every OFM-Bright highway layer resolves a non-default width', () => {
    // Sanity that the fix actually unblocks the original OFM Bright
    // regression — every highway-* line layer should now carry EITHER
    // zoom stops (pure zoom-driven width — the common case in OFM) OR
    // a per-feature widthExpr (compound match()). The default 1 px
    // fallback means lower.ts silently dropped the binding.
    const style = require('./fixtures/openfreemap-bright.json')
    const xgis = convertMapboxStyle(style)
    const cmds = emitCommands(lower(new Parser(new Lexer(xgis).tokenize()).parse()))
    const offenders: string[] = []
    for (const s of cmds.shows) {
      if (!s.layerName || !s.layerName.startsWith('highway')) continue
      if (s.layerName.includes('shield')) continue
      if (s.layerName.includes('name')) continue
      if (s.layerName.includes('area')) continue
      const hasExpr = s.strokeWidthExpr !== undefined
      const swShape = s.paintShapes.strokeWidth
      const hasStops = swShape.kind === 'zoom-interpolated' && swShape.stops.length >= 2
      if (!hasExpr && !hasStops && s.strokeWidth === 1) {
        offenders.push(s.layerName)
      }
    }
    expect(offenders, `Line layers without resolved width: ${offenders.join(', ')}`).toEqual([])
  })
})
