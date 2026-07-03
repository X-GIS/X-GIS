// icon-overlap / icon-allow-overlap value-aware warnings.
//
// Phase S Batch 4 — icon-side collision policy is now implemented:
//   'always' / true / absent → X-GIS' always-place default (silent).
//   'never'  / false         → join the icon collision queue (silent —
//                              behaviour now delivered, no gap warning).
//   'cooperative'            → approximated as 'never' (collide); a single
//                              warning surfaces the missing priority-aware
//                              arbitration. Unrecognised enums still warn.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function buildStyle(layout: Record<string, unknown>) {
  return {
    version: 8,
    sources: { v: { type: 'vector', url: 'x.pmtiles' } },
    layers: [
      {
        id: 'poi',
        type: 'symbol',
        source: 'v',
        'source-layer': 'poi',
        layout: { 'icon-image': 'marker', 'text-field': '{name}', ...layout },
      },
    ],
  }
}

function warningsFor(layout: Record<string, unknown>): string[] {
  const coverage = { sources: [], layers: [], warnings: [] as string[] }
  convertMapboxStyle(buildStyle(layout) as never, { coverage })
  return coverage.warnings
}

describe('icon-overlap / icon-allow-overlap value-aware warnings', () => {
  it("icon-overlap 'always' → silent (matches X-GIS default)", () => {
    expect(warningsFor({ 'icon-overlap': 'always' }).some((w) => w.includes('icon-overlap'))).toBe(
      false,
    )
  })

  it("icon-overlap 'never' → silent (collision now implemented)", () => {
    expect(warningsFor({ 'icon-overlap': 'never' }).some((w) => w.includes('icon-overlap'))).toBe(
      false,
    )
  })

  it("icon-overlap 'cooperative' → warns (approximated as 'never')", () => {
    const hits = warningsFor({ 'icon-overlap': 'cooperative' }).filter((w) =>
      w.includes('icon-overlap'),
    )
    expect(hits.length).toBe(1)
    expect(hits[0]).toContain('cooperative')
  })

  it('icon-overlap unrecognised value → warns', () => {
    expect(
      warningsFor({ 'icon-overlap': 'wat' }).some((w) => w.includes('unrecognised icon-overlap')),
    ).toBe(true)
  })

  it('icon-allow-overlap: true → silent (matches default)', () => {
    expect(
      warningsFor({ 'icon-allow-overlap': true }).some((w) => w.includes('icon-allow-overlap')),
    ).toBe(false)
  })

  it('icon-allow-overlap: false → silent (collision now implemented)', () => {
    expect(
      warningsFor({ 'icon-allow-overlap': false }).some((w) => w.includes('icon-allow-overlap')),
    ).toBe(false)
  })

  it('icon-allow-overlap omitted → silent', () => {
    expect(warningsFor({}).some((w) => w.includes('icon-allow-overlap'))).toBe(false)
  })
})
