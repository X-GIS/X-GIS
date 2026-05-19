// SPEC_DEFAULT_NO_WARN suppresses *-translate-anchor warnings when
// the author writes 'viewport' (the value X-GIS implements today).
// The Mapbox spec default is 'map' but X-GIS doesn't support map-
// space anchor yet; authors who write 'viewport' explicitly are
// matching X-GIS — no diagnostic should fire. 'map' authors get
// the gap warning.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

type Case = { layer: string; property: string; parent: string }

const CASES: Case[] = [
  { layer: 'fill',           property: 'fill-translate-anchor',           parent: 'fill-translate' },
  { layer: 'line',           property: 'line-translate-anchor',           parent: 'line-translate' },
  { layer: 'circle',         property: 'circle-translate-anchor',         parent: 'circle-translate' },
  // fill-extrusion-translate is itself a specific gap warning;
  // anchor surfaces only when the parent is also set.
]

function buildStyle(c: Case, anchor: unknown, includeParent: boolean) {
  const paint: Record<string, unknown> = { [c.property]: anchor }
  if (includeParent) paint[c.parent] = [1, 1]
  if (c.layer === 'fill') paint['fill-color'] = '#fff'
  if (c.layer === 'line') { paint['line-color'] = '#fff'; paint['line-width'] = 1 }
  if (c.layer === 'circle') { paint['circle-radius'] = 3; paint['circle-color'] = '#fff' }
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
      const w = coverage.warnings.find(w => w.includes(c.property))
      expect(w, `${c.property}=viewport should not warn: ${JSON.stringify(coverage.warnings)}`).toBeUndefined()
    })

    it(`${c.property} 'map' WITH parent → warns (real gap)`, () => {
      const coverage = { sources: [], layers: [], warnings: [] as string[] }
      convertMapboxStyle(buildStyle(c, 'map', true) as never, { coverage })
      const w = coverage.warnings.find(w => w.includes(c.property))
      expect(w, `${c.property}=map should warn`).toBeDefined()
    })

    it(`${c.property} 'viewport' WITHOUT parent → no warning (anchor-only is no-op)`, () => {
      const coverage = { sources: [], layers: [], warnings: [] as string[] }
      convertMapboxStyle(buildStyle(c, 'viewport', false) as never, { coverage })
      expect(coverage.warnings.some(w => w.includes(c.property))).toBe(false)
    })

    it(`["literal", "viewport"] WITH parent → unwrapped + suppressed`, () => {
      const coverage = { sources: [], layers: [], warnings: [] as string[] }
      convertMapboxStyle(buildStyle(c, ['literal', 'viewport'], true) as never, { coverage })
      const w = coverage.warnings.find(w => w.includes(c.property))
      expect(w).toBeUndefined()
    })
  }
})
