// circle-stroke-opacity constant form: folds into stroke-color hex
// alpha. Pre-fix the property was silently dropped via the "ignored"
// list. Plan §4 partial landing — non-constant forms still warn.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function buildStyle(extraPaint: Record<string, unknown>) {
  return {
    version: 8,
    sources: { p: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
    layers: [
      {
        id: 'pts',
        type: 'circle',
        source: 'p',
        paint: {
          'circle-radius': 5,
          'circle-color': '#ff0000',
          'circle-stroke-color': '#0000ff',
          'circle-stroke-width': 2,
          ...extraPaint,
        },
      },
    ],
  }
}

describe('circle-stroke-opacity', () => {
  it('omitted → stroke-color stays 6-char hex (alpha=1.0 default)', () => {
    const xgis = convertMapboxStyle(buildStyle({}))
    expect(xgis).toContain('stroke-#0000ff')
    expect(xgis).not.toMatch(/stroke-#0000ff[0-9a-f]{2}/)
  })

  it('constant 0.5 → folds into stroke-color hex alpha (#0000ff80)', () => {
    const xgis = convertMapboxStyle(buildStyle({ 'circle-stroke-opacity': 0.5 }))
    expect(xgis).toContain('stroke-#0000ff80')
  })

  it('constant 0.0 → fully transparent stroke', () => {
    const xgis = convertMapboxStyle(buildStyle({ 'circle-stroke-opacity': 0 }))
    expect(xgis).toContain('stroke-#0000ff00')
  })

  it('constant 1.0 → no alpha fold (visual identical to omitted)', () => {
    const xgis = convertMapboxStyle(buildStyle({ 'circle-stroke-opacity': 1 }))
    expect(xgis).toContain('stroke-#0000ff')
    expect(xgis).not.toMatch(/stroke-#0000ff[0-9a-f]{2}/)
  })

  it('["literal", 0.5] unwraps + folds', () => {
    const xgis = convertMapboxStyle(buildStyle({ 'circle-stroke-opacity': ['literal', 0.5] }))
    expect(xgis).toContain('stroke-#0000ff80')
  })

  it('zoom-interp form emits a stroke-opacity-[…] binding (WS-1) — no drop warning', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    const xgis = convertMapboxStyle(
      buildStyle({
        'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 5, 0.2, 15, 1.0],
      }),
      { coverage },
    )
    // Now resolved per frame — the converter emits a bracket binding on
    // the 0..100 scale (mirror of circle-opacity) instead of warning + dropping.
    expect(xgis).toContain('stroke-opacity-[interpolate(zoom, 5, 20, 15, 100)]')
    // The stroke colour is left at base alpha (no fold) so the per-frame
    // multiply isn't double-applied.
    expect(xgis).toContain('stroke-#0000ff')
    expect(xgis).not.toMatch(/stroke-#0000ff[0-9a-f]{2}/)
    // No circle-stroke-opacity drop warning surfaces.
    expect(coverage.warnings.some((w) => w.includes('circle-stroke-opacity'))).toBe(false)
  })
})
