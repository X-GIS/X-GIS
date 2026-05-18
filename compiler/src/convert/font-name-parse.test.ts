// Coverage for parseMapboxFontName — Mapbox font-name parsing into
// family / weight / style. Covers the standard OFM forms, mixed-
// order keywords, two-word weight forms, case-insensitive lookup,
// and the iter-415 degenerate-input fallback (every word is a
// weight/style keyword → return original as family).

import { describe, it, expect } from 'vitest'
import { parseMapboxFontName } from './layers'

describe('parseMapboxFontName', () => {
  it('plain family with no weight/style', () => {
    expect(parseMapboxFontName('Noto Sans')).toEqual({ family: 'Noto Sans' })
  })

  it('Regular keyword folds into weight 400', () => {
    expect(parseMapboxFontName('Noto Sans Regular')).toEqual({
      family: 'Noto Sans', weight: 400,
    })
  })

  it('Bold keyword folds into weight 700', () => {
    expect(parseMapboxFontName('Open Sans Bold')).toEqual({
      family: 'Open Sans', weight: 700,
    })
  })

  it('Italic keyword folds into style', () => {
    expect(parseMapboxFontName('Open Sans Italic')).toEqual({
      family: 'Open Sans', style: 'italic',
    })
  })

  it('Bold + Italic both parsed (Bold Italic order)', () => {
    expect(parseMapboxFontName('Open Sans Bold Italic')).toEqual({
      family: 'Open Sans', weight: 700, style: 'italic',
    })
  })

  it('reverse Italic + Bold order also parses both', () => {
    expect(parseMapboxFontName('Open Sans Italic Bold')).toEqual({
      family: 'Open Sans', weight: 700, style: 'italic',
    })
  })

  it('two-word weight (Semi Bold) preferred over Bold-only', () => {
    expect(parseMapboxFontName('Roboto Semi Bold')).toEqual({
      family: 'Roboto', weight: 600,
    })
  })

  it('case-insensitive: "semibold" parses as Semibold', () => {
    expect(parseMapboxFontName('Roboto semibold')).toEqual({
      family: 'Roboto', weight: 600,
    })
  })

  it('case-insensitive: "italic" parses as Italic', () => {
    expect(parseMapboxFontName('Roboto italic')).toEqual({
      family: 'Roboto', style: 'italic',
    })
  })

  // iter 415 — degenerate fallback
  it('all-keyword input falls back to original name as family', () => {
    expect(parseMapboxFontName('Bold Italic')).toEqual({
      family: 'Bold Italic',
    })
  })

  it('all-keyword single-token also falls back', () => {
    expect(parseMapboxFontName('Bold')).toEqual({ family: 'Bold' })
  })

  it('whitespace trimmed', () => {
    expect(parseMapboxFontName('  Noto Sans Regular  ')).toEqual({
      family: 'Noto Sans', weight: 400,
    })
  })

  // iter 417 — Heavy weight maps to 900 per CSS / OpenType
  it('Heavy keyword maps to weight 900 (matches Black, not ExtraBold)', () => {
    expect(parseMapboxFontName('Roboto Heavy')).toEqual({
      family: 'Roboto', weight: 900,
    })
  })

  it('Black keyword maps to weight 900', () => {
    expect(parseMapboxFontName('Roboto Black')).toEqual({
      family: 'Roboto', weight: 900,
    })
  })

  // iter 441 — Roman = PostScript convention for regular
  it('Roman keyword maps to weight 400 (PostScript convention)', () => {
    expect(parseMapboxFontName('Times Roman')).toEqual({
      family: 'Times', weight: 400,
    })
  })

  it('Roman + Italic both parsed', () => {
    expect(parseMapboxFontName('Times Roman Italic')).toEqual({
      family: 'Times', weight: 400, style: 'italic',
    })
  })
})
