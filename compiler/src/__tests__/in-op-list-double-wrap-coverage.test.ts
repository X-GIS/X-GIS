// Pin `in` operator expression-form list multi-level wrap unwrap.
// Pre-fix the outer literal-check single-passed; preprocessor-emitted
// ['in', value, ['literal', ['literal', [...]]]] left an inner
// literal wrapper after the check, the .map iterated the wrapper
// itself ('literal' and the inner array as values), and emitted
// always-false equality clauses.

import { describe, it, expect } from 'vitest'
import { exprToXgis } from '../convert/expressions'

describe('in op list double-wrap', () => {
  it('double-wrapped list still emits proper equality OR chain', () => {
    const w: string[] = []
    const out = exprToXgis(
      ['in', ['get', 'class'], ['literal', ['literal', ['primary', 'trunk']]]],
      w,
    )
    expect(out).toContain('.class == "primary"')
    expect(out).toContain('.class == "trunk"')
    expect(out).not.toContain('"literal"')
  })

  it('single-wrapped list still works (regression guard)', () => {
    const w: string[] = []
    const out = exprToXgis(
      ['in', ['get', 'class'], ['literal', ['primary', 'trunk']]],
      w,
    )
    expect(out).toContain('.class == "primary"')
    expect(out).toContain('.class == "trunk"')
  })
})
