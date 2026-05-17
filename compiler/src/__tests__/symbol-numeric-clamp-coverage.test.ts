// Pin negative-clamp on text-size + text-halo-width per Mapbox
// spec (both >= 0). Pre-fix a typo'd negative literal emitted
// `label-size--5` / `label-halo--2` (double-dash utility names)
// that the parser split incorrectly — the symbol layer crashed.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function emit(symbol: Record<string, unknown>): string {
  return convertMapboxStyle({
    version: 8,
    sources: { v: { type: 'vector', url: 'x.pmtiles' } },
    layers: [{
      id: 'l',
      type: 'symbol',
      source: 'v',
      'source-layer': 'place',
      layout: { 'text-field': '{name}', ...(symbol.layout as object ?? {}) },
      paint: (symbol.paint as object) ?? {},
    }],
  } as never)
}

describe('text-size negative-clamp', () => {
  it('text-size: 16 emits label-size-16 (regression guard)', () => {
    expect(emit({ layout: { 'text-size': 16 } })).toContain('label-size-16')
  })

  it('text-size: -5 clamps to label-size-0', () => {
    const out = emit({ layout: { 'text-size': -5 } })
    expect(out).toContain('label-size-0')
    expect(out).not.toMatch(/label-size--/)
  })

  it('interpolate-by-zoom with negative text-size stop clamps per-stop', () => {
    const out = emit({
      layout: {
        'text-size': ['interpolate', ['linear'], ['zoom'], 10, -8, 16, 24],
      },
    })
    expect(out).toMatch(/label-size-\[interpolate\(zoom,\s*10,\s*0,\s*16,\s*24\)\]/)
  })
})

describe('text-halo-width negative-clamp', () => {
  it('text-halo-width: 2 emits label-halo-2', () => {
    expect(emit({ paint: { 'text-halo-width': 2 } })).toContain('label-halo-2')
  })

  it('text-halo-width: -2 produces no halo utility (gate already requires > 0)', () => {
    // Negative passes the `> 0` gate as false → falls through. No halo
    // utility emitted; no malformed double-dash.
    const out = emit({ paint: { 'text-halo-width': -2 } })
    expect(out).not.toMatch(/label-halo--/)
    expect(out).not.toContain('label-halo-2')
  })

  it('interpolate-zoom with negative halo-width stop clamps', () => {
    const out = emit({
      paint: {
        'text-halo-width': ['interpolate', ['linear'], ['zoom'], 8, -1, 16, 2],
      },
    })
    expect(out).toMatch(/label-halo-\[interpolate\(zoom,\s*8,\s*0,\s*16,\s*2\)\]/)
  })
})
