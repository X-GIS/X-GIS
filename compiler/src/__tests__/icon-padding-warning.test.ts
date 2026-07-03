// Pin icon-padding warning gate (iter 518). Mapbox spec default for
// icon-padding is 2. X-GIS has no icon-side collision queue yet
// (Phase C.9 deferred), so the property is a no-op regardless of
// value — but declaring NON-DEFAULT values means the author wanted
// custom spacing that won't materialize. Warn in that case so the
// lossy report surfaces real intent gaps; stay silent when the
// declared value matches the spec default (otherwise OFM Bright's
// road_oneway authoring `icon-padding: 2` would regress two layers
// from converted → lossy on a property that's authored identically
// to the spec default).
//
// Mirror of iter 494's icon-rotation-alignment viewport/auto
// suppression pattern.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../index'

function compile(layout: Record<string, unknown>): string[] {
  const style = {
    version: 8,
    sources: { v: { type: 'vector' as const, url: 'x.pmtiles' } },
    layers: [
      {
        id: 'sym',
        type: 'symbol' as const,
        source: 'v',
        'source-layer': 'poi',
        layout: { 'icon-image': 'marker', ...layout },
      },
    ],
  }
  const warnings: string[] = []
  convertMapboxStyle(style as never, {
    coverage: { sources: [], layers: [], warnings },
  })
  return warnings
}

describe('icon-padding warning gate — iter 518', () => {
  it('default value 2 → no warning (matches Mapbox spec default)', () => {
    const warnings = compile({ 'icon-padding': 2 })
    expect(warnings.filter((w) => w.includes('icon-padding'))).toEqual([])
  })

  it('omitted → no warning (default applied implicitly)', () => {
    const warnings = compile({})
    expect(warnings.filter((w) => w.includes('icon-padding'))).toEqual([])
  })

  it('non-default 8 → warning explaining Phase C.9 gap', () => {
    const warnings = compile({ 'icon-padding': 8 })
    const hits = warnings.filter((w) => w.includes('icon-padding'))
    expect(hits.length).toBe(1)
    expect(hits[0]).toContain('icon-padding 8')
    expect(hits[0]).toContain('Phase C.9')
  })

  it('0 → warning (zero is non-default; spec-valid; author meant "no padding")', () => {
    const warnings = compile({ 'icon-padding': 0 })
    expect(warnings.filter((w) => w.includes('icon-padding')).length).toBe(1)
  })

  it('zoom-interp → non-constant warning', () => {
    const warnings = compile({
      'icon-padding': ['interpolate', ['linear'], ['zoom'], 10, 2, 14, 6],
    })
    const hits = warnings.filter((w) => w.includes('icon-padding'))
    expect(hits.length).toBe(1)
    expect(hits[0]).toContain('non-constant form')
  })

  it('OFM-shape (constant 2 with literal wrap) → no warning', () => {
    // OFM authors `"icon-padding": 2` bare; tooling that strict-wraps
    // could emit `["literal", 2]`. unwrapLiteralScalar handles it.
    const warnings = compile({ 'icon-padding': ['literal', 2] })
    expect(warnings.filter((w) => w.includes('icon-padding'))).toEqual([])
  })
})
