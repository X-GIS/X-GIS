// Regression gate: every translate paint property fires a SPECIFIC
// gap warning naming the missing u.*_translate uniform plumbing,
// rather than burying the gap in the generic ignored-properties
// blob. Catches a future refactor that re-buckets one of these
// into surfaceIgnoredPaint and loses the specificity.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

interface Case {
  property: string
  layerType: string
  value: unknown
  /** Substring that must appear in the warning to confirm specificity */
  expectIn: string
}

const CASES: Case[] = [
  // fill-translate is SUPPORTED (constant + last-stop zoom-interp).
  // fill-extrusion-translate is SUPPORTED iter-180 — routed through
  // the same addFillTranslate helper since the fill-extrusion vertex
  // shaders apply u.fill_translate_x/y already. Both omitted here.
  { property: 'line-translate',
    layerType: 'line', value: [1, 1],
    expectIn: 'no per-frame translate uniform' },
  { property: 'circle-translate',
    layerType: 'circle', value: [1, 1],
    expectIn: 'point renderer has no per-frame translate' },
  { property: 'icon-translate',
    layerType: 'symbol', value: [1, 1],
    expectIn: 'shares the text-translate offset' },
]

function buildStyle(c: Case): Record<string, unknown> {
  const layer: Record<string, unknown> = {
    id: 'l',
    type: c.layerType,
    paint: { [c.property]: c.value },
  }
  if (c.layerType === 'line') {
    layer.source = 'v'; layer['source-layer'] = 'r'
    ;(layer.paint as Record<string, unknown>)['line-color'] = '#fff'
    ;(layer.paint as Record<string, unknown>)['line-width'] = 1
  } else if (c.layerType === 'fill-extrusion') {
    layer.source = 'v'; layer['source-layer'] = 'b'
    ;(layer.paint as Record<string, unknown>)['fill-extrusion-color'] = '#aaa'
    ;(layer.paint as Record<string, unknown>)['fill-extrusion-height'] = 10
  } else if (c.layerType === 'circle') {
    layer.source = 'v'; layer['source-layer'] = 'p'
    ;(layer.paint as Record<string, unknown>)['circle-radius'] = 3
    ;(layer.paint as Record<string, unknown>)['circle-color'] = '#fff'
  } else if (c.layerType === 'symbol') {
    layer.source = 'v'; layer['source-layer'] = 'p'
    layer.layout = { 'text-field': '{name}', 'icon-image': 'marker' }
    ;(layer.paint as Record<string, unknown>)['text-color'] = '#fff'
  }
  return {
    version: 8,
    sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
    layers: [layer],
  }
}

describe('fill-extrusion-translate Stage 1 — emits utility, no warning', () => {
  it('routes through addFillTranslate; no Plan §4 gap warning', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle({
      version: 8,
      sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
      layers: [{
        id: 'b', type: 'fill-extrusion', source: 'v', 'source-layer': 'b',
        paint: {
          'fill-extrusion-color': '#aaa',
          'fill-extrusion-height': 10,
          'fill-extrusion-translate': [3, 4],
        },
      }],
    } as never, { coverage })
    const stale = coverage.warnings.find(w =>
      w.includes('fill-extrusion-translate')
      && (w.includes('no per-frame translate') || w.includes('Plan §4 deferred')))
    expect(stale, `unexpected legacy gap warning: ${stale}`).toBeUndefined()
  })
})

describe('translate-property gap warning specificity', () => {
  for (const c of CASES) {
    it(`${c.property} → specific warning naming the missing uniform`, () => {
      const coverage = { sources: [], layers: [], warnings: [] as string[] }
      convertMapboxStyle(buildStyle(c) as never, { coverage })
      const w = coverage.warnings.find(w => w.includes(c.property) && w.includes(c.expectIn))
      expect(w, `expected warning containing "${c.expectIn}" for ${c.property}`).toBeDefined()
      // Must NOT also surface via the generic ignored-properties blob.
      const genericHit = coverage.warnings.find(
        w => (w.includes('ignored paint properties') || w.includes('ignored properties:'))
          && w.includes(c.property),
      )
      expect(
        genericHit,
        `${c.property} should NOT also appear in generic ignored blob`,
      ).toBeUndefined()
    })
  }
})
