// Mapbox hillshade multidirectional (multi-source) lighting → xgis utilities.
//
// MapLibre v5 semantics: multiple illumination sources apply ONLY under
// `hillshade-method: multidirectional` (the spec doc says so verbatim); the
// engine normalises the four arrays to N = max(lengths), padding short arrays
// by repeating their last element. X-GIS emits source 1 through the existing
// default-suppressing utilities and sources 2..4 as numbered utilities
// (`hillshade-illumination-direction2-…`); >4 sources truncate with a warning
// (the runtime uniform carries 4).

import { describe, it, expect } from 'vitest'
import { emitHillshadePaint } from '../convert/paint-hillshade'
import type { MapboxLayer } from '../convert/types'

function emit(paint: Record<string, unknown>): { out: string[]; warnings: string[] } {
  const out: string[] = []
  const warnings: string[] = []
  emitHillshadePaint(out, { id: 'hs', type: 'hillshade' } as MapboxLayer, paint, warnings)
  return { out, warnings }
}

describe('hillshade multidirectional conversion', () => {
  it('emits numbered utilities for sources 2..4 (no approximation warning)', () => {
    const { out, warnings } = emit({
      'hillshade-method': 'multidirectional',
      'hillshade-illumination-direction': [225, 270, 315, 355],
      'hillshade-illumination-altitude': [45, 30, 60, 80],
      'hillshade-shadow-color': ['#000000', '#100000', '#001000', '#000010'],
      'hillshade-highlight-color': ['#ffffff', '#ffeeee', '#eeffee', '#eeeeff'],
    })
    expect(out).toContain('hillshade-method-multidirectional')
    // Source 1 rides the classic utilities (335/45/#000/#fff defaults suppress;
    // 225 ≠ 335 and 45 = default → only direction emits).
    expect(out).toContain('hillshade-illumination-direction-225')
    expect(out).not.toContain('hillshade-illumination-altitude-45')
    // Sources 2..4 are always explicit.
    expect(out).toContain('hillshade-illumination-direction2-270')
    expect(out).toContain('hillshade-illumination-altitude2-30')
    expect(out).toContain('hillshade-shadow-color2-#100000')
    expect(out).toContain('hillshade-highlight-color2-#ffeeee')
    expect(out).toContain('hillshade-illumination-direction3-315')
    expect(out).toContain('hillshade-illumination-direction4-355')
    expect(out).toContain('hillshade-highlight-color4-#eeeeff')
    expect(warnings).toEqual([])
  })

  it('pads short arrays by repeating the last element (MapLibre parity)', () => {
    const { out, warnings } = emit({
      'hillshade-method': 'multidirectional',
      'hillshade-illumination-direction': [225, 270, 315],
      'hillshade-illumination-altitude': 30,
      'hillshade-shadow-color': '#111111',
      'hillshade-highlight-color': ['#ffffff', '#ffeecc'],
    })
    // N = 3 (directions); altitude pads 30 → every source, highlight pads
    // its last (#ffeecc) into source 3.
    expect(out).toContain('hillshade-illumination-altitude2-30')
    expect(out).toContain('hillshade-illumination-altitude3-30')
    expect(out).toContain('hillshade-highlight-color2-#ffeecc')
    expect(out).toContain('hillshade-highlight-color3-#ffeecc')
    expect(out).toContain('hillshade-shadow-color3-#111111')
    expect(out).not.toContain('hillshade-illumination-direction4')
    expect(warnings).toEqual([])
  })

  it('truncates >4 sources with a warning', () => {
    const { out, warnings } = emit({
      'hillshade-method': 'multidirectional',
      'hillshade-illumination-direction': [0, 60, 120, 180, 240, 300],
    })
    expect(out).toContain('hillshade-illumination-direction4-180')
    expect(out.some((u) => u.startsWith('hillshade-illumination-direction5'))).toBe(false)
    expect(warnings.some((w) => w.includes('supports 4'))).toBe(true)
  })

  it('non-multidirectional methods use element 0 of an array and warn', () => {
    const { out, warnings } = emit({
      'hillshade-method': 'igor',
      'hillshade-illumination-direction': [225, 270],
    })
    expect(out).toContain('hillshade-method-igor')
    expect(out).toContain('hillshade-illumination-direction-225')
    expect(out.some((u) => u.includes('direction2'))).toBe(false)
    expect(warnings.some((w) => w.includes('multidirectional'))).toBe(true)
  })

  it('combined / igor emit their enum without an approximation warning', () => {
    for (const m of ['combined', 'igor'] as const) {
      const { out, warnings } = emit({ 'hillshade-method': m })
      expect(out).toContain(`hillshade-method-${m}`)
      expect(warnings).toEqual([])
    }
  })
})
