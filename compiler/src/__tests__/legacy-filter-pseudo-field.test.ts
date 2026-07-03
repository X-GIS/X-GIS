// Regression: legacy $type / $id filter forms were dropped with a warning.
// They now route to the existing geometry-type / id accessors.
// Fail-before: filterToXgis returned null (predicate silently dropped).
// Pass-after:  emits the accessor-based predicate string.

import { describe, it, expect } from 'vitest'
import { filterToXgis } from '../convert/expressions'

describe('legacy $type filter', () => {
  it('["==", "$type", "Point"] converts to geometry-type equality', () => {
    const w: string[] = []
    const result = filterToXgis(['==', '$type', 'Point'], w)
    expect(result).toBe('get("$geometryType") == "Point"')
    expect(w).toHaveLength(0)
  })

  it('["!=", "$type", "Polygon"] converts to geometry-type inequality', () => {
    const w: string[] = []
    const result = filterToXgis(['!=', '$type', 'Polygon'], w)
    expect(result).toBe('get("$geometryType") != "Polygon"')
    expect(w).toHaveLength(0)
  })

  it('["in", "$type", "Point", "LineString"] expands to OR chain', () => {
    const w: string[] = []
    const result = filterToXgis(['in', '$type', 'Point', 'LineString'], w)
    expect(result).toBe('get("$geometryType") == "Point" || get("$geometryType") == "LineString"')
    expect(w).toHaveLength(0)
  })

  it('["!in", "$type", "Polygon"] expands to AND chain (negation)', () => {
    const w: string[] = []
    const result = filterToXgis(['!in', '$type', 'Polygon'], w)
    expect(result).toBe('get("$geometryType") != "Polygon"')
    expect(w).toHaveLength(0)
  })

  it('["in", "$type"] with no values → false (empty set)', () => {
    const w: string[] = []
    const result = filterToXgis(['in', '$type'], w)
    expect(result).toBe('false')
  })

  it('["!in", "$type"] with no values → true (never in empty set)', () => {
    const w: string[] = []
    const result = filterToXgis(['!in', '$type'], w)
    expect(result).toBe('true')
  })

  it('["==", ["literal", "$type"], "Point"] wrapped form also converts', () => {
    const w: string[] = []
    const result = filterToXgis(['==', ['literal', '$type'], 'Point'], w)
    expect(result).toBe('get("$geometryType") == "Point"')
    expect(w).toHaveLength(0)
  })
})

describe('legacy $id filter', () => {
  it('["==", "$id", 42] converts to id equality', () => {
    const w: string[] = []
    const result = filterToXgis(['==', '$id', 42], w)
    expect(result).toBe('get("$featureId") == 42')
    expect(w).toHaveLength(0)
  })

  it('["!=", "$id", 0] converts to id inequality', () => {
    const w: string[] = []
    const result = filterToXgis(['!=', '$id', 0], w)
    expect(result).toBe('get("$featureId") != 0')
    expect(w).toHaveLength(0)
  })

  it('["in", "$id", 1, 2, 3] expands to OR chain', () => {
    const w: string[] = []
    const result = filterToXgis(['in', '$id', 1, 2, 3], w)
    expect(result).toBe(
      'get("$featureId") == 1 || get("$featureId") == 2 || get("$featureId") == 3',
    )
    expect(w).toHaveLength(0)
  })
})
