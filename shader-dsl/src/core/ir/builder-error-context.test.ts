// ═══ builder — authoring-error context (#843) ═══
//
// When an author's callback throws (a JS ReferenceError, a typo'd field, …),
// the raw stack leads with builder internals and the failing fn / statement is
// invisible. The builder prefixes the error's message at two boundaries — the
// innermost statement body (Loop/If/Switch/elif/else) and the enclosing fn —
// while keeping the SAME error object, so instanceof, coded diagnostics, and
// substring-matching tests all still hold.

import { describe, it, expect } from 'vitest'
import { fn, If, Loop, f32, u32, f32T } from './index'

const boom = (): never => {
  throw new ReferenceError('i is not defined')
}

describe('builder — authoring-error context (#843)', () => {
  it('names the enclosing fn and the statement kind, innermost first', () => {
    expect(() =>
      fn('fs_ctx', { x: f32T }, ({ x }) => {
        Loop(
          u32(0),
          (i) => i.lt(u32(2)),
          () => {
            boom()
          },
        )
        return x
      }),
    ).toThrowError(/^while building fn 'fs_ctx': in Loop body: i is not defined$/)
  })

  it('nested scopes tag the INNERMOST kind only (no prefix per level)', () => {
    expect(() =>
      fn('fs_nested', { x: f32T }, ({ x }) => {
        Loop(
          u32(0),
          (i) => i.lt(u32(2)),
          () => {
            If(x.gt(0), () => {
              boom()
            })
          },
        )
        return x
      }),
    ).toThrowError(/^while building fn 'fs_nested': in If body: i is not defined$/)
  })

  it('a throw straight from the fn body gets the fn context alone', () => {
    expect(() =>
      fn('fs_direct', {}, () => {
        boom()
      }),
    ).toThrowError(/^while building fn 'fs_direct': i is not defined$/)
  })

  it('preserves the error class (the same object is rethrown, message-prefixed)', () => {
    let caught: unknown
    try {
      fn('fs_cls', {}, () => {
        boom()
        return f32(0)
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ReferenceError)
  })
})
