// *-translate-anchor diagnostics. 'viewport' (X-GIS' historical
// screen-space behaviour) never warns. For fill / line the 'map'
// anchor is now SUPPORTED (Phase S Batch 2 — VTR rotates the offset
// by the map bearing), so it ALSO doesn't warn. For circle (still
// deferred — circle translate resolves in the point-renderer, not
// ResolvedShow) 'map' still surfaces the gap warning.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

type Case = { layer: string; property: string; parent: string; mapSupported: boolean }

const CASES: Case[] = [
  {
    layer: 'fill',
    property: 'fill-translate-anchor',
    parent: 'fill-translate',
    mapSupported: true,
  },
  {
    layer: 'line',
    property: 'line-translate-anchor',
    parent: 'line-translate',
    mapSupported: true,
  },
  {
    layer: 'circle',
    property: 'circle-translate-anchor',
    parent: 'circle-translate',
    mapSupported: false,
  },
  // fill-extrusion-translate is itself a specific gap warning;
  // anchor surfaces only when the parent is also set.
]

function buildStyle(c: Case, anchor: unknown, includeParent: boolean) {
  const paint: Record<string, unknown> = { [c.property]: anchor }
  if (includeParent) paint[c.parent] = [1, 1]
  if (c.layer === 'fill') paint['fill-color'] = '#fff'
  if (c.layer === 'line') {
    paint['line-color'] = '#fff'
    paint['line-width'] = 1
  }
  if (c.layer === 'circle') {
    paint['circle-radius'] = 3
    paint['circle-color'] = '#fff'
  }
  return {
    version: 8,
    sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
    layers: [{ id: 'l', type: c.layer, source: 'v', 'source-layer': 'r', paint }],
  }
}

describe('*-translate-anchor default suppression', () => {
  for (const c of CASES) {
    it(`${c.property} 'viewport' WITH parent → no warning (matches X-GIS)`, () => {
      const coverage = { sources: [], layers: [], warnings: [] as string[] }
      convertMapboxStyle(buildStyle(c, 'viewport', true) as never, { coverage })
      const w = coverage.warnings.find((w) => w.includes(c.property))
      expect(
        w,
        `${c.property}=viewport should not warn: ${JSON.stringify(coverage.warnings)}`,
      ).toBeUndefined()
    })

    it(`${c.property} 'map' WITH parent → ${c.mapSupported ? 'no warning (supported)' : 'warns (real gap)'}`, () => {
      const coverage = { sources: [], layers: [], warnings: [] as string[] }
      convertMapboxStyle(buildStyle(c, 'map', true) as never, { coverage })
      const w = coverage.warnings.find((w) => w.includes(c.property))
      if (c.mapSupported) {
        expect(
          w,
          `${c.property}=map is now supported and should not warn: ${JSON.stringify(coverage.warnings)}`,
        ).toBeUndefined()
      } else {
        expect(w, `${c.property}=map should warn`).toBeDefined()
      }
    })

    it(`${c.property} 'viewport' WITHOUT parent → no warning (anchor-only is no-op)`, () => {
      const coverage = { sources: [], layers: [], warnings: [] as string[] }
      convertMapboxStyle(buildStyle(c, 'viewport', false) as never, { coverage })
      expect(coverage.warnings.some((w) => w.includes(c.property))).toBe(false)
    })

    it(`["literal", "viewport"] WITH parent → unwrapped + suppressed`, () => {
      const coverage = { sources: [], layers: [], warnings: [] as string[] }
      convertMapboxStyle(buildStyle(c, ['literal', 'viewport'], true) as never, { coverage })
      const w = coverage.warnings.find((w) => w.includes(c.property))
      expect(w).toBeUndefined()
    })
  }
})
