// End-to-end propagation test for the raster fragment colour-adjustment
// cluster (Phase S Batch 3): raster-hue-rotate / raster-brightness-min /
// raster-brightness-max / raster-saturation / raster-contrast +
// raster-resampling (+ MapLibre alias `resampling`).
//
// Mapbox style → convertMapboxStyle → Lexer → Parser → lower → optimize →
// emitCommands → ShowCommand.paintShapes.raster. The runtime (RasterRenderer)
// resolves each shape per frame and feeds the raster fragment shader; the
// DEFAULTS (hue 0 / brightness 0..1 / saturation 0 / contrast 0 / linear)
// MUST reproduce today's behaviour (a hard no-op).

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
  return emitCommands(optimize(scene)).shows
}

function rasterLayer(paint: Record<string, unknown>): unknown {
  return {
    version: 8,
    sources: { r: { type: 'raster', tiles: ['https://example.com/{z}/{x}/{y}.png'] } },
    layers: [{ id: 'r', type: 'raster', source: 'r', paint }],
  }
}

function constVal(shape: { kind: string; value?: number }): number {
  expect(shape.kind).toBe('constant')
  return shape.value as number
}

describe('raster colour adjustments — Mapbox → ShowCommand.paintShapes.raster', () => {
  it('DEFAULT (no raster-* colour paint) → spec-default no-op shapes', () => {
    const shows = compileToShows(rasterLayer({ 'raster-opacity': 1 }))
    const r = shows[0]!.paintShapes.raster
    // These exact defaults are what reproduce today's behaviour byte-for-byte.
    expect(constVal(r.hueRotate)).toBe(0)
    expect(constVal(r.brightnessMin)).toBe(0)
    expect(constVal(r.brightnessMax)).toBe(1)
    expect(constVal(r.saturation)).toBe(0)
    expect(constVal(r.contrast)).toBe(0)
    expect(r.resamplingNearest).toBe(false)
  })

  it('positive constants → carried as constant shapes', () => {
    const shows = compileToShows(
      rasterLayer({
        'raster-hue-rotate': 90,
        'raster-brightness-min': 0.2,
        'raster-brightness-max': 0.8,
      }),
    )
    const r = shows[0]!.paintShapes.raster
    expect(constVal(r.hueRotate)).toBe(90)
    expect(constVal(r.brightnessMin)).toBeCloseTo(0.2)
    expect(constVal(r.brightnessMax)).toBeCloseTo(0.8)
  })

  it('negative constants (saturation / contrast) → carried via bracket form', () => {
    const shows = compileToShows(
      rasterLayer({
        'raster-saturation': -0.5,
        'raster-contrast': -0.3,
      }),
    )
    const r = shows[0]!.paintShapes.raster
    expect(constVal(r.saturation)).toBeCloseTo(-0.5)
    expect(constVal(r.contrast)).toBeCloseTo(-0.3)
  })

  it('raster-resampling: nearest → resamplingNearest true', () => {
    const shows = compileToShows(rasterLayer({ 'raster-resampling': 'nearest' }))
    expect(shows[0]!.paintShapes.raster.resamplingNearest).toBe(true)
  })

  it('raster-resampling: linear (default) → resamplingNearest false (no-op)', () => {
    const shows = compileToShows(rasterLayer({ 'raster-resampling': 'linear' }))
    expect(shows[0]!.paintShapes.raster.resamplingNearest).toBe(false)
  })

  it('MapLibre alias `resampling: nearest` → resamplingNearest true', () => {
    const shows = compileToShows(rasterLayer({ resampling: 'nearest' }))
    expect(shows[0]!.paintShapes.raster.resamplingNearest).toBe(true)
  })

  it('the converter emits the colour utilities (no "ignored paint" note)', () => {
    const xgis = convertMapboxStyle(
      rasterLayer({
        'raster-hue-rotate': 45,
        'raster-saturation': 0.5,
        'raster-contrast': 0.5,
        'raster-brightness-min': 0.1,
        'raster-brightness-max': 0.9,
        'raster-resampling': 'nearest',
      }) as Parameters<typeof convertMapboxStyle>[0],
    )
    expect(xgis).toContain('raster-hue-rotate-45')
    expect(xgis).toContain('raster-saturation-0.5')
    expect(xgis).toContain('raster-resampling-nearest')
    expect(xgis).not.toContain('ignored paint properties: raster-hue-rotate')
  })
})
