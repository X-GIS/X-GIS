// Pin JSON.stringify-based escaping for get / has / !has field
// names. The hand-rolled escape only covered `\` and `"`; field names
// with control chars (newline, tab) or unicode escapes broke the
// emitted xgis at lex time. JSON.stringify covers the full set.

import { describe, it, expect } from 'vitest'
import { exprToXgis, filterToXgis } from '../convert/expressions'

describe('get/has field-name escape via JSON.stringify', () => {
  it('get with control char in field name emits valid escape', () => {
    const w: string[] = []
    const out = exprToXgis(['get', 'with\nnewline'], w)
    expect(out).toBe('get("with\\nnewline")')
  })

  it('has with embedded quote emits proper escape', () => {
    const w: string[] = []
    const out = filterToXgis(['has', 'a"b'], w)
    expect(out).toBe('get("a\\"b") != null')
  })

  it('!has with backslash emits proper escape', () => {
    const w: string[] = []
    const out = filterToXgis(['!has', 'a\\b'], w)
    expect(out).toBe('get("a\\\\b") == null')
  })

  it('regression: plain colon-bearing locale key still works', () => {
    const w: string[] = []
    const out = exprToXgis(['get', 'name:latin'], w)
    expect(out).toBe('get("name:latin")')
  })
})
