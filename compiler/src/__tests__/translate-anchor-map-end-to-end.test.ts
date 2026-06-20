// End-to-end propagation test for *-translate-anchor=map (Phase S
// Batch 2). Mapbox style → convertMapboxStyle → Lexer → Parser →
// lower → optimize → emitCommands → ShowCommand.{fill,stroke}
// TranslateAnchorMap. The runtime (vector-tile-renderer) reads the
// flag to rotate the [dx,dy] CSS-px offset by the map bearing before
// the px → NDC bake (map/world-space anchor) instead of leaving it
// screen-fixed (viewport anchor, the historical default).
//
// The DEFAULT (anchor absent or 'viewport') MUST leave the flag
// undefined so styles that don't use map-anchor stay byte-identical
// to today's render.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { optimize } from '../ir/optimize'
import { emitCommands } from '../ir/emit-commands'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function convert(mapboxStyle: unknown): string {
  return convertMapboxStyle(mapboxStyle as Parameters<typeof convertMapboxStyle>[0])
}

function compileToShows(mapboxStyle: unknown): ReturnType<typeof emitCommands>['shows'] {
  const tokens = new Lexer(convert(mapboxStyle)).tokenize()
  const ast = new Parser(tokens).parse()
  return emitCommands(optimize(lower(ast), ast)).shows
}

function fillLayer(paint: Record<string, unknown>): unknown {
  return {
    version: 8,
    sources: { t: { type: 'vector', tiles: ['x'] } },
    layers: [{ id: 'f', type: 'fill', source: 't', 'source-layer': 'p', paint }],
  }
}

function lineLayer(paint: Record<string, unknown>): unknown {
  return {
    version: 8,
    sources: { t: { type: 'vector', tiles: ['x'] } },
    layers: [{ id: 'l', type: 'line', source: 't', 'source-layer': 'p', paint }],
  }
}

function fillExtrusionLayer(paint: Record<string, unknown>): unknown {
  return {
    version: 8,
    sources: { t: { type: 'vector', tiles: ['x'] } },
    layers: [{ id: 'e', type: 'fill-extrusion', source: 't', 'source-layer': 'p', paint }],
  }
}

describe('fill-translate-anchor=map — converter emit', () => {
  it("anchor=map WITH fill-translate → emits fill-translate-anchor-map utility", () => {
    const src = convert(fillLayer({
      'fill-color': '#888', 'fill-translate': [2, 3], 'fill-translate-anchor': 'map',
    }))
    expect(src).toContain('fill-translate-anchor-map')
  })

  it("anchor=viewport (explicit default) → NO anchor utility (byte-identical screen-space)", () => {
    const src = convert(fillLayer({
      'fill-color': '#888', 'fill-translate': [2, 3], 'fill-translate-anchor': 'viewport',
    }))
    expect(src).not.toContain('fill-translate-anchor')
  })

  it("anchor absent → NO anchor utility (byte-identical default)", () => {
    const src = convert(fillLayer({ 'fill-color': '#888', 'fill-translate': [2, 3] }))
    expect(src).not.toContain('fill-translate-anchor')
  })

  it("anchor=map WITHOUT a fill-translate → no-op, no utility (nothing to anchor)", () => {
    const src = convert(fillLayer({ 'fill-color': '#888', 'fill-translate-anchor': 'map' }))
    expect(src).not.toContain('fill-translate-anchor-map')
  })

  it('["literal", "map"] wrap → unwrapped + emits the flag', () => {
    const src = convert(fillLayer({
      'fill-color': '#888', 'fill-translate': [2, 3], 'fill-translate-anchor': ['literal', 'map'],
    }))
    expect(src).toContain('fill-translate-anchor-map')
  })
})

