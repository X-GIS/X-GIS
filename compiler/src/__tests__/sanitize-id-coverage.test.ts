// Pin sanitizeId's identifier-shaping rules. The parser requires
// `[a-zA-Z_][a-zA-Z0-9_]*` for layer / source ids; Mapbox styles in
// the wild use kebab-case AND digit-leading names (1km-grid,
// 3d-buildings, 2-color-stripes, …) so the converter has to massage
// both into valid xgis identifiers.

import { describe, it, expect } from 'vitest'
import { sanitizeId } from '../convert/utils'

describe('sanitizeId — id shaping rules', () => {
  it('passes through valid identifiers unchanged', () => {
    expect(sanitizeId('road_major')).toBe('road_major')
    expect(sanitizeId('water')).toBe('water')
    expect(sanitizeId('_internal')).toBe('_internal')
    expect(sanitizeId('a1b2')).toBe('a1b2')
  })

  it('replaces dashes with underscores', () => {
    expect(sanitizeId('road-major')).toBe('road_major')
    expect(sanitizeId('admin-boundary-1')).toBe('admin_boundary_1')
  })

  it('replaces other non-identifier chars with underscores', () => {
    expect(sanitizeId('road.major')).toBe('road_major')
    expect(sanitizeId('road/major')).toBe('road_major')
    expect(sanitizeId('road major')).toBe('road_major')
  })

  it('prefixes digit-leading ids with underscore', () => {
    // Pre-fix `1km-grid` cleaned to `1km_grid` — still starts with
    // a digit, so the parser rejected it at lex time. With the
    // prefix it becomes `_1km_grid`, a well-formed identifier.
    expect(sanitizeId('1km-grid')).toBe('_1km_grid')
    expect(sanitizeId('3d-buildings')).toBe('_3d_buildings')
    expect(sanitizeId('2-color-stripes')).toBe('_2_color_stripes')
    expect(sanitizeId('100')).toBe('_100')
  })

  it('suffixes xgis-reserved keywords with underscore', () => {
    expect(sanitizeId('place')).toBe('place_')
    expect(sanitizeId('layer')).toBe('layer_')
    expect(sanitizeId('source')).toBe('source_')
    expect(sanitizeId('background')).toBe('background_')
    expect(sanitizeId('symbol')).toBe('symbol_')
    expect(sanitizeId('true')).toBe('true_')
  })

  it('combines digit prefix + reserved-keyword suffix when both apply', () => {
    // Synthetic edge — a digit-leading name that, after prefix, happens
    // to land on a reserved word is implausible in practice; the prefix
    // adds `_` which can never reach a reserved keyword. Pin the
    // contract anyway so a future refactor doesn't accidentally re-order
    // the rules.
    expect(sanitizeId('1place')).toBe('_1place')
  })
})
