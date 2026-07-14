// icon-padding warning gate. The CONSTANT form is now lowered end-to-end
// (#777 I-D — see icon-padding-wiring.test.ts): a constant icon-padding no
// longer warns, it lowers to label-icon-padding-N and threads to the
// IconStage collision box. The warning gate now fires only for what stays
// lossy: NON-CONSTANT forms (zoom-interp / data-driven — data-driven is
// cluster I-F) and negative values (clamped to the spec min 0). The spec
// default 2 stays silent AND emits no knob, so OFM Bright's road_oneway
// `icon-padding: 2` remains byte-identical.

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

  it('non-default 8 → no warning (lowered to label-icon-padding-8, #777 I-D)', () => {
    const warnings = compile({ 'icon-padding': 8 })
    expect(warnings.filter((w) => w.includes('icon-padding'))).toEqual([])
  })

  it('0 → no warning (spec-valid "no padding"; lowered to label-icon-padding-0)', () => {
    const warnings = compile({ 'icon-padding': 0 })
    expect(warnings.filter((w) => w.includes('icon-padding'))).toEqual([])
  })

  it('negative → clamp-to-0 warning (Mapbox spec min 0)', () => {
    const warnings = compile({ 'icon-padding': -3 })
    const hits = warnings.filter((w) => w.includes('icon-padding'))
    expect(hits.length).toBe(1)
    expect(hits[0]).toContain('negative')
    expect(hits[0]).toContain('Clamped to 0')
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
