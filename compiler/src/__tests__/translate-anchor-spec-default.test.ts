// #2170 — `*-translate-anchor` spec DEFAULT is "map", not "viewport".
//
// Measured from the pinned oracle (@maplibre/maplibre-gl-style-spec
// 24.8.5, reference/v8.json): paint_fill.fill-translate-anchor,
// paint_line.line-translate-anchor, paint_circle.circle-translate-anchor
// and paint_fill-extrusion.fill-extrusion-translate-anchor all carry
// default='map', values=['map','viewport'].
//
// The converter used to gate the anchor emit on an EXPLICIT 'map', so a
// layer authoring `*-translate` with NO anchor fell through to the
// screen-space (viewport) path — byte-identical to what an explicit
// 'viewport' emits, and with no warning on any route. The absent case is
// the COMMON case in real styles, so this silently mis-rendered the spec
// default under a nonzero bearing.
//
// These arms must DISTINGUISH: the two negative controls below stay green
// before AND after, so an emitter made unconditional (rather than
// spec-default-aware) turns them red instead of sliding through.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { optimize } from '../ir/optimize'
import { emitCommands } from '../ir/emit-commands'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function convert(style: unknown): string {
  return convertMapboxStyle(style as Parameters<typeof convertMapboxStyle>[0])
}

/** Warnings ride `coverage.warnings` — there is NO top-level `warnings`
 *  option, and passing one is silently ignored (an excess property that
 *  yields an empty array, i.e. a blind instrument that reports zero). */
function convertWarnings(style: unknown): string[] {
  const coverage = { sources: [], layers: [], warnings: [] as string[] }
  convertMapboxStyle(style as Parameters<typeof convertMapboxStyle>[0], { coverage })
  return coverage.warnings
}

function compileToShows(style: unknown): ReturnType<typeof emitCommands>['shows'] {
  const tokens = new Lexer(convert(style)).tokenize()
  return emitCommands(optimize(lower(new Parser(tokens).parse()))).shows
}

