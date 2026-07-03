// Mapbox icon-color (SDF sprite tint) is plumbed end-to-end as of
// Plan §4 / iter 138: IconRenderer carries a per-vertex tint + an
// fwidth SDF fragment path, and the compiler emits a
// `label-icon-color-…` utility that lower.ts threads into
// LabelShapes.iconColor (constant + zoom-interp + data-driven), the
// same shape contract text-color uses. This test pins the converted
// state — icon-color must NOT produce a "deferred / not supported"
// gap warning and must NOT fall into the generic ignoredText blob.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function convert(style: unknown): { xgis: string; warnings: string[] } {
  const coverage = { sources: [], layers: [], warnings: [] as string[] }
  const xgis = convertMapboxStyle(style as never, { coverage })
  return { xgis, warnings: coverage.warnings }
}

const baseLayer = (paint: Record<string, unknown>) => ({
  version: 8,
  sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
  layers: [
    {
      id: 'shield',
      type: 'symbol',
      source: 'v',
      'source-layer': 'transportation',
      layout: { 'icon-image': 'us-interstate-3' },
      paint,
    },
  ],
})

describe('icon-color SDF tint conversion (Plan §4, iter 138)', () => {
  it('constant hex → label-icon-color utility, no gap warning', () => {
    const { xgis, warnings } = convert(baseLayer({ 'icon-color': '#ff0000' }))
    expect(xgis).toContain('label-icon-color-')
    // No "deferred" / "not yet" / "doesn't yet" gap warning.
    expect(
      warnings.some(
        (s) =>
          s.includes('icon-color') && /deferred|doesn't yet|not yet|could not be converted/.test(s),
      ),
    ).toBe(false)
    // Not in the generic ignored-properties blob either.
    expect(warnings.some((s) => s.includes('ignored properties') && s.includes('icon-color'))).toBe(
      false,
    )
  })

  it('zoom-interp icon-color → bracket binding utility', () => {
    const { xgis, warnings } = convert(
      baseLayer({
        'icon-color': ['interpolate', ['linear'], ['zoom'], 6, '#ff0000', 14, '#0000ff'],
      }),
    )
    expect(xgis).toContain('label-icon-color-[')
    expect(
      warnings.some(
        (s) => s.includes('icon-color') && /deferred|doesn't yet|could not be converted/.test(s),
      ),
    ).toBe(false)
  })

  it('data-driven icon-color (case) → expression binding, no gap warning', () => {
    const { xgis, warnings } = convert(
      baseLayer({
        'icon-color': ['case', ['==', ['get', 'kind'], 'interstate'], '#0000ff', '#888'],
      }),
    )
    expect(xgis).toContain('label-icon-color-[')
    expect(
      warnings.some(
        (s) => s.includes('icon-color') && /deferred|doesn't yet|could not be converted/.test(s),
      ),
    ).toBe(false)
  })

  it('layer WITHOUT icon-color emits no icon-color utility', () => {
    const { xgis } = convert(baseLayer({}))
    expect(xgis).not.toContain('label-icon-color-')
  })
})
