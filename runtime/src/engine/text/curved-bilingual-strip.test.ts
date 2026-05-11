// Mapbox `text-field: concat(name:latin, "\n", name:nonlatin)` is
// the bilingual stacking idiom used by OFM Bright + OSM Bright +
// most international basemaps. For POINT labels the runtime breaks
// at the LF and stacks the two scripts as two lines (PR #76).
//
// For ALONG-PATH (curved-line) road labels, however, the same LF
// would render side-by-side along the road since the curve sampler
// walks glyphs head-to-tail along the polyline. Mapbox's reference
// rendering shows only the PRIMARY (Latin) script along the road;
// the secondary script never appears along a curve.
//
// `stripCurveLineExtraScripts` is the pure helper applied at
// addCurvedLineLabel's entry point that drops everything from the
// first LF onwards before shaping.

import { describe, it, expect } from 'vitest'
import { stripCurveLineExtraScripts } from './text-stage-helpers'

describe('stripCurveLineExtraScripts', () => {
  it('strips text from the first LF onwards', () => {
    expect(stripCurveLineExtraScripts('Pureundeul pan-ro\n푸른들판로'))
      .toBe('Pureundeul pan-ro')
  })

  it('mono-script text passes through unchanged', () => {
    expect(stripCurveLineExtraScripts('Main Street')).toBe('Main Street')
  })

  it('text starting with LF collapses to empty (caller skips)', () => {
    expect(stripCurveLineExtraScripts('\n푸른들판로')).toBe('')
  })

  it('multiple LFs only keep the first segment', () => {
    expect(stripCurveLineExtraScripts('A\nB\nC')).toBe('A')
  })

  it('empty input stays empty', () => {
    expect(stripCurveLineExtraScripts('')).toBe('')
  })

  it('non-bilingual text with trailing whitespace passes through', () => {
    expect(stripCurveLineExtraScripts('Baran-ro   ')).toBe('Baran-ro   ')
  })
})
