// Pin Mapbox v8 strict `["literal", [k1, k2]]` keys-array unwrap in
// all three match handlers (exprToXgis main case, matchToTernary,
// matchToBooleanFilter). Pre-fix the wrapped form passed the
// `Array.isArray(key)` check and iterated through the OUTER array —
// producing arms "literal" -> val and [k1,k2] -> val instead of the
// intended k1 -> val, k2 -> val. The match silently emitted wrong
// arms; filters compared against the literal string "literal".

import { describe, it, expect } from 'vitest'
import { exprToXgis, filterToXgis } from '../convert/expressions'

describe('match keys-array literal-wrap unwrap', () => {
  it('main match handler unwraps ["literal", [k1, k2]] keys', () => {
    const w: string[] = []
    const out = exprToXgis(
      ['match', ['get', 'class'],
        ['literal', ['primary', 'trunk']], '#f00',
        'tertiary', '#0f0',
        '#000',
      ],
      w,
    )
    expect(out).toContain('"primary" -> "#f00"')
    expect(out).toContain('"trunk" -> "#f00"')
    expect(out).toContain('"tertiary" -> "#0f0"')
    expect(out).not.toContain('"literal"')
  })

  it('match handler still accepts bare-array keys (regression guard)', () => {
    const w: string[] = []
    const out = exprToXgis(
      ['match', ['get', 'class'],
        ['primary', 'trunk'], '#f00',
        '#000',
      ],
      w,
    )
    expect(out).toContain('"primary" -> "#f00"')
    expect(out).toContain('"trunk" -> "#f00"')
  })

  it('matchToBooleanFilter unwraps wrapped boolean values + default', () => {
    // Strict v8 tooling can wrap the boolean values themselves:
    // ["match", input, k, ["literal", true], ["literal", false]].
    // Pre-fix the typeof === 'boolean' gate failed on the wrap and
    // matchToBooleanFilter returned null — the filter fell to the
    // generic match() path and lost its boolean-fast-path role.
    const w: string[] = []
    const out = filterToXgis(
      ['match', ['get', 'class'],
        ['literal', ['park', 'forest']], ['literal', true],
        ['literal', false],
      ],
      w,
    )
    expect(out).toContain('.class == "park"')
    expect(out).toContain('.class == "forest"')
  })

  it('matchToBooleanFilter unwraps wrapped keys', () => {
    // Boolean-shape match used inside filter context. Default false,
    // wrapped key array.
    const w: string[] = []
    const out = filterToXgis(
      ['match', ['get', 'kind'],
        ['literal', ['park', 'forest', 'wood']], true,
        false,
      ],
      w,
    )
    expect(out).toContain('.kind == "park"')
    expect(out).toContain('.kind == "forest"')
    expect(out).toContain('.kind == "wood"')
    expect(out).not.toContain('"literal"')
  })

  it('matchToTernary unwraps wrapped keys (complex input fallback)', () => {
    // Match on a non-field-access input forces matchToTernary path.
    const w: string[] = []
    const out = exprToXgis(
      ['match', ['concat', ['get', 'a'], ['get', 'b']],
        ['literal', ['x', 'y']], 1,
        0,
      ],
      w,
    )
    expect(out).toContain('== "x"')
    expect(out).toContain('== "y"')
    expect(out).not.toContain('"literal"')
  })
})
