// Pin v8 strict per-key `["literal", v]` unwrap in `["in"]`. Mapbox
// strict tooling can wrap each value inside the keys list — pre-fix
// the equality emit JSON.stringify'd the wrapper array as a key
// (`"[\"literal\",\"a\"]"`) and no feature ever matched the filter.

import { describe, it, expect } from 'vitest'
import { filterToXgis } from '../convert/expressions'

describe('["in"] per-key literal-wrap unwrap', () => {
  it('bare expression-form ["in", value, ["literal", [...]]] regression guard', () => {
    const w: string[] = []
    expect(
      filterToXgis(['in', ['get', 'kind'], ['literal', ['park', 'forest']]], w),
    ).toBe('.kind == "park" || .kind == "forest"')
  })

  it('per-key wrap: ["literal", [["literal","park"], "forest"]] unwraps each', () => {
    const w: string[] = []
    const out = filterToXgis(
      ['in', ['get', 'kind'], ['literal', [['literal', 'park'], 'forest']]],
      w,
    )
    expect(out).toBe('.kind == "park" || .kind == "forest"')
  })

  it('legacy form per-key wrap: ["in", "kind", ["literal","park"], "forest"]', () => {
    const w: string[] = []
    const out = filterToXgis(
      ['in', 'kind', ['literal', 'park'], 'forest'],
      w,
    )
    expect(out).toBe('.kind == "park" || .kind == "forest"')
  })

  it('empty values list lowers to constant `false`', () => {
    // Mapbox spec: in over an empty set → never matches → false.
    // Pre-fix the empty join returned an empty string and the
    // surrounding filter parser failed.
    const w: string[] = []
    expect(filterToXgis(['in', ['get', 'kind'], ['literal', []]], w)).toBe('false')
  })

  it('legacy form ["in", "kind"] (no values) also lowers to false', () => {
    const w: string[] = []
    expect(filterToXgis(['in', 'kind'], w)).toBe('false')
  })

  it('numeric keys still emit unquoted', () => {
    const w: string[] = []
    expect(
      filterToXgis(['in', ['get', 'level'], ['literal', [1, 2, 3]]], w),
    ).toBe('.level == 1 || .level == 2 || .level == 3')
  })
})
