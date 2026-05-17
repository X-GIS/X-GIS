// Pin v8-strict `["literal", "<enum>"]` unwrap on the remaining
// symbol-layout enum knobs: text-rotation-alignment, text-pitch-
// alignment, symbol-placement. Pre-fix raw === comparisons missed
// the wrapped value and the label fell back to runtime defaults
// (auto / point).

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function emit(layout: Record<string, unknown>): string {
  return convertMapboxStyle({
    version: 8,
    sources: { v: { type: 'vector', url: 'x.pmtiles' } },
    layers: [{
      id: 'l',
      type: 'symbol',
      source: 'v',
      'source-layer': 'place',
      layout: { 'text-field': '{name}', ...layout },
    }],
  } as never)
}

describe('text-rotation-alignment literal-wrap unwrap', () => {
  it('bare "viewport" emits label-rotation-alignment-viewport', () => {
    expect(emit({ 'text-rotation-alignment': 'viewport' }))
      .toContain('label-rotation-alignment-viewport')
  })

  it('wrapped ["literal", "map"] emits label-rotation-alignment-map', () => {
    expect(emit({ 'text-rotation-alignment': ['literal', 'map'] }))
      .toContain('label-rotation-alignment-map')
  })
})

describe('text-pitch-alignment literal-wrap unwrap', () => {
  it('bare "map" emits label-pitch-alignment-map', () => {
    expect(emit({ 'text-pitch-alignment': 'map' }))
      .toContain('label-pitch-alignment-map')
  })

  it('wrapped ["literal", "auto"] emits label-pitch-alignment-auto', () => {
    expect(emit({ 'text-pitch-alignment': ['literal', 'auto'] }))
      .toContain('label-pitch-alignment-auto')
  })
})

describe('symbol-placement literal-wrap unwrap', () => {
  it('bare "line" emits label-along-path', () => {
    expect(emit({ 'symbol-placement': 'line' })).toContain('label-along-path')
  })

  it('wrapped ["literal", "line"] also emits label-along-path', () => {
    // Pre-fix the wrap defeated the === 'line' check and the layer
    // fell to point placement (default), so road / waterway labels
    // anchored at a single tile-centre instead of following the line.
    expect(emit({ 'symbol-placement': ['literal', 'line'] }))
      .toContain('label-along-path')
  })

  it('wrapped ["literal", "line-center"] emits label-line-center', () => {
    expect(emit({ 'symbol-placement': ['literal', 'line-center'] }))
      .toContain('label-line-center')
  })

  it('wrapped ["literal", "line"] also gates text-max-width default off', () => {
    // Side-effect of the fix: max-width default of 10 em should only
    // emit when placement is NOT line / line-center. With the unwrap
    // the wrapped "line" suppresses the default — without it the
    // default leaked in and line labels wrapped at the 10-em mark.
    const out = emit({ 'symbol-placement': ['literal', 'line'] })
    expect(out).not.toContain('label-max-width-10')
  })
})
