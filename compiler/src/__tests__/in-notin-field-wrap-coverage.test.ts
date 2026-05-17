// Pin wrapped field-name peel on legacy `in` + `!in` filter forms.
// Pre-fix the wrapped form ['!in', ['literal', 'kind'], 'park'] failed
// the typeof === 'string' check and fell to a literal-vs-literal
// comparison via exprToXgis → predicate became always false → all
// features dropped.

import { describe, it, expect } from 'vitest'
import { filterToXgis, exprToXgis } from '../convert/expressions'

describe('legacy in/!in wrapped field name', () => {
  it('!in with wrapped field still emits .field != list', () => {
    const w: string[] = []
    const out = filterToXgis(['!in', ['literal', 'kind'], 'park', 'forest'], w)
    expect(out).toBe('.kind != "park" && .kind != "forest"')
  })

  it('in (legacy form) with wrapped field still emits .field == list', () => {
    const w: string[] = []
    const out = exprToXgis(['in', ['literal', 'kind'], 'park', 'forest'], w)
    expect(out).toBe('.kind == "park" || .kind == "forest"')
  })

  it('regression: bare field still works on !in', () => {
    const w: string[] = []
    expect(filterToXgis(['!in', 'kind', 'park'], w)).toBe('.kind != "park"')
  })
})
