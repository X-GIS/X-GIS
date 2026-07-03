// Pin: a boolean paint prop authored as a ZOOM/DATA expression must
// WARN (surface the loss), not drop silently.
//
// Bug: paint-fill.ts only unwrapped a `["literal", …]` wrapper then
// tested `aa === false`. A step/interpolate expression form (e.g.
// `["step", ["zoom"], false, 9, true]` on OFM-bright landcover-wood)
// makes `aa` an array, the `=== false` test is false, NOTHING is
// emitted and NO warning fires — a silent drop. Same latent shape in
// paint-fill-extrusion.ts for `fill-extrusion-vertical-gradient`.
//
// Fix (this scope): warn so the loss is surfaced. Full zoom-expr
// antialias / vertical-gradient support is explicitly out of scope.

import { describe, it, expect } from 'vitest'
import { convertLayer } from '../convert/layers'

const STEP_ZOOM_BOOL = ['step', ['zoom'], false, 9, true] as unknown

describe('boolean paint prop as zoom-expression warns instead of dropping silently', () => {
  it('fill-antialias zoom-expression → warning fires (fail-before: was silent)', () => {
    const warnings: string[] = []
    convertLayer(
      {
        id: 'landcover-wood',
        type: 'fill',
        source: 'osm',
        'source-layer': 'landcover',
        paint: { 'fill-color': '#a0c0a0', 'fill-antialias': STEP_ZOOM_BOOL },
      } as never,
      warnings,
    )
    expect(warnings.some((w) => /fill-antialias/i.test(w))).toBe(true)
  })

  it('fill-extrusion-vertical-gradient zoom-expression → warning fires (fail-before: was silent)', () => {
    const warnings: string[] = []
    convertLayer(
      {
        id: 'bldg',
        type: 'fill-extrusion',
        source: 'osm',
        'source-layer': 'building',
        paint: {
          'fill-extrusion-color': '#ccc',
          'fill-extrusion-vertical-gradient': STEP_ZOOM_BOOL,
        },
      } as never,
      warnings,
    )
    expect(warnings.some((w) => /vertical-gradient/i.test(w))).toBe(true)
  })

  it('regression: constant false still emits the flag with no spurious warning', () => {
    const warnings: string[] = []
    const out = convertLayer(
      {
        id: 'c',
        type: 'fill',
        source: 's',
        'source-layer': 'l',
        paint: { 'fill-color': '#fff', 'fill-antialias': false },
      } as never,
      warnings,
    )
    expect(out).toContain('fill-antialias-false')
    expect(warnings.some((w) => /fill-antialias/i.test(w))).toBe(false)
  })

  it('regression: ["literal", false] still emits the flag with no spurious warning', () => {
    const warnings: string[] = []
    const out = convertLayer(
      {
        id: 'c',
        type: 'fill',
        source: 's',
        'source-layer': 'l',
        paint: { 'fill-color': '#fff', 'fill-antialias': ['literal', false] as unknown },
      } as never,
      warnings,
    )
    expect(out).toContain('fill-antialias-false')
    expect(warnings.some((w) => /fill-antialias/i.test(w))).toBe(false)
  })

  it('regression: constant true (and unauthored default) emits no flag and no warning', () => {
    for (const paint of [
      { 'fill-color': '#fff', 'fill-antialias': true },
      { 'fill-color': '#fff' },
    ]) {
      const warnings: string[] = []
      const out = convertLayer(
        { id: 'c', type: 'fill', source: 's', 'source-layer': 'l', paint } as never,
        warnings,
      )
      expect(out).not.toContain('fill-antialias')
      expect(warnings.some((w) => /fill-antialias/i.test(w))).toBe(false)
    }
  })
})
