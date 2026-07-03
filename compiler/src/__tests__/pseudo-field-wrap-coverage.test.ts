// Pin pseudo-field ($type / $id) routing with wrapped field name.
// Pre-fix the wrapped form ['==', ['literal', '$type'], 'Polygon']
// failed the bare-string check, fell to the legacy comparison path,
// and emitted a meaningless `."$type" == "Polygon"' (where $type
// isn't a real property → predicate always false → drop everything).
// Now $type routes to geometry-type accessor and $id routes to id
// accessor — both already supported in the expression-form converter.

import { describe, it, expect } from 'vitest'
import { filterToXgis } from '../convert/expressions'

describe('$type/$id wrapped pseudo-field', () => {
  it('wrapped $type routes to geometry-type accessor (no warning)', () => {
    const w: string[] = []
    expect(filterToXgis(['==', ['literal', '$type'], 'Polygon'], w)).toBe(
      'get("$geometryType") == "Polygon"',
    )
    expect(w).toHaveLength(0)
  })

  it('wrapped $id routes to id accessor (no warning)', () => {
    const w: string[] = []
    expect(filterToXgis(['!=', ['literal', '$id'], 42], w)).toBe('get("$featureId") != 42')
    expect(w).toHaveLength(0)
  })

  it('bare $type also routes to geometry-type accessor', () => {
    const w: string[] = []
    expect(filterToXgis(['==', '$type', 'Polygon'], w)).toBe('get("$geometryType") == "Polygon"')
    expect(w).toHaveLength(0)
  })

  it('regression: real-field comparison still emits predicate', () => {
    const w: string[] = []
    expect(filterToXgis(['==', 'class', 'park'], w)).toBe('.class == "park"')
  })
})