function layerStyle(type: string, paint: Record<string, unknown>): unknown {
  return {
    version: 8,
    sources: { t: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
    layers: [{ id: 'l', type, source: 't', 'source-layer': 'p', paint }],
  }
}

// ── The committed-corpus witness (load-bearing fail-before) ──

describe('#2170 — real openfreemap-bright.json honours the spec default', () => {
  it('building-top authors fill-translate with NO anchor → fill-translate-anchor-map', () => {
    const fixture = fileURLToPath(new URL('./fixtures/openfreemap-bright.json', import.meta.url))
    const bright = JSON.parse(readFileSync(fixture, 'utf8')) as Record<string, unknown>

    // Guard the premise: if the fixture ever gains an explicit anchor this
    // assertion would pass for the wrong reason.
    const layers = bright.layers as Array<Record<string, unknown>>
    const buildingTop = layers.find((l) => l.id === 'building-top')!
    const paint = buildingTop.paint as Record<string, unknown>
    expect(paint['fill-translate'], 'fixture must author fill-translate').toBeDefined()
    expect(
      paint['fill-translate-anchor'],
      'fixture must NOT author an explicit anchor — that is the whole point',
    ).toBeUndefined()

    const src = convert(bright)
    const line = src.split('\n').find((l) => l.includes('fill-translate-x-'))!
    expect(line, 'building-top utility line').toContain('fill-translate-anchor-map')
  })
})

// ── Absent anchor ⇒ spec default 'map', per layer type ──

describe('#2170 — absent anchor emits the map marker (fill / line / fill-extrusion)', () => {
  it('fill: fill-translate with no anchor → fill-translate-anchor-map', () => {
    const src = convert(layerStyle('fill', { 'fill-color': '#888', 'fill-translate': [2, 3] }))
    expect(src).toContain('fill-translate-anchor-map')
  })

  it('line: line-translate with no anchor → stroke-translate-anchor-map', () => {
    const src = convert(
      layerStyle('line', { 'line-color': '#888', 'line-width': 2, 'line-translate': [4, 1] }),
    )
    expect(src).toContain('stroke-translate-anchor-map')
  })

  it('fill-extrusion: fill-extrusion-translate with no anchor → fill-translate-anchor-map', () => {
    const src = convert(
      layerStyle('fill-extrusion', {
        'fill-extrusion-color': '#888',
        'fill-extrusion-height': 10,
        'fill-extrusion-translate': [3, 4],
      }),
    )
    expect(src).toContain('fill-translate-anchor-map')
  })

  it('reaches the renderer contract: ShowCommand.fillTranslateAnchorMap === true', () => {
    const shows = compileToShows(
      layerStyle('fill', { 'fill-color': '#888', 'fill-translate': [2, 3] }),
    )
    expect(shows[0]!.fillTranslateAnchorMap).toBe(true)
    // The offset itself is untouched — only its anchor space changes.
    expect(shows[0]!.fillTranslateX).toBe(2)
    expect(shows[0]!.fillTranslateY).toBe(3)
  })
})

// ── NEGATIVE CONTROLS — green before AND after ──
//
// If the fix simply made the emitter unconditional these go red, which is
// exactly what distinguishes "honours the spec default" from "always emits".

describe('#2170 negative controls — the marker stays conditional', () => {
  it('explicit viewport + translate → NO marker (author opted out of the default)', () => {
    const src = convert(
      layerStyle('fill', {
        'fill-color': '#888',
        'fill-translate': [2, 3],
        'fill-translate-anchor': 'viewport',
      }),
    )
    expect(src).not.toContain('fill-translate-anchor-map')
  })

  it('explicit viewport → ShowCommand.fillTranslateAnchorMap stays undefined', () => {
    const shows = compileToShows(
      layerStyle('fill', {
        'fill-color': '#888',
        'fill-translate': [2, 3],
        'fill-translate-anchor': 'viewport',
      }),
    )
    expect(shows[0]!.fillTranslateAnchorMap).toBeUndefined()
  })

  it('NO translate at all → NO marker (the anchor is a no-op without an offset)', () => {
    const src = convert(layerStyle('fill', { 'fill-color': '#888' }))
    expect(src).not.toContain('fill-translate-anchor')
  })

  it('line with no translate → NO stroke marker', () => {
    const src = convert(layerStyle('line', { 'line-color': '#888', 'line-width': 2 }))
    expect(src).not.toContain('stroke-translate-anchor')
  })

  it('explicit viewport line + translate → NO stroke marker', () => {
    const src = convert(
      layerStyle('line', {
        'line-color': '#888',
        'line-width': 2,
        'line-translate': [4, 1],
        'line-translate-anchor': 'viewport',
      }),
    )
    expect(src).not.toContain('stroke-translate-anchor-map')
  })
})

// ── circle: the map arm does NOT exist, so the default is a real gap ──
//
// There is no circle-translate-anchor-map utility and no runtime wiring
// (grep: no circleTranslateAnchorMap anywhere) — the point renderer always
// applies circle-translate in viewport/NDC space. So for circle the spec
// default is UNIMPLEMENTED, and the honest conversion surfaces it exactly
// the way an explicit 'map' already does: a warning.

describe('#2170 — circle: absent anchor is the unimplemented spec default, so it warns', () => {
  const circlePaint = (extra: Record<string, unknown> = {}) => ({
    'circle-radius': 3,
    'circle-color': '#fff',
    'circle-translate': [1, 1],
    ...extra,
  })

  it('circle-translate with no anchor → warns (spec default map is not implemented)', () => {
    const warnings = convertWarnings(layerStyle('circle', circlePaint()))
    expect(
      warnings.find((w) => w.includes('circle-translate-anchor')),
      `expected a gap warning, got: ${JSON.stringify(warnings)}`,
    ).toBeDefined()
  })

  it('explicit map → still warns (unchanged — the arm does not exist)', () => {
    const warnings = convertWarnings(
      layerStyle('circle', circlePaint({ 'circle-translate-anchor': 'map' })),
    )
    expect(warnings.find((w) => w.includes('circle-translate-anchor'))).toBeDefined()
  })

  it('NEGATIVE CONTROL — explicit viewport → no warning (that mode IS honoured)', () => {
    const warnings = convertWarnings(
      layerStyle('circle', circlePaint({ 'circle-translate-anchor': 'viewport' })),
    )
    expect(warnings.find((w) => w.includes('circle-translate-anchor'))).toBeUndefined()
  })

  it('NEGATIVE CONTROL — no circle-translate at all → no warning (anchor is a no-op)', () => {
    const warnings = convertWarnings(
      layerStyle('circle', { 'circle-radius': 3, 'circle-color': '#fff' }),
    )
    expect(warnings.find((w) => w.includes('circle-translate-anchor'))).toBeUndefined()
  })
})

// ── The absent case warned on NO route before #2170 ──
//
// fill / line / fill-extrusion now HONOUR the spec default, so they must
// stay silent — but silence is only meaningful once the collector is the
// real one. (Passing a top-level `warnings` option instead of `coverage`
// yields an empty array for every input, which reads as "no warning".)

describe('#2170 — fill/line/fill-extrusion honour the default silently', () => {
  it('the collector is live: a known gap still reports', () => {
    const warnings = convertWarnings(
      layerStyle('fill', { 'fill-color': '#888', 'fill-sort-key': 3 }),
    )
    expect(warnings.join(' '), 'known-positive control for the collector').toContain(
      'fill-sort-key',
    )
  })

  it('fill: absent anchor + translate → honoured, so no warning', () => {
    const warnings = convertWarnings(
      layerStyle('fill', { 'fill-color': '#888', 'fill-translate': [2, 3] }),
    )
    expect(warnings.filter((w) => w.includes('translate-anchor'))).toEqual([])
  })

  it('line: absent anchor + translate → honoured, so no warning', () => {
    const warnings = convertWarnings(
      layerStyle('line', { 'line-color': '#888', 'line-width': 2, 'line-translate': [4, 1] }),
    )
    expect(warnings.filter((w) => w.includes('translate-anchor'))).toEqual([])
  })
})

// ── #2170's SYMBOL half, which that increment did not cover ──
//
// paint_symbol.text-translate-anchor and .icon-translate-anchor carry the
// SAME default='map' in the pinned oracle as the four types above, but the
// symbol emitter kept the pre-#2170 shape — `anchor === 'map'` — so an
// absent anchor fell through to the screen-space path exactly as the fill
// emitter used to. Same defect, same spec clause, one layer type later.
//
// No committed style authors text-/icon-translate at all (11 style files
// scanned: the 4 openfreemap fixtures, maplibre-demotiles, the 2 e2e
// convert-fixtures and the playground public styles), so nothing in the
// corpus could witness this and no fixture bytes move — which is also why
// these arms had to be written rather than found.

function symbolStyle(paint: Record<string, unknown>, layout?: Record<string, unknown>): unknown {
  return {
    version: 8,
    sources: { t: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
    layers: [
      {
        id: 'l',
        type: 'symbol',
        source: 't',
        'source-layer': 'p',
        layout: { 'text-field': '{name}', ...(layout ?? {}) },
        paint,
      },
    ],
  }
}

describe('#2170 symbol half — absent anchor is the spec default "map"', () => {
  it('text: text-translate with no anchor → label-translate-anchor-map', () => {
    const src = convert(symbolStyle({ 'text-translate': [2, 3] }))
    expect(src).toContain('label-translate-anchor-map')
  })

  it('icon: icon-translate with no anchor → label-icon-translate-anchor-map', () => {
    const src = convert(symbolStyle({ 'icon-translate': [4, 1] }, { 'icon-image': 'marker' }))
    expect(src).toContain('label-icon-translate-anchor-map')
  })

  it('an invalid enum warns and falls back to the default, as fill/line already do', () => {
    const w = convertWarnings(
      symbolStyle({ 'text-translate': [2, 3], 'text-translate-anchor': 'sideways' }),
    )
    expect(w.join('\n')).toContain('translate-anchor')
    expect(
      convert(symbolStyle({ 'text-translate': [2, 3], 'text-translate-anchor': 'sideways' })),
    ).toContain('label-translate-anchor-map')
  })
})

describe('#2170 symbol half — negative controls (green before AND after)', () => {
  it('explicit viewport + text-translate → NO marker', () => {
    const src = convert(
      symbolStyle({ 'text-translate': [2, 3], 'text-translate-anchor': 'viewport' }),
    )
    expect(src).not.toContain('label-translate-anchor-map')
  })

  it('explicit map + text-translate → marker (the pre-existing supported path)', () => {
    const src = convert(symbolStyle({ 'text-translate': [2, 3], 'text-translate-anchor': 'map' }))
    expect(src).toContain('label-translate-anchor-map')
  })

  it('NO text-translate → NO marker (the anchor is a no-op without an offset)', () => {
    const src = convert(symbolStyle({ 'text-translate-anchor': 'map' }))
    expect(src).not.toContain('label-translate-anchor-map')
  })

  it('explicit viewport + icon-translate → NO icon marker', () => {
    const src = convert(
      symbolStyle(
        { 'icon-translate': [4, 1], 'icon-translate-anchor': 'viewport' },
        { 'icon-image': 'marker' },
      ),
    )
    expect(src).not.toContain('label-icon-translate-anchor-map')
  })
})
