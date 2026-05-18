// Pin iter 545 audit — malformed Mapbox expression shapes must:
// 1. Return null (never crash)
// 2. Surface a diagnostic warning (no silent drop)
// 3. Not corrupt downstream conversion (caller can detect failure)
//
// Sibling to unsupported-op-warnings.test.ts (iter 544) which covers
// known-but-unimplemented ops. This file covers SHAPE errors —
// inputs that aren't valid Mapbox expressions at all.

import { describe, it, expect } from 'vitest'
import { exprToXgis } from '../convert/expressions'

function convert(mapbox: unknown): { result: string | null; warnings: string[] } {
  const warnings: string[] = []
  const result = exprToXgis(mapbox as never, warnings)
  return { result, warnings }
}

describe('malformed expression shapes (iter 545)', () => {
  it('null operator → null + warning', () => {
    const { result, warnings } = convert([null, 1])
    expect(result).toBeNull()
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings[0]).toContain('Expression not converted')
  })

  it('numeric operator → null + warning', () => {
    const { result, warnings } = convert([5, 1])
    expect(result).toBeNull()
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('array-as-operator → null + warning (no recursive crash)', () => {
    const { result, warnings } = convert([['nested'], 1])
    expect(result).toBeNull()
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('empty array → null + warning', () => {
    const { result, warnings } = convert([])
    expect(result).toBeNull()
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('single-element array (op only, no args) → null + warning', () => {
    // `["literal"]` or `["abc"]` etc. — not a valid Mapbox expression.
    // The element is treated as an unknown op and falls through to
    // the generic catch-all.
    const { result, warnings } = convert(['abc'])
    expect(result).toBeNull()
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('deeply-nested malformed → null without crash', () => {
    // Defence-in-depth — a deeply nested malformed input must not
    // blow the stack or throw.
    let nested: unknown = ['unknown-op', 5]
    for (let i = 0; i < 50; i++) nested = ['unknown-op', nested]
    const { result } = convert(nested)
    expect(result).toBeNull()
  })

  it('warning text always cites the offending shape (slice-safe)', () => {
    // The warning string includes the JSON-stringified input
    // truncated to ~120 chars. With huge inputs the warning still
    // emits cleanly without overrunning anything.
    const huge: unknown[] = Array.from({ length: 500 }, (_, i) => i)
    huge[0] = 'unknown-op-with-many-args'
    const { warnings } = convert(huge)
    expect(warnings.length).toBeGreaterThan(0)
    // Warning text bounded — don't dump 500 args.
    expect(warnings[0]!.length).toBeLessThan(300)
  })
})
