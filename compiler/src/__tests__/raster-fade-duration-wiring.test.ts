// raster-fade-duration STYLE property wiring (#1257). The per-tile fade
// MECHANISM already existed (runtime raster-renderer.ts:299/394/810 +
// XGISMapOptions.rasterFadeDuration, map-types.ts:294) — what was missing was
// the Mapbox STYLE property: paint-raster.ts routed it straight to
// `surfaceIgnoredPaint(['raster-fade-duration'])`, so an authored value (a)
// never reached a utility, (b) never distinguished an authored 0 from
// "un-authored" (both were simply ignored — RasterShapes had no
// `fadeDurationMs` field to carry the distinction), and (c) always produced
// the generic "ignored paint properties: raster-fade-duration" warning
// regardless of the value's shape. The spec-coverage note ("X-GIS swaps
// tiles atomically; no fade") was also factually wrong once the fade
// mechanism landed.
//
// Mirrors raster-resampling-warn.test.ts (warnings/xgis-string surface) +
// raster-color-adjust-end-to-end.test.ts (compiled ShowCommand surface).

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

describe('raster-fade-duration — Mapbox style property → runtime wiring (#1257)', () => {
  // (a) FAIL-BEFORE on origin/main: paint-raster.ts:119 dropped the value into
  // surfaceIgnoredPaint — no utility was ever emitted, and RasterShapes had no
  // `fadeDurationMs` field to read (the compiled shape didn't exist).
  it('constant 500 → emits raster-fade-duration-500, paintShapes carries 500', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    const style = rasterLayer({ 'raster-fade-duration': 500 })
    const xgis = convertMapboxStyle(style as Parameters<typeof convertMapboxStyle>[0], {
      coverage,
    })
    expect(xgis).toContain('raster-fade-duration-500')
    const shows = compileToShows(style)
    expect(shows[0]!.paintShapes.raster.fadeDurationMs).toBe(500)
  })

  // (b) FAIL-BEFORE: same drop path as (a) — 0 is present (not undefined/null)
  // so surfaceIgnoredPaint warned on it too; there was no way to express "fade
  // disabled" (0) as distinct from "un-authored" (runtime default 300ms). 0
  // must reach the runtime AS 0, not silently upgrade to 300.
  it('constant 0 → emits raster-fade-duration-0, paintShapes carries 0 (≠ runtime default 300)', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    const style = rasterLayer({ 'raster-fade-duration': 0 })
    const xgis = convertMapboxStyle(style as Parameters<typeof convertMapboxStyle>[0], {
      coverage,
    })
    expect(xgis).toContain('raster-fade-duration-0')
    const shows = compileToShows(style)
    expect(shows[0]!.paintShapes.raster.fadeDurationMs).toBe(0)
  })

  // (c) FAIL-BEFORE: surfaceIgnoredPaint pushed "ignored paint properties:
  // raster-fade-duration" for ANY authored value (constant or not).
  it('no "ignored paint properties" warning for an authored constant', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    const style = rasterLayer({ 'raster-fade-duration': 500 })
    convertMapboxStyle(style as Parameters<typeof convertMapboxStyle>[0], { coverage })
    expect(coverage.warnings.some((w) => w.includes('ignored paint properties'))).toBe(false)
  })

  // (d) Absence must stay distinguishable from an authored 0. RasterShapes.
  // fadeDurationMs is a plain optional field (unlike hueRotate/etc, which are
  // PropertyShape<number> pre-filled with the spec default) — defaultRaster
  // Shapes() deliberately leaves it out, so an un-authored layer resolves
  // undefined and the runtime's own default (300ms) applies.
  it('un-authored → fadeDurationMs is undefined, not a default-filled shape', () => {
    const shows = compileToShows(rasterLayer({ 'raster-opacity': 1 }))
    expect(shows[0]!.paintShapes.raster.fadeDurationMs).toBeUndefined()
  })

  // (e) Non-constant (zoom/data-driven) forms aren't plumbed — same
  // constant-only contract as the raster colour-adjustment scalars
  // (addRasterScalar). Warns + drops instead of silently misreading an
  // expression as NaN.
  it('non-constant (expression) form warns and drops — no utility emitted', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    const style = rasterLayer({
      'raster-fade-duration': ['interpolate', ['linear'], ['zoom'], 0, 0, 10, 1000],
    })
    const xgis = convertMapboxStyle(style as Parameters<typeof convertMapboxStyle>[0], {
      coverage,
    })
    expect(xgis).not.toContain('raster-fade-duration-')
    expect(
      coverage.warnings.some(
        (w) => w.includes('raster-fade-duration') && w.includes('non-constant'),
      ),
    ).toBe(true)
    const shows = compileToShows(style)
    expect(shows[0]!.paintShapes.raster.fadeDurationMs).toBeUndefined()
  })
})