describe('line-translate-anchor=map — converter emit (stroke namespace)', () => {
  it("anchor=map WITH line-translate → emits stroke-translate-anchor-map utility", () => {
    const src = convert(lineLayer({
      'line-color': '#888', 'line-width': 2, 'line-translate': [4, 1], 'line-translate-anchor': 'map',
    }))
    expect(src).toContain('stroke-translate-anchor-map')
  })

  it("anchor=viewport → NO anchor utility (byte-identical)", () => {
    const src = convert(lineLayer({
      'line-color': '#888', 'line-width': 2, 'line-translate': [4, 1], 'line-translate-anchor': 'viewport',
    }))
    expect(src).not.toContain('translate-anchor')
  })

  it("anchor absent → NO anchor utility", () => {
    const src = convert(lineLayer({ 'line-color': '#888', 'line-width': 2, 'line-translate': [4, 1] }))
    expect(src).not.toContain('translate-anchor')
  })
})

describe('translate-anchor=map → ShowCommand.{fill,stroke}TranslateAnchorMap', () => {
  it('fill anchor=map → ShowCommand.fillTranslateAnchorMap === true (offset still carried)', () => {
    const shows = compileToShows(fillLayer({
      'fill-color': '#888', 'fill-translate': [2, 3], 'fill-translate-anchor': 'map',
    }))
    expect(shows[0]!.fillTranslateAnchorMap).toBe(true)
    // The offset itself is unchanged — only its anchor space differs.
    expect(shows[0]!.fillTranslateX).toBe(2)
    expect(shows[0]!.fillTranslateY).toBe(3)
  })

  it('DEFAULT (no anchor) → fillTranslateAnchorMap undefined — byte-identical screen-space', () => {
    const shows = compileToShows(fillLayer({
      'fill-color': '#888', 'fill-translate': [2, 3],
    }))
    expect(shows[0]!.fillTranslateAnchorMap).toBeUndefined()
    expect(shows[0]!.fillTranslateX).toBe(2)
    expect(shows[0]!.fillTranslateY).toBe(3)
  })

  it('explicit viewport anchor → fillTranslateAnchorMap undefined (default render path)', () => {
    const shows = compileToShows(fillLayer({
      'fill-color': '#888', 'fill-translate': [2, 3], 'fill-translate-anchor': 'viewport',
    }))
    expect(shows[0]!.fillTranslateAnchorMap).toBeUndefined()
  })

  it('line anchor=map → ShowCommand.strokeTranslateAnchorMap === true', () => {
    const shows = compileToShows(lineLayer({
      'line-color': '#888', 'line-width': 2, 'line-translate': [4, 1], 'line-translate-anchor': 'map',
    }))
    expect(shows[0]!.strokeTranslateAnchorMap).toBe(true)
    expect(shows[0]!.strokeTranslateX).toBe(4)
    expect(shows[0]!.strokeTranslateY).toBe(1)
  })

  it('DEFAULT line (no anchor) → strokeTranslateAnchorMap undefined — byte-identical', () => {
    const shows = compileToShows(lineLayer({
      'line-color': '#888', 'line-width': 2, 'line-translate': [4, 1],
    }))
    expect(shows[0]!.strokeTranslateAnchorMap).toBeUndefined()
    expect(shows[0]!.strokeTranslateX).toBe(4)
    expect(shows[0]!.strokeTranslateY).toBe(1)
  })
})

describe('fill-extrusion-translate-anchor=map — reuses fill-translate slot', () => {
  it('anchor=map → fill-translate-anchor-map utility (extrude shares fill slot 46/47)', () => {
    const src = convert(fillExtrusionLayer({
      'fill-extrusion-color': '#888', 'fill-extrusion-height': 10,
      'fill-extrusion-translate': [3, 4], 'fill-extrusion-translate-anchor': 'map',
    }))
    expect(src).toContain('fill-translate-anchor-map')
  })

  it('anchor=map → ShowCommand.fillTranslateAnchorMap === true + offset carried', () => {
    const shows = compileToShows(fillExtrusionLayer({
      'fill-extrusion-color': '#888', 'fill-extrusion-height': 10,
      'fill-extrusion-translate': [3, 4], 'fill-extrusion-translate-anchor': 'map',
    }))
    expect(shows[0]!.fillTranslateAnchorMap).toBe(true)
    expect(shows[0]!.fillTranslateX).toBe(3)
    expect(shows[0]!.fillTranslateY).toBe(4)
  })

  it('DEFAULT (no anchor) → fillTranslateAnchorMap undefined — byte-identical extrude path', () => {
    const shows = compileToShows(fillExtrusionLayer({
      'fill-extrusion-color': '#888', 'fill-extrusion-height': 10,
      'fill-extrusion-translate': [3, 4],
    }))
    expect(shows[0]!.fillTranslateAnchorMap).toBeUndefined()
    expect(shows[0]!.fillTranslateX).toBe(3)
    expect(shows[0]!.fillTranslateY).toBe(4)
  })
})

