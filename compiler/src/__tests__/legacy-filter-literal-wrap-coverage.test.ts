// Pin v8 strict literal-wrap unwrap on the legacy filter forms:
//   ["==", "field", "value"]    (legacy v0/v1)
//   ["!in", "field", v1, v2, …] (legacy v0/v1)
// Pre-fix a wrapped value (`["literal", "park"]`) skipped the
// fast-path is-array gate and fell to exprToXgis, which emitted
// `"field" == "park"` (literal-vs-literal, always false). The
// filter dropped every feature.

import { describe, it, expect } from 'vitest'
import { filterToXgis } from '../convert/expressions'

describe('legacy filter forms with literal-wrapped values', () => {
  it('["==", "kind", ["literal", "park"]] → .kind == "park"', () => {
    const w: string[] = []
    expect(filterToXgis(['==', 'kind', ['literal', 'park']], w))
      .toBe('.kind == "park"')
  })

  it('["!=", "kind", ["literal", "water"]] → .kind != "water"', () => {
    const w: string[] = []
    expect(filterToXgis(['!=', 'kind', ['literal', 'water']], w))
      .toBe('.kind != "water"')
  })

  it('["!in", "kind", ["literal", "park"], "forest"] mixed wrap form', () => {
    const w: string[] = []
    expect(filterToXgis(['!in', 'kind', ['literal', 'park'], 'forest'], w))
      .toBe('.kind != "park" && .kind != "forest"')
  })

  it('[">=", "level", ["literal", 3]] → .level >= 3 (numeric wrap)', () => {
    const w: string[] = []
    expect(filterToXgis(['>=', 'level', ['literal', 3]], w))
      .toBe('.level >= 3')
  })

  it('legacy ["!in", "kind"] (empty) lowers to constant true', () => {
    // Mirror of ["in", x] → false. Empty !in always matches.
    const w: string[] = []
    expect(filterToXgis(['!in', 'kind'], w)).toBe('true')
  })

  it('bare legacy form still works (regression guard)', () => {
    const w: string[] = []
    expect(filterToXgis(['==', 'kind', 'park'], w)).toBe('.kind == "park"')
    expect(filterToXgis(['!in', 'kind', 'park', 'forest'], w))
      .toBe('.kind != "park" && .kind != "forest"')
  })
})
