// Pin Mapbox `["collator", …]` drop on comparison ops + `["array", …]`
// type-assertion pass-through. Both shapes appeared in OFM styles
// (collator on case-insensitive class compares; array on point-pair
// circle-translate authoring) and pre-fix dropped the WHOLE expression
// because the converter expected fixed 3-arg comparison and had no
// `array` case.

import { describe, it, expect } from 'vitest'
import { exprToXgis } from '../convert/expressions'

describe('comparison ops with trailing collator', () => {
  it('["==", a, b, ["collator", …]] drops collator, keeps compare', () => {
    const w: string[] = []
    const out = exprToXgis(
      ['==', ['get', 'class'], 'primary',
        ['collator', { 'case-sensitive': false }]],
      w,
    )
    expect(out).toBe('.class == "primary"')
    expect(w.some(s => s.includes('collator') && s.includes('byte-exact'))).toBe(true)
  })

  it('["<", a, b, ["collator", …]] drops collator on ordering compare', () => {
    const w: string[] = []
    const out = exprToXgis(
      ['<', ['get', 'name'], 'Z',
        ['collator', { locale: 'en' }]],
      w,
    )
    expect(out).toBe('.name < "Z"')
  })

  it('3-arg comparison without collator unchanged (regression guard)', () => {
    const w: string[] = []
    expect(exprToXgis(['==', ['get', 'kind'], 'park'], w))
      .toBe('.kind == "park"')
    expect(w).toEqual([])
  })

  it('4-arg comparison with non-collator 4th arg returns null (malformed)', () => {
    // Not a collator — should hit the length-check below and reject.
    const w: string[] = []
    expect(exprToXgis(['==', 1, 2, 3], w)).toBeNull()
  })
})

describe('["array", …] type assertion lowering', () => {
  it('["array", value] passes value through', () => {
    const w: string[] = []
    expect(exprToXgis(['array', ['get', 'pts']], w)).toBe('.pts')
  })

  it('["array", "number", value] drops type and passes value', () => {
    const w: string[] = []
    expect(exprToXgis(['array', 'number', ['get', 'pts']], w)).toBe('.pts')
  })

  it('["array", "number", 2, value] drops type+length and passes value', () => {
    const w: string[] = []
    expect(exprToXgis(['array', 'number', 2, ['get', 'pts']], w)).toBe('.pts')
  })

  it('["array", "number", 2, ["literal", [1, 2]]] works with literal-array inner', () => {
    const w: string[] = []
    expect(exprToXgis(['array', 'number', 2, ['literal', [1, 2]]], w))
      .toBe('[1, 2]')
  })
})
