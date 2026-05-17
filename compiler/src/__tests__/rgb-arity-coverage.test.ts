// Pin arity check on rgb/rgba expressions. Pre-fix a malformed
// ['rgba', r, g, b] (missing alpha) left `a` as undefined,
// Math.round(undefined * 255) gave NaN, and the emitted hex carried
// the literal string 'NaN' (e.g. '#ff0000NaN') which the runtime
// hex parser silently failed on (length unmatched).

import { describe, it, expect } from 'vitest'
import { exprToXgis } from '../convert/expressions'

describe('rgb/rgba arity check', () => {
  it('rgba with only 3 channels returns null', () => {
    const w: string[] = []
    const out = exprToXgis(['rgba', 255, 0, 0], w)
    expect(out).toBeNull()
    expect(w.join('\n')).toMatch(/expected 4 channels/)
  })

  it('rgb with 4 channels returns null', () => {
    const w: string[] = []
    const out = exprToXgis(['rgb', 255, 0, 0, 0.5], w)
    expect(out).toBeNull()
    expect(w.join('\n')).toMatch(/expected 3 channels/)
  })

  it('regression: valid rgba(255, 0, 0, 0.5) hex-encodes', () => {
    const w: string[] = []
    const out = exprToXgis(['rgba', 255, 0, 0, 0.5], w)
    expect(out).toMatch(/^#ff0000[78]0$/i)
  })

  it('regression: valid rgb(255, 0, 0) hex-encodes', () => {
    const w: string[] = []
    const out = exprToXgis(['rgb', 255, 0, 0], w)
    expect(out).toBe('#ff0000')
  })
})
