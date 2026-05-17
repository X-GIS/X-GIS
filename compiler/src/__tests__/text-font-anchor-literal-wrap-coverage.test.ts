// Pin v8-strict `["literal", [...]]` unwrap on the array-valued
// layout knobs `text-font` + `text-variable-anchor` +
// `text-variable-anchor-offset`. Pre-fix the outer Array.isArray
// passed AND the iteration consumed the operator string "literal"
// as if it were a font / anchor name — producing utilities like
// `label-font-literal` and silently dropping the real candidates.

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

describe('text-font literal-wrap unwrap', () => {
  it('bare array: ["Noto Sans"] emits label-font-Noto-Sans', () => {
    const out = emit({ 'text-font': ['Noto Sans'] })
    expect(out).toContain('label-font-Noto-Sans')
    expect(out).not.toContain('label-font-literal')
  })

  it('v8 strict ["literal", ["Noto Sans"]] also emits label-font-Noto-Sans', () => {
    const out = emit({ 'text-font': ['literal', ['Noto Sans']] })
    expect(out).toContain('label-font-Noto-Sans')
    expect(out).not.toContain('label-font-literal')
  })

  it('wrapped multi-stack ["literal", ["Noto Sans","Noto Sans CJK"]] emits both', () => {
    const out = emit({ 'text-font': ['literal', ['Noto Sans', 'Noto Sans CJK KR']] })
    expect(out).toContain('label-font-Noto-Sans')
    expect(out).toContain('label-font-Noto-Sans-CJK-KR')
  })
})

describe('text-variable-anchor literal-wrap unwrap', () => {
  it('bare array: ["top","bottom"] emits one label-anchor-X per candidate', () => {
    const out = emit({ 'text-variable-anchor': ['top', 'bottom'] })
    expect(out).toContain('label-anchor-top')
    expect(out).toContain('label-anchor-bottom')
  })

  it('v8 strict ["literal", ["top","bottom"]] emits the same', () => {
    const out = emit({ 'text-variable-anchor': ['literal', ['top', 'bottom']] })
    expect(out).toContain('label-anchor-top')
    expect(out).toContain('label-anchor-bottom')
    // Critical: the operator string "literal" must NOT leak as an
    // anchor name. VALID_ANCHORS rejects it but a future refactor
    // could relax the check; pin the negative explicitly.
    expect(out).not.toContain('label-anchor-literal')
  })

  it('invalid anchor names in the unwrapped list are still filtered', () => {
    const out = emit({ 'text-variable-anchor': ['literal', ['top', 'nonsense', 'bottom']] })
    expect(out).toContain('label-anchor-top')
    expect(out).toContain('label-anchor-bottom')
    expect(out).not.toContain('label-anchor-nonsense')
  })
})
