// Pin legacy `["==", field, value]` filter form with wrapped field
// name. Pre-fix `typeof v[1] === 'string'` failed on a wrapped form
// like ['==', ['literal', 'kind'], 'park'] → routed through exprToXgis
// case 'literal' → emitted '"kind" == "park"' (literal-vs-literal,
// always false). Peel the field wrap so the legacy fast path fires.

import { describe, it, expect } from 'vitest'
import { filterToXgis } from '../convert/expressions'

describe('legacy comparison wrapped field name', () => {
  it('["==", ["literal", "kind"], "park"] emits .kind == "park"', () => {
    const w: string[] = []
    expect(filterToXgis(['==', ['literal', 'kind'], 'park'], w)).toBe('.kind == "park"')
  })

  it('double-wrap also peels', () => {
    const w: string[] = []
    expect(filterToXgis(['!=', ['literal', ['literal', 'kind']], 'park'], w)).toBe('.kind != "park"')
  })

  it('regression: bare field still works', () => {
    const w: string[] = []
    expect(filterToXgis(['==', 'kind', 'park'], w)).toBe('.kind == "park"')
  })
})
