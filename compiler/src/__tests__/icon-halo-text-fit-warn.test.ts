// Mapbox icon-halo-{color,width,blur} are not yet plumbed through X-GIS'
// IconStage (Plan §4 deferred; SDF-icon halo path). Iter 89 promoted these
// gaps from the generic ignoredText aggregator to specific layer-level
// warnings, parallel to the iter 88 icon-color promotion. icon-text-fit was
// in the same set until #777 I-A lowered it end-to-end — its cases below now
// assert the ABSENCE of a gap warning (emit is covered by icon-text-fit-emit.test.ts).

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function warningsOf(style: unknown): string[] {
  const coverage = { sources: [], layers: [], warnings: [] as string[] }
  convertMapboxStyle(style as never, { coverage })
  return coverage.warnings
}

function buildSymbol(layout: Record<string, unknown>, paint: Record<string, unknown>): unknown {
  return {
    version: 8,
    sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
    layers: [
      {
        id: 'lbl',
        type: 'symbol',
        source: 'v',
        'source-layer': 'a',
        layout: { 'text-field': '{name}', 'icon-image': 'pin', ...layout },
        paint: { 'text-color': '#000', ...paint },
      },
    ],
  }
}

describe('icon-halo + icon-text-fit specific gap warnings', () => {
  it('icon-halo-color → specific warn (not generic ignoredText)', () => {
    const w = warningsOf(buildSymbol({}, { 'icon-halo-color': '#000' }))
    expect(
      w.some(
        (s) =>
          s.includes('icon-halo-color') && s.includes('SDF icon halo') && s.includes('Plan §4'),
      ),
    ).toBe(true)
    expect(w.some((s) => s.includes('ignored properties') && s.includes('icon-halo-color'))).toBe(
      false,
    )
  })

  it('icon-halo-width → specific warn', () => {
    const w = warningsOf(buildSymbol({}, { 'icon-halo-width': 2 }))
    expect(w.some((s) => s.includes('icon-halo-width') && s.includes('Plan §4'))).toBe(true)
  })

  it('icon-halo-blur → specific warn', () => {
    const w = warningsOf(buildSymbol({}, { 'icon-halo-blur': 1 }))
    expect(w.some((s) => s.includes('icon-halo-blur') && s.includes('Plan §4'))).toBe(true)
  })

  it('icon-text-fit: "width" → lowered (#777 I-A), no longer a gap warning', () => {
    // Pre-#777 this asserted a Plan §4 deferral warn; I-A now emits the utility
    // (asserted by icon-text-fit-emit.test.ts) so the gap warning is gone.
    const w = warningsOf(buildSymbol({ 'icon-text-fit': 'width' }, {}))
    expect(w.some((s) => s.includes('icon-text-fit'))).toBe(false)
  })

  it('icon-text-fit: "none" (default) does NOT warn', () => {
    const w = warningsOf(buildSymbol({ 'icon-text-fit': 'none' }, {}))
    expect(w.some((s) => s.includes('icon-text-fit') && !s.includes('ignored properties'))).toBe(
      false,
    )
  })

  it('layer without any icon-halo/text-fit properties does NOT warn', () => {
    const w = warningsOf(buildSymbol({}, {}))
    expect(
      w.some(
        (s) =>
          s.includes('icon-halo-color') ||
          s.includes('icon-halo-width') ||
          s.includes('icon-halo-blur') ||
          s.includes('icon-text-fit'),
      ),
    ).toBe(false)
  })
})
