// Pin v8 strict `["to-color", ["literal", "#fff"]]` double-wrap
// unwrap. The bare-inner form `["to-color", "#fff"]` was already
// handled; strict tooling double-wraps the inner constant with
// ["literal", ...]` to keep the parser from re-interpreting the
// string as an expression. Pre-fix the double-wrap fell through
// the typeof string gate and emitted as a data-driven bracket-
// binding (no fast path) or null.

import { describe, it, expect } from 'vitest'
import { colorToXgis } from '../convert/colors'

describe('to-color literal-wrap unwrap', () => {
  it('bare ["to-color", "#fff"] returns the inner hex', () => {
    const w: string[] = []
    expect(colorToXgis(['to-color', '#fff'], w)).toBe('#fff')
  })

  it('v8 strict ["to-color", ["literal", "#fff"]] also returns the inner hex', () => {
    const w: string[] = []
    expect(colorToXgis(['to-color', ['literal', '#fff']], w)).toBe('#fff')
    expect(w).toEqual([])
  })

  it('["to-color", ["literal", "red"]] resolves named colour via the palette', () => {
    // Inner is a named CSS colour after unwrap. resolveColor picks it
    // up the same way as the bare-string path.
    const w: string[] = []
    const out = colorToXgis(['to-color', ['literal', 'red']], w)
    expect(out).toBe('#ff0000')
  })

  it('["to-color", ["get", "field"]] still falls to data-driven (no false unwrap)', () => {
    // Expression-form inner shouldn't be eagerly unwrapped — the
    // expression-driven path stays correct.
    const w: string[] = []
    expect(colorToXgis(['to-color', ['get', 'colour']], w)).toBeNull()
  })
})
