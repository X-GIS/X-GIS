// Mapbox paint.icon-translate → LabelDef.iconTranslateX/Y round-trip.
//
// icon-translate is a CSS-px VIEWPORT offset that applies only to the
// icon (independent of text-translate). The converter emits the
// `label-icon-translate-{x,y}-N` utility pair (mirror of icon-offset);
// lower threads it into LabelDef.iconTranslateX/Y; the runtime
// dispatchIcon adds it (× dpr) to the icon anchor at IconStage.addIcon.
// Default [0,0] = no-op. icon-translate-anchor: only viewport honoured.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'

function compileLabel(
  layer: Record<string, unknown>,
  opts?: { coverage?: { sources: never[]; layers: never[]; warnings: string[] } },
): {
  iconImage?: string
  iconTranslateX?: number
  iconTranslateY?: number
} {
  const style = {
    version: 8,
    sprite: 'https://example/sprites/foo',
    sources: { src: { type: 'vector', tiles: ['https://x/{z}/{x}/{y}.pbf'] } },
    layers: [layer],
  }

  const xgis = convertMapboxStyle(style as any, opts as any)
  const tokens = new Lexer(xgis).tokenize()
  const program = new Parser(tokens).parse()
  const scene = lower(program)
  for (const n of scene.renderNodes) {
    const label = (n as any).label
    if (label) return label
  }
  return {}
}

describe('Mapbox paint.icon-translate → LabelDef.iconTranslateX/Y', () => {
  it('absent → both undefined (no offset)', () => {
    const def = compileLabel({
      id: 'poi',
      type: 'symbol',
      source: 'src',
      'source-layer': 'poi',
      layout: { 'icon-image': 'x' },
    })
    expect(def.iconTranslateX).toBeUndefined()
    expect(def.iconTranslateY).toBeUndefined()
  })

  it('[0, 0] → both undefined (default, no-op)', () => {
    const def = compileLabel({
      id: 'poi',
      type: 'symbol',
      source: 'src',
      'source-layer': 'poi',
      layout: { 'icon-image': 'x' },
      paint: { 'icon-translate': [0, 0] },
    })
    expect(def.iconTranslateX).toBeUndefined()
    expect(def.iconTranslateY).toBeUndefined()
  })

  it('[3, 4] → x=3, y=4', () => {
    const def = compileLabel({
      id: 'poi',
      type: 'symbol',
      source: 'src',
      'source-layer': 'poi',
      layout: { 'icon-image': 'x' },
      paint: { 'icon-translate': [3, 4] },
    })
    expect(def.iconTranslateX).toBe(3)
    expect(def.iconTranslateY).toBe(4)
  })

  it('negative [0, -8] (POI icon nudge up) → x undefined, y=-8 via bracket form', () => {
    const def = compileLabel({
      id: 'poi',
      type: 'symbol',
      source: 'src',
      'source-layer': 'poi',
      layout: { 'icon-image': 'x' },
      paint: { 'icon-translate': [0, -8] },
    })
    expect(def.iconTranslateX).toBeUndefined()
    expect(def.iconTranslateY).toBe(-8)
  })

  it('v8 ["literal", [dx, dy]] wrap unwraps to constant', () => {
    const def = compileLabel({
      id: 'poi',
      type: 'symbol',
      source: 'src',
      'source-layer': 'poi',
      layout: { 'icon-image': 'x' },
      paint: { 'icon-translate': ['literal', [-2, 5]] },
    })
    expect(def.iconTranslateX).toBe(-2)
    expect(def.iconTranslateY).toBe(5)
  })

  it('is independent of text-translate (icon shifts, text does not)', () => {
    const def = compileLabel({
      id: 'poi',
      type: 'symbol',
      source: 'src',
      'source-layer': 'poi',
      layout: { 'icon-image': 'x', 'text-field': '{name}' },
      paint: { 'icon-translate': [6, 0], 'text-translate': [0, -10] },
    })
    // icon-translate lands on the icon fields; text-translate stays on
    // the label translate (NOT mixed into the icon offset).
    expect(def.iconTranslateX).toBe(6)
    expect((def as { translate?: [number, number] }).translate).toEqual([0, -10])
  })

  it('icon-translate-anchor "map" → LabelDef.iconTranslateAnchorMap=true (world-anchored)', () => {
    const def = compileLabel({
      id: 'poi',
      type: 'symbol',
      source: 'src',
      'source-layer': 'poi',
      layout: { 'icon-image': 'x' },
      paint: { 'icon-translate': [2, 2], 'icon-translate-anchor': 'map' },
    }) as { iconTranslateX?: number; iconTranslateY?: number; iconTranslateAnchorMap?: boolean }
    expect(def.iconTranslateX).toBe(2)
    expect(def.iconTranslateY).toBe(2)
    expect(def.iconTranslateAnchorMap).toBe(true)
  })

  it('icon-translate-anchor "map" WITHOUT icon-translate → flag undefined (anchor no-op)', () => {
    const def = compileLabel({
      id: 'poi',
      type: 'symbol',
      source: 'src',
      'source-layer': 'poi',
      layout: { 'icon-image': 'x' },
      paint: { 'icon-translate-anchor': 'map' },
    }) as { iconTranslateAnchorMap?: boolean }
    expect(def.iconTranslateAnchorMap).toBeUndefined()
  })

  it('DEFAULT (no anchor) → iconTranslateAnchorMap undefined (viewport, byte-identical)', () => {
    const def = compileLabel({
      id: 'poi',
      type: 'symbol',
      source: 'src',
      'source-layer': 'poi',
      layout: { 'icon-image': 'x' },
      paint: { 'icon-translate': [2, 2] },
    }) as { iconTranslateAnchorMap?: boolean }
    expect(def.iconTranslateAnchorMap).toBeUndefined()
  })

  it('no gap warning for the supported constant form', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    compileLabel(
      {
        id: 'poi',
        type: 'symbol',
        source: 'src',
        'source-layer': 'poi',
        layout: { 'icon-image': 'x' },
        paint: { 'icon-translate': [3, 4] },
      },
      { coverage } as any,
    )
    expect(coverage.warnings.some((w) => w.includes('shares the text-translate offset'))).toBe(
      false,
    )
  })
})
