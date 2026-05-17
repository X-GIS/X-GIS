// Pin negative-clamp on line-width per Mapbox spec
// (paint.line-width >= 0). Pre-fix a typo'd negative literal
// emitted `stroke--5` — a double-dash utility name the parser
// split incorrectly and the whole layer crashed.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function emitLine(width: unknown): string {
  return convertMapboxStyle({
    version: 8,
    sources: { v: { type: 'vector', url: 'x.pmtiles' } },
    layers: [{
      id: 'l',
      type: 'line',
      source: 'v',
      'source-layer': 'transportation',
      paint: { 'line-color': '#000', 'line-width': width },
    }],
  } as never)
}

describe('line-width negative-clamp', () => {
  it('line-width: 5 emits stroke-5 (regression guard)', () => {
    expect(emitLine(5)).toContain('stroke-5')
  })

  it('line-width: -5 clamps to stroke-0 (out-of-range guard)', () => {
    const out = emitLine(-5)
    expect(out).toContain('stroke-0')
    expect(out).not.toMatch(/stroke--/)
  })

  it('line-width: 0 emits stroke-0', () => {
    expect(emitLine(0)).toContain('stroke-0')
  })

  it('interpolate-by-zoom with negative stop also clamps per-stop', () => {
    // Each stop in an interp-zoom width can be 0; negatives are
    // out-of-spec but the converter shouldn't emit a malformed name.
    const out = emitLine(['interpolate', ['linear'], ['zoom'], 10, -1, 16, 8])
    expect(out).toMatch(/stroke-\[interpolate\(zoom,\s*10,\s*0,\s*16,\s*8\)\]/)
  })
})
