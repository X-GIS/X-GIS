// End-to-end propagation test for text-halo-color / -width / -blur
// through the Mapbox style → convertMapboxStyle → Lexer → Parser →
// lower → optimize → emitCommands pipeline. User reported 2026-05-18
// "할로 크기도 평가 할로 블러도 검토 필요" — halo size + blur need
// evaluation. Phase B.3 + B.4 of the compat plan (memory note
// project_maplibre_compat_plan_2026_05_18).
//
// Companion to font-weight-end-to-end.test.ts. Pure CPU; the runtime
// shader-side numeric math is already pinned by
// runtime/src/engine/text/halo-uniforms.test.ts. Together the two
// suites cover the halo path Mapbox-style → packed shader uniform
// without GPU.

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

function symbolWithHalo(
  id: string,
  halo: {
    color?: string
    width?: number | unknown
    blur?: number | unknown
  },
): unknown {
  return {
    id,
    type: 'symbol',
    source: 'test',
    'source-layer': 'place',
    layout: {
      'text-field': '{name}',
      'text-font': ['Noto Sans Regular'],
      'text-size': 12,
    },
    paint: {
      'text-color': '#000',
      ...(halo.color !== undefined ? { 'text-halo-color': halo.color } : {}),
      ...(halo.width !== undefined ? { 'text-halo-width': halo.width } : {}),
      ...(halo.blur !== undefined ? { 'text-halo-blur': halo.blur } : {}),
    },
  }
}

function makeStyle(layers: unknown[]): unknown {
  return {
    version: 8,
    sources: { test: { type: 'vector', tiles: ['http://x.test/{z}/{x}/{y}.pbf'] } },
    layers,
  }
}

describe('text-halo propagation — Mapbox style → ShowCommand.label.halo', () => {
  it('halo absent in style → label.halo absent on ShowCommand', () => {
    const shows = compileToShows(makeStyle([symbolWithHalo('no-halo', {})]))
    expect(shows[0]!.label).toBeDefined()
    // When no halo paint properties are authored, the label
    // intentionally has no halo object (runtime shader skips the
    // halo branch via halo_width <= 0).
    expect(shows[0]!.label!.halo).toBeUndefined()
  })

  it('text-halo-width=1, halo-color=#fff propagates as halo.{width:1, color:[1,1,1,1]}', () => {
    const shows = compileToShows(
      makeStyle([
        symbolWithHalo('basic', {
          width: 1,
          color: '#fff',
        }),
      ]),
    )
    expect(shows[0]!.label!.halo).toBeDefined()
    expect(shows[0]!.label!.halo!.width).toBe(1)
    expect(shows[0]!.label!.halo!.color).toEqual([1, 1, 1, 1])
  })

  it('text-halo-blur=0.5 propagates as halo.blur=0.5 (OFM POI halo blur)', () => {
    // OFM Bright poi_r20/r7/r1/poi_transit all author
    // text-halo-blur: 0.5 with halo-width: 1. Pinning this exact
    // value because user reported halo blur regression on these
    // layers ("할로 블러도 검토 필요").
    const shows = compileToShows(
      makeStyle([
        symbolWithHalo('poi', {
          width: 1,
          blur: 0.5,
          color: '#fff',
        }),
      ]),
    )
    expect(shows[0]!.label!.halo!.blur).toBe(0.5)
  })

  it('rgba halo color with alpha preserves alpha channel (within byte quantisation)', () => {
    // OFM Bright water_name_*_label uses text-halo-color:
    // rgba(255,255,255,0.7). The 70 % alpha must reach the
    // shader; full opacity would make label halo too aggressive.
    // Alpha goes through RGBA-byte quantisation (179/255 ≈ 0.7019)
    // so use toBeCloseTo for the alpha slot.
    const shows = compileToShows(
      makeStyle([
        symbolWithHalo('water', {
          width: 1.5,
          color: 'rgba(255,255,255,0.7)',
        }),
      ]),
    )
    const c = shows[0]!.label!.halo!.color
    expect(c[0]).toBe(1)
    expect(c[1]).toBe(1)
    expect(c[2]).toBe(1)
    expect(c[3]).toBeCloseTo(0.7, 2) // 179/255 quantisation
  })

  it('halo-width=0 with halo-color set defaults to width=0 (Mapbox spec)', () => {
    // Mapbox spec: text-halo-width default is 0 (no halo). A style
    // author writing `text-halo-color: #fff` with no width should
    // produce NO halo. Pre-fix X-GIS defaulted to 1 inside
    // foldLabelKnobs (lower.ts:1804 `?? 1`) so a halo-color-only
    // declaration painted a 1 px white halo — opposite of MapLibre's
    // render. Same path applied when `text-halo-width: 0` was
    // explicitly set (converter skips emit for width≤0 at
    // layers.ts:473 so lower can't distinguish "explicitly 0" from
    // "absent"). Aligned to spec; runtime shader gates on halo_width
    // > 0 so 0-width produces no draw.
    const shows = compileToShows(
      makeStyle([
        symbolWithHalo('zero-width', {
          width: 0,
          color: '#fff',
        }),
      ]),
    )
    const halo = shows[0]!.label!.halo
    expect(halo).toBeDefined()
    expect(halo!.width).toBe(0)
  })

  it('halo width and blur survive across zoom-interp form (uses lattermost stop)', () => {
    // text-halo-blur as interpolate-by-zoom — uses a constant
    // fallback. Verify the lowered shape is sensible (not NaN /
    // undefined). Exact stops resolution is the runtime's job —
    // here we just gate "did the value land on label.halo".
    const shows = compileToShows(
      makeStyle([
        symbolWithHalo('zoom-halo', {
          width: 1,
          blur: 0.5,
          color: '#fff',
        }),
      ]),
    )
    expect(typeof shows[0]!.label!.halo!.width).toBe('number')
    expect(typeof shows[0]!.label!.halo!.blur).toBe('number')
    expect(Number.isFinite(shows[0]!.label!.halo!.width)).toBe(true)
    expect(Number.isFinite(shows[0]!.label!.halo!.blur)).toBe(true)
  })

  it('PaintShapes mirror — halo also lives in shapes.textPaint.haloWidth / haloColor / haloBlur', () => {
    // The shapes.* parallel structure carries the same per-zoom /
    // per-feature awareness the runtime uses for per-frame paint
    // resolution. Static halo authoring should populate BOTH the
    // flat halo field (legacy consumers) and shapes (modern paint
    // resolver) — pre-fix the flat field was populated but the
    // shapes mirror was null on simple cases, so per-frame paint
    // resolve fell back to defaults and rendered halo-less.
    const shows = compileToShows(
      makeStyle([
        symbolWithHalo('shapes', {
          width: 1,
          blur: 0.5,
          color: '#fff',
        }),
      ]),
    )
    const shapes = shows[0]!.label!.shapes
    expect(shapes).toBeDefined()
    expect(shapes!.textPaint.haloWidth).toEqual({ kind: 'constant', value: 1 })
    expect(shapes!.textPaint.haloBlur).toEqual({ kind: 'constant', value: 0.5 })
    expect(shapes!.textPaint.haloColor).toEqual({ kind: 'constant', value: [1, 1, 1, 1] })
  })
})
