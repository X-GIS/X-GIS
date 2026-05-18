// End-to-end propagation test for line-gap-width (Phase E.2).
// Mapbox style → convertMapboxStyle → Lexer → Parser → lower →
// optimize → emitCommands → ShowCommand.strokeGapWidth.
//
// Runtime double-draw (iter 499) reads show.strokeGapWidth at
// per-show writeLayerSlot time and triggers two drawSegments per
// tile when > 0. This suite gates the compile-time half of the
// pipeline.

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

function lineLayer(id: string, paint: Record<string, unknown>): unknown {
  return {
    version: 8,
    sources: { t: { type: 'vector', tiles: ['x'] } },
    layers: [{ id, type: 'line', source: 't', 'source-layer': 'p', paint }],
  }
}

describe('line-gap-width — Mapbox → ShowCommand.strokeGapWidth', () => {
  it('absent gap → strokeGapWidth undefined (single-line path)', () => {
    const shows = compileToShows(lineLayer('plain', {
      'line-color': '#666', 'line-width': 2,
    }))
    expect(shows[0]!.strokeGapWidth).toBeUndefined()
  })

  it('line-gap-width: 6 → strokeGapWidth: 6', () => {
    const shows = compileToShows(lineLayer('casing', {
      'line-color': '#666', 'line-width': 1, 'line-gap-width': 6,
    }))
    expect(shows[0]!.strokeGapWidth).toBe(6)
  })

  it('line-gap-width: 0 → strokeGapWidth undefined (no-op default)', () => {
    // Default 0 → no double-draw needed; converter intentionally
    // skips emit so the legacy single-line path stays unchanged.
    const shows = compileToShows(lineLayer('zero-gap', {
      'line-color': '#666', 'line-width': 1, 'line-gap-width': 0,
    }))
    expect(shows[0]!.strokeGapWidth).toBeUndefined()
  })

  it('zoom-interp line-gap-width emits bracket form but currently drops at lower', () => {
    // Compiler emits `stroke-gap-[interp]` for zoom-interp. lower.ts
    // has no binding-form arm yet, so the value falls to undefined.
    // Pin the current behaviour; full zoom-interp lower lands later
    // (parallel to addStrokeWidth's `stroke-[interp]` handling).
    const shows = compileToShows(lineLayer('zinterp', {
      'line-color': '#666', 'line-width': 1,
      'line-gap-width': ['interpolate', ['linear'], ['zoom'], 12, 0, 20, 6],
    }))
    expect(shows[0]!.strokeGapWidth).toBeUndefined()
  })

  it('line-gap-width does NOT appear in the surfaceIgnoredPaint warning list', () => {
    // Iter 498 removed it from the ignored list. A regression that
    // re-adds it would surface as the warning string below.
    const xgis = convertMapboxStyle(lineLayer('w', {
      'line-color': '#666', 'line-gap-width': 6,
    }) as Parameters<typeof convertMapboxStyle>[0])
    expect(xgis).not.toContain('ignored paint properties: line-gap-width')
    expect(xgis).not.toContain('line-gap-width, ')
  })

  it('OFM waterway_tunnel-shape converts cleanly (zoom-interp not lossy on the warning side)', () => {
    // Lossy reasons reflect IR lossiness; bracket-form drop at lower
    // is silent (no warning). Coverage should NOT flag it.
    const xgis = convertMapboxStyle(lineLayer('waterway_tunnel', {
      'line-color': '#a0c8f0',
      'line-dasharray': [3, 3],
      'line-gap-width': ['interpolate', ['linear'], ['zoom'], 12, 0, 20, 6],
      'line-opacity': 1,
      'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 8, 1, 20, 2],
    }) as Parameters<typeof convertMapboxStyle>[0])
    expect(xgis).toContain('stroke-gap-[')  // bracket form lands in xgis
    expect(xgis).not.toContain('line-gap-width: non-constant')
  })
})
