// End-to-end propagation test for fill-translate (Phase E.1, iter 501).
// Mapbox style → convertMapboxStyle → Lexer → Parser → lower →
// optimize → emitCommands → ShowCommand.fillTranslateX/Y.
// Runtime (vector-tile-renderer) reads these values to bake the
// NDC-per-pixel offset into uniform slots 46/47.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { optimize } from '../ir/optimize'
import { emitCommands } from '../ir/emit-commands'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function compileToShows(mapboxStyle: unknown): ReturnType<typeof emitCommands>['shows'] {
  const xgisSource = convertMapboxStyle(mapboxStyle as Parameters<typeof convertMapboxStyle>[0])
  const tokens = new Lexer(xgisSource).tokenize()
  const ast = new Parser(tokens).parse()
  const scene = lower(ast)
  return emitCommands(optimize(scene, ast)).shows
}

function fillLayer(id: string, paint: Record<string, unknown>): unknown {
  return {
    version: 8,
    sources: { t: { type: 'vector', tiles: ['x'] } },
    layers: [{ id, type: 'fill', source: 't', 'source-layer': 'p', paint }],
  }
}

describe('fill-translate — Mapbox → ShowCommand.fillTranslateX/Y', () => {
  it('absent fill-translate → both undefined (no offset)', () => {
    const shows = compileToShows(fillLayer('plain', { 'fill-color': '#888' }))
    expect(shows[0]!.fillTranslateX).toBeUndefined()
    expect(shows[0]!.fillTranslateY).toBeUndefined()
  })

  it('[0, 0] → both undefined (default, no-op)', () => {
    const shows = compileToShows(fillLayer('zero', {
      'fill-color': '#888', 'fill-translate': [0, 0],
    }))
    expect(shows[0]!.fillTranslateX).toBeUndefined()
    expect(shows[0]!.fillTranslateY).toBeUndefined()
  })

  it('[2, 3] → x=2, y=3', () => {
    const shows = compileToShows(fillLayer('pos', {
      'fill-color': '#888', 'fill-translate': [2, 3],
    }))
    expect(shows[0]!.fillTranslateX).toBe(2)
    expect(shows[0]!.fillTranslateY).toBe(3)
  })

  it('[-2, -2] (building-top OFM pseudo-3D roof offset) → x=-2, y=-2 via bracket form', () => {
    // Mapbox v8 wraps inner array as `["literal", [-2, -2]]`. The
    // bracket binding flows through label-numeric-binding for
    // signed values (parser-side `-` would split otherwise).
    const shows = compileToShows(fillLayer('roof', {
      'fill-color': '#f2eae2', 'fill-translate': [-2, -2],
    }))
    expect(shows[0]!.fillTranslateX).toBe(-2)
    expect(shows[0]!.fillTranslateY).toBe(-2)
  })

  it('only x non-zero: [4, 0] → x=4, y undefined', () => {
    const shows = compileToShows(fillLayer('xOnly', {
      'fill-color': '#888', 'fill-translate': [4, 0],
    }))
    expect(shows[0]!.fillTranslateX).toBe(4)
    expect(shows[0]!.fillTranslateY).toBeUndefined()
  })

  it('only y non-zero: [0, -5] → x undefined, y=-5', () => {
    const shows = compileToShows(fillLayer('yOnly', {
      'fill-color': '#888', 'fill-translate': [0, -5],
    }))
    expect(shows[0]!.fillTranslateX).toBeUndefined()
    expect(shows[0]!.fillTranslateY).toBe(-5)
  })

  it('v8 ["literal", [dx, dy]] wrap unwraps to constant', () => {
    const shows = compileToShows(fillLayer('v8wrap', {
      'fill-color': '#888', 'fill-translate': ['literal', [-1, 3]],
    }))
    expect(shows[0]!.fillTranslateX).toBe(-1)
    expect(shows[0]!.fillTranslateY).toBe(3)
  })

  it('zoom-interp form (OFM building-top) — per-frame PropertyShape (WS-1)', () => {
    // WS-1 — vec2 zoom-interp now resolves PER FRAME (was a last-stop
    // approximation, iter 508). The converter splits the [x,y]
    // interpolate into scalar x/y bracket bindings; lower builds
    // fillTranslate{X,Y}Shape; the runtime resolves each frame
    // (resolveShow → resolveNumberShape → VTR NDC bake). OFM
    // building-top: z=14 [0,0] → z=16 [-2,-2].
    const shows = compileToShows(fillLayer('zinterp', {
      'fill-color': '#f2eae2',
      'fill-translate': [
        'interpolate', ['linear'], ['zoom'],
        14, ['literal', [0, 0]],
        16, ['literal', [-2, -2]],
      ],
    }))
    // The constant scalar fields stay undefined — the shape carries the
    // value now (resolved per frame, not folded to the last stop).
    expect(shows[0]!.fillTranslateX).toBeUndefined()
    expect(shows[0]!.fillTranslateY).toBeUndefined()
    // Per-axis zoom-interpolated PropertyShapes with the authored stops.
    expect(shows[0]!.fillTranslateXShape).toEqual({
      kind: 'zoom-interpolated',
      stops: [{ zoom: 14, value: 0 }, { zoom: 16, value: -2 }],
      base: 1,
    })
    expect(shows[0]!.fillTranslateYShape).toEqual({
      kind: 'zoom-interpolated',
      stops: [{ zoom: 14, value: 0 }, { zoom: 16, value: -2 }],
      base: 1,
    })
  })

  it('fill-translate does NOT appear in ignored-paint warning list (iter 501 removed it)', () => {
    const xgis = convertMapboxStyle(fillLayer('w', {
      'fill-color': '#888', 'fill-translate': [-2, -2],
    }) as Parameters<typeof convertMapboxStyle>[0])
    // ignored paint properties: fill-translate would surface if a
    // regression re-added it to the surfaceIgnoredPaint list at
    // paint.ts:133.
    expect(xgis).not.toContain('ignored paint properties: fill-translate')
  })
})
