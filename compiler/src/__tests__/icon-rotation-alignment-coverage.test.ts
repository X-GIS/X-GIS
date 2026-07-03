// Pin iter 494's behaviour: icon-rotation-alignment = "viewport" or
// "auto" matches X-GIS' default icon render (axis-aligned, no
// bearing rotation) so the converter MUST NOT mark the layer lossy
// for those values. Only "map" stays a real gap (needs symbol-
// placement=line rotation; deferred).
//
// Regression target: OFM highway-shield-{non-us, us-interstate} +
// road_shield_us — 9 layers across bright/liberty/positron that
// were lossy on this single warning until iter 494 suppressed it.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function symbol(layout: Record<string, unknown>, paint?: Record<string, unknown>): unknown {
  return {
    version: 8,
    sources: { t: { type: 'vector', tiles: ['x'] } },
    layers: [
      {
        id: 'q',
        type: 'symbol',
        source: 't',
        'source-layer': 'p',
        layout: { 'text-field': '{name}', ...layout },
        ...(paint ? { paint } : {}),
      },
    ],
  }
}

function hasIconRotationWarning(xgis: string): boolean {
  return xgis.includes('icon-rotation-alignment')
}

describe('icon-rotation-alignment converter suppression', () => {
  it('"viewport" does NOT warn (matches X-GIS default)', () => {
    const out = convertMapboxStyle(
      symbol({
        'icon-image': 'shield',
        'icon-rotation-alignment': 'viewport',
      }) as Parameters<typeof convertMapboxStyle>[0],
    )
    expect(hasIconRotationWarning(out)).toBe(false)
  })

  it('"auto" does NOT warn (point-default = viewport = X-GIS render)', () => {
    const out = convertMapboxStyle(
      symbol({
        'icon-image': 'shield',
        'icon-rotation-alignment': 'auto',
      }) as Parameters<typeof convertMapboxStyle>[0],
    )
    expect(hasIconRotationWarning(out)).toBe(false)
  })

  it('"map" DOES warn (real gap — symbol-placement=line rotation needed)', () => {
    const out = convertMapboxStyle(
      symbol({
        'icon-image': 'arrow',
        'icon-rotation-alignment': 'map',
        'symbol-placement': 'line',
      }) as Parameters<typeof convertMapboxStyle>[0],
    )
    expect(hasIconRotationWarning(out)).toBe(true)
  })

  it('absence is silent (Mapbox default = "auto")', () => {
    const out = convertMapboxStyle(
      symbol({
        'icon-image': 'shield',
      }) as Parameters<typeof convertMapboxStyle>[0],
    )
    expect(hasIconRotationWarning(out)).toBe(false)
  })

  it('null is silent (omitted value per Mapbox spec)', () => {
    const out = convertMapboxStyle(
      symbol({
        'icon-image': 'shield',
        'icon-rotation-alignment': null,
      }) as Parameters<typeof convertMapboxStyle>[0],
    )
    expect(hasIconRotationWarning(out)).toBe(false)
  })

  it('literal-wrap "viewport" via Mapbox v8 ["literal", "viewport"] still suppresses', () => {
    const out = convertMapboxStyle(
      symbol({
        'icon-image': 'shield',
        'icon-rotation-alignment': ['literal', 'viewport'],
      }) as Parameters<typeof convertMapboxStyle>[0],
    )
    expect(hasIconRotationWarning(out)).toBe(false)
  })
})
