// Pin pseudo-field ($type / $id) drop with wrapped field name.
// Pre-fix the wrapped form ['==', ['literal', '$type'], 'Polygon']
// failed the bare-string check, fell to the legacy comparison path,
// and emitted a meaningless `."$type" == "Polygon"' (where $type
// isn't a real property → predicate always false → drop everything).

import { describe, it, expect } from 'vitest'
import { filterToXgis } from '../convert/expressions'

describe('$type/$id wrapped pseudo-field', () => {
  it('wrapped $type drops with warning', () => {
    const w: string[] = []
    expect(filterToXgis(['==', ['literal', '$type'], 'Polygon'], w)).toBeNull()
    expect(w.join('\n')).toMatch(/Filter on "\$type" dropped/)
  })

  it('wrapped $id drops with warning', () => {
    const w: string[] = []
    expect(filterToXgis(['!=', ['literal', '$id'], 42], w)).toBeNull()
    expect(w.join('\n')).toMatch(/Filter on "\$id" dropped/)
  })

  it('regression: bare $type still drops', () => {
    const w: string[] = []
    expect(filterToXgis(['==', '$type', 'Polygon'], w)).toBeNull()
  })

  it('regression: real-field comparison still emits predicate', () => {
    const w: string[] = []
    expect(filterToXgis(['==', 'class', 'park'], w)).toBe('.class == "park"')
  })
})
