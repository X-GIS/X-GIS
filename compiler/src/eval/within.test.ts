// Tests for the `within` geometry-containment predicate (CPU, GPU-free).
// Mapbox `["within", <Polygon|MultiPolygon>]` filter — true when the
// feature's geometry is fully contained in the argument polygon(s).
// First slice: Point / MultiPoint tested-geometry, with holes and
// MultiPolygon argument. LineString / Polygon tested-geometry return
// false (deferred — see within.ts).

import { describe, it, expect } from 'vitest'
import { evalWithin } from './within'

// A unit square [0,0]–[10,10] as a single Polygon (one outer ring).
const square = [[[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]]

// Square with a hole [3,3]–[7,7].
const squareWithHole = [[
  [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
  [[3, 3], [7, 3], [7, 7], [3, 7], [3, 3]],
]]

// Two disjoint squares: [0,0]–[10,10] and [20,0]–[30,10].
const twoSquares = [
  [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
  [[[20, 0], [30, 0], [30, 10], [20, 10], [20, 0]]],
]

const pt = (x: number, y: number) => ({ type: 'Point', coordinates: [x, y] })

describe('evalWithin — Point in Polygon', () => {
  it('point strictly inside → true', () => {
    expect(evalWithin(pt(5, 5), square)).toBe(true)
  })
  it('point strictly outside → false', () => {
    expect(evalWithin(pt(15, 5), square)).toBe(false)
  })
  it('point inside a hole → false', () => {
    expect(evalWithin(pt(5, 5), squareWithHole)).toBe(false)
  })
  it('point inside ring but outside the hole → true', () => {
    expect(evalWithin(pt(1, 1), squareWithHole)).toBe(true)
  })
})

describe('evalWithin — MultiPolygon argument', () => {
  it('point inside the second polygon → true', () => {
    expect(evalWithin(pt(25, 5), twoSquares)).toBe(true)
  })
  it('point in the gap between the two polygons → false', () => {
    expect(evalWithin(pt(15, 5), twoSquares)).toBe(false)
  })
})

describe('evalWithin — MultiPoint tested geometry', () => {
  it('all points inside → true', () => {
    expect(evalWithin({ type: 'MultiPoint', coordinates: [[2, 2], [8, 8]] }, square)).toBe(true)
  })
  it('one point outside → false (within requires FULL containment)', () => {
    expect(evalWithin({ type: 'MultiPoint', coordinates: [[2, 2], [15, 8]] }, square)).toBe(false)
  })
  it('empty MultiPoint → false (nothing to contain)', () => {
    expect(evalWithin({ type: 'MultiPoint', coordinates: [] }, square)).toBe(false)
  })
})

describe('evalWithin — deferred / degraded inputs', () => {
  it('LineString tested geometry → false (deferred slice)', () => {
    expect(evalWithin({ type: 'LineString', coordinates: [[1, 1], [2, 2]] }, square)).toBe(false)
  })
  it('null geometry (e.g. MVT path, no $geometry injected) → false', () => {
    expect(evalWithin(null, square)).toBe(false)
  })
  it('malformed polygons argument → false', () => {
    expect(evalWithin(pt(5, 5), null)).toBe(false)
    expect(evalWithin(pt(5, 5), [])).toBe(false)
  })
})
