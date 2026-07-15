// Integration: `within(...)` lowered source → parser → evaluator builtin.
// Confirms the converter's emission shape
//   within(get("$geometry"), <coords>)
// evaluates correctly against the `$geometry` reserved-key props bag.

import { describe, it, expect } from 'vitest'
import { evaluate } from './evaluator'
import { GEOMETRY_KEY } from './reserved-keys'
import { parseExpressionString } from '../parser/parser'

function evalExpr(src: string, props: Record<string, unknown>): unknown {
  return evaluate(parseExpressionString(src) as never, props)
}

// The converter emits the polygon as a MultiPolygon-shaped nested array
// literal. A 10×10 square at the origin:
const SQUARE = '[[[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]]'
const SRC = `within(get("$geometry"), ${SQUARE})`

describe('within() builtin via parser + evaluator', () => {
  it('point inside → true', () => {
    expect(evalExpr(SRC, { [GEOMETRY_KEY]: { type: 'Point', coordinates: [5, 5] } })).toBe(true)
  })
  it('point outside → false', () => {
    expect(evalExpr(SRC, { [GEOMETRY_KEY]: { type: 'Point', coordinates: [50, 50] } })).toBe(false)
  })
  it('missing $geometry (e.g. MVT path) → false, no throw', () => {
    expect(evalExpr(SRC, {})).toBe(false)
  })
})