// ── Phase S Batch 3: SYMBOL path (text + icon) ──
// text-/icon-translate-anchor=map land on ShowCommand.label.{translate,
// icon}AnchorMap; the runtime (text-stage / label-pass dispatchIcon)
// rotates the [dx,dy] offset by the map bearing. DEFAULT (absent /
// viewport) leaves the flag undefined → byte-identical screen-space.

function symbolLayer(paint: Record<string, unknown>, layout: Record<string, unknown>): unknown {
  return {
    version: 8,
    sprite: 'https://example/sprites/foo',
    sources: { t: { type: 'vector', tiles: ['x'] } },
    layers: [{ id: 's', type: 'symbol', source: 't', 'source-layer': 'p', layout, paint }],
  }
}

describe('text-translate-anchor=map → ShowCommand.label.translateAnchorMap', () => {
  it('anchor=map WITH text-translate → emits label-translate-anchor-map utility', () => {
    const src = convert(symbolLayer(
      { 'text-color': '#000', 'text-translate': [2, -8], 'text-translate-anchor': 'map' },
      { 'text-field': '{name}' }))
    expect(src).toContain('label-translate-anchor-map')
  })

  it('anchor=map → label.translateAnchorMap === true (offset carried)', () => {
    const shows = compileToShows(symbolLayer(
      { 'text-color': '#000', 'text-translate': [2, -8], 'text-translate-anchor': 'map' },
      { 'text-field': '{name}' }))
    expect(shows[0]!.label!.translateAnchorMap).toBe(true)
    expect(shows[0]!.label!.translate).toEqual([2, -8])
  })

  it('DEFAULT (no anchor) → translateAnchorMap undefined — byte-identical screen-space', () => {
    const shows = compileToShows(symbolLayer(
      { 'text-color': '#000', 'text-translate': [2, -8] },
      { 'text-field': '{name}' }))
    expect(shows[0]!.label!.translateAnchorMap).toBeUndefined()
    expect(shows[0]!.label!.translate).toEqual([2, -8])
  })

  it('anchor=map WITHOUT text-translate → no utility (anchor no-op)', () => {
    const src = convert(symbolLayer(
      { 'text-color': '#000', 'text-translate-anchor': 'map' },
      { 'text-field': '{name}' }))
    expect(src).not.toContain('label-translate-anchor-map')
  })
})

describe('icon-translate-anchor=map → ShowCommand.label.iconTranslateAnchorMap', () => {
  it('anchor=map WITH icon-translate → emits label-icon-translate-anchor-map utility', () => {
    const src = convert(symbolLayer(
      { 'icon-translate': [4, 2], 'icon-translate-anchor': 'map' },
      { 'icon-image': 'marker' }))
    expect(src).toContain('label-icon-translate-anchor-map')
  })

  it('anchor=map → label.iconTranslateAnchorMap === true (offset carried)', () => {
    const shows = compileToShows(symbolLayer(
      { 'icon-translate': [4, 2], 'icon-translate-anchor': 'map' },
      { 'icon-image': 'marker' }))
    expect(shows[0]!.label!.iconTranslateAnchorMap).toBe(true)
    expect(shows[0]!.label!.iconTranslateX).toBe(4)
    expect(shows[0]!.label!.iconTranslateY).toBe(2)
  })

  it('DEFAULT (no anchor) → iconTranslateAnchorMap undefined — byte-identical', () => {
    const shows = compileToShows(symbolLayer(
      { 'icon-translate': [4, 2] },
      { 'icon-image': 'marker' }))
    expect(shows[0]!.label!.iconTranslateAnchorMap).toBeUndefined()
    expect(shows[0]!.label!.iconTranslateX).toBe(4)
  })
})
