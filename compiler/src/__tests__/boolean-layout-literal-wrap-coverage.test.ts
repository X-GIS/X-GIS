// Pin v8-strict `["literal", value]` unwrap on the boolean / enum
// symbol-layout knobs. Pre-fix the converter did raw === comparisons
// against the wrapped value and missed every match — the symbol
// laid out with default collision / orientation despite the style
// declaring an override.

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
      layout: { 'text-field': '{name}', ...symbol },
    }],
  } as never)
}

describe('text-overlap literal-wrap unwrap', () => {
  it('bare "always" emits label-allow-overlap', () => {
    expect(emit({ 'text-overlap': 'always' })).toContain('label-allow-overlap')
  })

  it('wrapped ["literal", "always"] also emits label-allow-overlap', () => {
    expect(emit({ 'text-overlap': ['literal', 'always'] })).toContain('label-allow-overlap')
  })

  it('wrapped ["literal", "never"] suppresses the utility', () => {
    const out = emit({ 'text-overlap': ['literal', 'never'] })
    expect(out).not.toContain('label-allow-overlap')
  })
})

describe('text-allow-overlap literal-wrap unwrap', () => {
  it('bare true emits label-allow-overlap', () => {
    expect(emit({ 'text-allow-overlap': true })).toContain('label-allow-overlap')
  })

  it('wrapped ["literal", true] also emits label-allow-overlap', () => {
    expect(emit({ 'text-allow-overlap': ['literal', true] })).toContain('label-allow-overlap')
  })
})

describe('text-ignore-placement literal-wrap unwrap', () => {
  it('bare true emits label-ignore-placement', () => {
    expect(emit({ 'text-ignore-placement': true })).toContain('label-ignore-placement')
  })

  it('wrapped ["literal", true] also emits label-ignore-placement', () => {
    expect(emit({ 'text-ignore-placement': ['literal', true] })).toContain('label-ignore-placement')
  })
})

describe('text-keep-upright literal-wrap unwrap', () => {
  it('bare false emits label-keep-upright-false', () => {
    expect(emit({ 'text-keep-upright': false })).toContain('label-keep-upright-false')
  })

  it('wrapped ["literal", false] also emits label-keep-upright-false', () => {
    expect(emit({ 'text-keep-upright': ['literal', false] })).toContain('label-keep-upright-false')
  })

  it('wrapped ["literal", true] emits the explicit true utility', () => {
    expect(emit({ 'text-keep-upright': ['literal', true] })).toContain('label-keep-upright-true')
  })
})
