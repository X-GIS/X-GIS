// format() partial-drop semantics. Mapbox v8 format expression is
// `["format", text1, opts1, text2, opts2, …]` — a chain of text
// sections each with an options object. Pre-fix the converter
// bailed the WHOLE format expression when any one section failed
// to convert (e.g. a section using an unsupported accessor like
// `["image"]`). Side effect: the label dropped silently with no
// hint that only ONE inner section was unconvertible.
//
// Plan §1 follow-through: emit the surviving sections; only bail
// when ALL sections failed. Mirrors coalesce / case / match / concat
// partial-drop pattern.

import { describe, expect, it } from 'vitest'
import { exprToXgis } from '../convert/expressions'

describe('format() partial-drop', () => {
  it('all sections succeed → concat of all texts, no warning', () => {
    const warnings: string[] = []
    const result = exprToXgis(
      ['format', ['get', 'name'], {}, ' (', {}, ['to-string', ['get', 'pop']], {}, ')', {}],
      warnings,
    )
    expect(result).not.toBeNull()
    expect(result).toContain('concat')
    expect(warnings.some((w) => w.includes('failed to convert'))).toBe(false)
  })

  it('one section fails → surviving sections concat with partial-drop warning', () => {
    const warnings: string[] = []
    const result = exprToXgis(
      [
        'format',
        ['get', 'name'],
        {},
        ' ',
        {},
        ['image', 'icon'],
        {}, // unsupported — silently drops pre-fix, now warns + skipped
        ' fallback',
        {},
      ],
      warnings,
    )
    expect(result).not.toBeNull()
    // The surviving sections should still appear in output
    expect(result).toContain('.name')
    expect(result).toContain('fallback')
    // Warning surfaces WHICH section dropped
    const w = warnings.find(
      (w) => w.includes('["format"] section') && w.includes('dropped from concat'),
    )
    expect(w).toBeDefined()
  })

  it('ALL sections fail → returns null with "all sections failed" warning', () => {
    const warnings: string[] = []
    const result = exprToXgis(['format', ['image', 'a'], {}, ['image', 'b'], {}], warnings)
    expect(result).toBeNull()
    expect(warnings.some((w) => w.includes('all') && w.includes('sections failed'))).toBe(true)
  })

  it('single-section format with surviving text returns the bare text (no concat wrap)', () => {
    const warnings: string[] = []
    const result = exprToXgis(['format', ['get', 'name'], {}], warnings)
    expect(result).not.toBeNull()
    // Single section → just .name (no concat() wrap per existing convention)
    expect(result).toBe('.name')
  })
})
