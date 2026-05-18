// Pin iter 522 icon-size validation. Pre-fix the typeof number gate
// accepted NaN / Infinity (typeof both === 'number') and emitted
// invalid utilities the lower pass parseFloat'd to NaN / Infinity
// and propagated into per-vertex scale as a poison value. Negative
// values passed through fmtSigned's bracket form (`label-icon-
// size-[-2]`) which lower accepted (line 1065 `name === 'label-icon
// -size'` arm) — runtime multiplied sprite quad dimensions by the
// negative scale, flipping the icon and rendering it back-to-front.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../index'

function compile(iconSize: unknown): { xgis: string; warnings: string[] } {
  const style = {
    version: 8,
    sources: { v: { type: 'vector' as const, url: 'x.pmtiles' } },
    layers: [{
      id: 'sym',
      type: 'symbol' as const,
      source: 'v',
      'source-layer': 'poi',
      layout: { 'icon-image': 'marker', 'icon-size': iconSize },
    }],
  }
  const warnings: string[] = []
  const xgis = convertMapboxStyle(style as never, {
    coverage: { sources: [], layers: [], warnings },
  })
  return { xgis, warnings }
}

describe('icon-size validation — iter 522', () => {
  it('default 1 → no utility, no warning', () => {
    const { xgis, warnings } = compile(1)
    expect(warnings.filter(w => w.includes('icon-size'))).toEqual([])
    expect(xgis).not.toContain('label-icon-size-')
  })

  it('0.5 → label-icon-size-0.5', () => {
    const { xgis, warnings } = compile(0.5)
    expect(warnings.filter(w => w.includes('icon-size'))).toEqual([])
    expect(xgis).toContain('label-icon-size-0.5')
  })

  it('0 → label-icon-size-0 (valid hide sentinel)', () => {
    const { xgis, warnings } = compile(0)
    expect(warnings.filter(w => w.includes('icon-size'))).toEqual([])
    expect(xgis).toContain('label-icon-size-0')
  })

  it('negative → clamped to 0 + warning', () => {
    const { xgis, warnings } = compile(-2)
    const hits = warnings.filter(w => w.includes('icon-size'))
    expect(hits.length).toBe(1)
    expect(hits[0]).toContain('icon-size -2')
    expect(hits[0]).toContain('negative')
    // Critical: must NOT emit the negative-bracket form which lower
    // would have accepted as labelIconSize = -2 → back-to-front render.
    expect(xgis).not.toContain('label-icon-size-[-2]')
    expect(xgis).toContain('label-icon-size-0')
  })

  it('NaN → silently dropped (Number.isFinite gate)', () => {
    const { xgis, warnings } = compile(NaN)
    expect(warnings.filter(w => w.includes('icon-size'))).toEqual([])
    // Critical: must NOT emit poison utility.
    expect(xgis).not.toContain('label-icon-size-NaN')
  })

  it('Infinity → silently dropped', () => {
    const { xgis, warnings } = compile(Infinity)
    expect(xgis).not.toContain('label-icon-size-Infinity')
  })

  it('zoom-interp → non-constant warning (OFM road_oneway shape)', () => {
    const { xgis, warnings } = compile(
      ['interpolate', ['linear'], ['zoom'], 15, 0.5, 19, 1],
    )
    const hits = warnings.filter(w => w.includes('icon-size'))
    expect(hits.length).toBe(1)
    expect(hits[0]).toContain('non-constant')
    expect(xgis).not.toContain('label-icon-size-[interpolate')
  })

  it('v8 literal-wrap ["literal", 0.5] → unwrapped to 0.5, no warning', () => {
    const { xgis, warnings } = compile(['literal', 0.5])
    expect(warnings.filter(w => w.includes('icon-size'))).toEqual([])
    expect(xgis).toContain('label-icon-size-0.5')
  })
})
