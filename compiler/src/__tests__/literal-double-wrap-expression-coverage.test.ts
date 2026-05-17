// Pin exprToXgis 'literal' case multi-level wrap unwrap.
// `["literal", ["literal", value]]` (v8 strict preprocessor double-
// wrap) pre-fix entered the Array.isArray inner branch and emitted
// the wrapper itself as a 2-element xgis array `["literal", value]`,
// silently turning a scalar into a 2-element array at runtime.

import { describe, it, expect } from 'vitest'
import { exprToXgis, filterToXgis } from '../convert/expressions'

describe('case literal multi-level wrap', () => {
  it('double-wrapped scalar inside ["==", get, ...] still emits == value', () => {
    const w: string[] = []
    const out = filterToXgis(
      ['==', ['get', 'class'], ['literal', ['literal', 'park']]],
      w,
    )
    // Should be a scalar comparison, not array-vs-string.
    expect(out).toContain('"park"')
    expect(out).not.toContain('"literal"')
  })

  it('double-wrapped numeric inside match key still emits scalar key', () => {
    const w: string[] = []
    const out = exprToXgis(
      ['match', ['get', 'rank'],
        ['literal', ['literal', 5]], '#f00',
        '#000',
      ],
      w,
    )
    expect(out).toContain('5 -> "#f00"')
    expect(out).not.toContain('"literal"')
  })

  it('single-wrap scalar (regression guard)', () => {
    const w: string[] = []
    const out = exprToXgis(['literal', 42], w)
    expect(out).toBe('42')
  })

  it('single-wrap array (regression guard)', () => {
    const w: string[] = []
    const out = exprToXgis(['literal', [1, 2, 3]], w)
    expect(out).toBe('[1, 2, 3]')
  })

  it('triple-wrap scalar also peels in one pass', () => {
    const w: string[] = []
    const out = exprToXgis(['literal', ['literal', ['literal', 'foo']]], w)
    expect(out).toBe('"foo"')
  })
})
