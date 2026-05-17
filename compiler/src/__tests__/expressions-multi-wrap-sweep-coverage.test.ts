// Pin multi-level literal-wrap unwrap across the remaining
// per-element sites in expressions.ts: in / !in legacy + expression
// forms, matchToTernary, matchToBooleanFilter keys + values, rgb /
// rgba channels, legacy comparison RHS. Each was single-pass; v8
// strict preprocessor chains can emit ['literal', ['literal', v]]
// and the single-pass peel left an inner wrapper that broke the
// downstream type / shape check.

import { describe, it, expect } from 'vitest'
import { exprToXgis, filterToXgis } from '../convert/expressions'

describe('expressions multi-level literal-wrap sweep', () => {
  it('legacy ["==", field, ["literal", ["literal", "park"]]] matches scalar', () => {
    const w: string[] = []
    const out = filterToXgis(['==', 'kind', ['literal', ['literal', 'park']]], w)
    expect(out).toBe('.kind == "park"')
  })

  it('legacy ["!in", field, ["literal", ["literal", "park"]]] negates scalar', () => {
    const w: string[] = []
    const out = filterToXgis(['!in', 'kind', ['literal', ['literal', 'park']]], w)
    expect(out).toBe('.kind != "park"')
  })

  it('["in", get, ["literal", [["literal", ["literal", "a"]]]]] still emits == "a"', () => {
    const w: string[] = []
    const out = exprToXgis(
      ['in', ['get', 'kind'], ['literal', [['literal', ['literal', 'a']]]]],
      w,
    )
    expect(out).toContain('"a"')
    expect(out).not.toContain('"literal"')
  })

  it('matchToTernary handles double-wrapped keys', () => {
    // Complex input forces matchToTernary path.
    const w: string[] = []
    const out = exprToXgis(
      ['match', ['concat', ['get', 'a'], ['get', 'b']],
        ['literal', ['literal', 'x']], 1,
        0,
      ],
      w,
    )
    expect(out).toContain('== "x"')
    expect(out).not.toContain('"literal"')
  })

  it('matchToBooleanFilter handles double-wrapped boolean values', () => {
    const w: string[] = []
    const out = filterToXgis(
      ['match', ['get', 'class'],
        'park', ['literal', ['literal', true]],
        ['literal', ['literal', false]],
      ],
      w,
    )
    expect(out).toContain('.class == "park"')
  })

  it('rgb with double-wrapped channels still hex-encodes at convert time', () => {
    const w: string[] = []
    const out = exprToXgis(
      ['rgb',
        ['literal', ['literal', 255]],
        ['literal', ['literal', 128]],
        ['literal', ['literal', 64]],
      ],
      w,
    )
    expect(out).toBe('#ff8040')
  })
})
