// Pin the text-optional / icon-optional gate (iter 519, updated #2440).
//
// Mapbox spec defaults for both = false, which is X-GIS's own pair contract
// (text and icon place or drop together), so the default must stay silent AND
// field-free — the value-blind absence is invisible at the default.
//
// BOTH `true` cases are now IMPLEMENTED and neither warns: `icon-optional` in
// Phase S Batch 4, `text-optional` in #2440. The file kept its shape through
// both transitions because what it really pins is "only a form we cannot carry
// warns" — the arms below therefore assert the UTILITY is emitted rather than
// merely that no warning fired, which is what distinguishes "implemented" from
// "silently dropped".
//
// OFM authors `text-optional: true` on the `airport` symbol layer (all 3 OFM
// styles, one layer per style) and `icon-optional: false` on 4 label_* layers
// per style. Under this gate all of them are now `converted`, none lossy.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../index'

function styleOf(layout: Record<string, unknown>) {
  return {
    version: 8,
    sources: { v: { type: 'vector' as const, url: 'x.pmtiles' } },
    layers: [
      {
        id: 'sym',
        type: 'symbol' as const,
        source: 'v',
        'source-layer': 'poi',
        layout: { 'icon-image': 'marker', 'text-field': '{name}', ...layout },
      },
    ],
  }
}

function compile(layout: Record<string, unknown>): string[] {
  const warnings: string[] = []
  convertMapboxStyle(styleOf(layout) as never, {
    coverage: { sources: [], layers: [], warnings },
  })
  return warnings
}

/** The emitted xgis source — what separates "implemented" from "dropped". */
function emit(layout: Record<string, unknown>): string {
  return convertMapboxStyle(styleOf(layout) as never)
}

describe('text-optional / icon-optional warning gate — iter 519', () => {
  describe('text-optional', () => {
    it('default false → no warning', () => {
      const warnings = compile({ 'text-optional': false })
      expect(warnings.filter((w) => w.includes('text-optional'))).toEqual([])
    })

    it('omitted → no warning', () => {
      const warnings = compile({})
      expect(warnings.filter((w) => w.includes('text-optional'))).toEqual([])
    })

    it('true (OFM airport shape) → no warning; carried as label-text-optional (#2440)', () => {
      // Was: a warning saying "symbol placement always pairs text + icon
      // (deferred)". #2440 delivered it, so the warning is gone AND the utility
      // is present — asserting only the first would pass on a silent drop.
      expect(compile({ 'text-optional': true }).filter((w) => w.includes('text-optional'))).toEqual(
        [],
      )
      expect(emit({ 'text-optional': true })).toContain('label-text-optional')
    })

    it('v8 literal-wrap ["literal", true] → utility emitted (unwrap honoured)', () => {
      // The unwrap is what this arm has always tested; only the observable
      // moved, from "a warning fires" to "the utility is emitted".
      expect(emit({ 'text-optional': ['literal', true] })).toContain('label-text-optional')
      expect(
        compile({ 'text-optional': ['literal', true] }).filter((w) => w.includes('text-optional')),
      ).toEqual([])
    })

    it('a non-constant form is the one that still warns, and carries nothing', () => {
      // The gate's surviving job: a form with no per-feature channel must be
      // loud. Without this arm the two above are satisfied by a converter that
      // stopped warning about text-optional entirely.
      const layout = { 'text-optional': ['step', ['zoom'], false, 14, true] }
      expect(emit(layout)).not.toContain('label-text-optional')
      const hits = compile(layout).filter((w) => w.includes('text-optional'))
      expect(hits.length).toBe(1)
      expect(hits[0]).toContain('non-constant')
    })
  })

  // icon-optional is now implemented (Phase S Batch 4) — `true` emits the
  // `label-icon-optional` utility instead of a deferral warning; the default
  // `false` stays silent. (icon-side ARBITRATION coverage is asserted in
  // icon-collision-policy.test.ts.)
  describe('icon-optional', () => {
    it('default false → no warning (OFM label_city/town shape)', () => {
      const warnings = compile({ 'icon-optional': false })
      expect(warnings.filter((w) => w.includes('icon-optional'))).toEqual([])
    })

    it('true → no warning (implemented; carried as label-icon-optional)', () => {
      const warnings = compile({ 'icon-optional': true })
      expect(warnings.filter((w) => w.includes('icon-optional'))).toEqual([])
    })
  })

  it('both true → NO optional warning; both utilities emitted (#2440 closed the pair)', () => {
    // Was: exactly one warning, text-optional's. Both are implemented now, so
    // the assertion is that both are CARRIED — the shape that would catch one
    // of the two regressing to a silent drop.
    expect(
      compile({ 'text-optional': true, 'icon-optional': true }).filter((w) => /optional/.test(w)),
    ).toEqual([])
    const src = emit({ 'text-optional': true, 'icon-optional': true })
    expect(src).toContain('label-text-optional')
    expect(src).toContain('label-icon-optional')
  })
})
