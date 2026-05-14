// Pure-function test for per-font typography lookup. Validates the
// fontKey → (letterSpacingEm, lineHeightScale) resolution that feeds
// the layer-level letter-spacing and line-height math during prepare().

import { describe, it, expect } from 'vitest'
import { resolveTypography } from './text-stage'

describe('resolveTypography', () => {
  it('returns identity when no table is configured', () => {
    expect(resolveTypography('Open Sans', null)).toEqual({
      letterSpacingEm: 0, lineHeightScale: 1,
    })
    expect(resolveTypography('Open Sans', undefined)).toEqual({
      letterSpacingEm: 0, lineHeightScale: 1,
    })
  })

  it('matches a plain (sentinel-less) fontKey by its primary family', () => {
    const t = new Map([['Noto Sans', { letterSpacingEm: -0.02, lineHeightScale: 1.05 }]])
    expect(resolveTypography('Noto Sans,"Noto Sans CJK KR",sans-serif', t)).toEqual({
      letterSpacingEm: -0.02, lineHeightScale: 1.05,
    })
  })

  it('extracts family from a sentinel-encoded fontKey', () => {
    const t = new Map([['Open Sans', { letterSpacingEm: 0.01, lineHeightScale: 1 }]])
    const fontKey = '\x01italic\x01600\x01Open Sans,"Noto Sans CJK KR",sans-serif'
    expect(resolveTypography(fontKey, t)).toEqual({
      letterSpacingEm: 0.01, lineHeightScale: 1,
    })
  })

  it('strips surrounding quotes from CSS-quoted families', () => {
    const t = new Map([['Custom Font', { letterSpacingEm: -0.03, lineHeightScale: 1 }]])
    expect(resolveTypography('"Custom Font",sans-serif', t)).toEqual({
      letterSpacingEm: -0.03, lineHeightScale: 1,
    })
  })

  it('returns identity for families with no entry in the table', () => {
    const t = new Map([['Open Sans', { letterSpacingEm: -0.02, lineHeightScale: 1 }]])
    expect(resolveTypography('Noto Sans', t)).toEqual({
      letterSpacingEm: 0, lineHeightScale: 1,
    })
  })

  it('handles a single-family fontKey without a comma list', () => {
    const t = new Map([['Roboto', { letterSpacingEm: 0.005, lineHeightScale: 1.1 }]])
    expect(resolveTypography('Roboto', t)).toEqual({
      letterSpacingEm: 0.005, lineHeightScale: 1.1,
    })
  })

  it('first family wins — fallback chain entries are ignored', () => {
    const t = new Map([
      ['Open Sans', { letterSpacingEm: -0.01, lineHeightScale: 1 }],
      ['Noto Sans CJK KR', { letterSpacingEm: -0.05, lineHeightScale: 1 }],
    ])
    expect(resolveTypography('Open Sans,"Noto Sans CJK KR"', t)).toEqual({
      letterSpacingEm: -0.01, lineHeightScale: 1,
    })
  })
})
