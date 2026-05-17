// Pin Mapbox spec: empty concat returns "" (empty string), not null.
// Pre-fix the zero-arg / all-null case returned null which silently
// dropped the property — e.g. text-field collapsed to no label.

import { describe, it, expect } from 'vitest'
import { exprToXgis } from '../convert/expressions'

describe('concat empty / all-null', () => {
  it('zero-arg ["concat"] emits empty string', () => {
    const w: string[] = []
    const out = exprToXgis(['concat'], w)
    expect(out).toBe('""')
  })

  it('all-null args pass through with runtime null-skip semantics', () => {
    // exprToXgis emits null as the 'null' identifier; the runtime
    // concat() drops nulls per Mapbox spec, so the call still
    // evaluates to "". Converter-side, the args stay in the AST.
    const w: string[] = []
    const out = exprToXgis(['concat', null, null], w)
    expect(out).toBe('concat(null, null)')
  })

  it('non-empty concat unchanged (regression guard)', () => {
    const w: string[] = []
    const out = exprToXgis(['concat', 'a', 'b'], w)
    expect(out).toBe('concat("a", "b")')
  })

  it('partial-null concat keeps non-null parts (regression guard)', () => {
    const w: string[] = []
    const out = exprToXgis(['concat', 'a', null, 'b'], w)
    // null is preserved through exprToXgis as the 'null' identifier
    // and stays in the concat call — runtime concat() drops nulls.
    expect(out).toBe('concat("a", null, "b")')
  })
})
