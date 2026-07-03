// Mapbox spec strict: step stop x-values MUST be literal finite
// numbers — the stops form a monotonic axis the runtime buckets
// against. Expression-form x-values produced non-monotonic axes
// pre-fix that the evaluator silently degraded to default-arm.

import { describe, expect, it } from 'vitest'
import { exprToXgis } from '../convert/expressions'

describe('step spec-strict stop x-value validation', () => {
  it('accepts literal finite number stops', () => {
    const warnings: string[] = []
    const result = exprToXgis(['step', ['zoom'], 'small', 5, 'medium', 15, 'large'], warnings)
    expect(result).not.toBeNull()
    expect(warnings.some((w) => w.includes('literal finite number'))).toBe(false)
  })

  it('accepts ["literal", N] wrap on stop x', () => {
    const warnings: string[] = []
    const result = exprToXgis(
      ['step', ['zoom'], 'small', ['literal', 5], 'medium', ['literal', 15], 'large'],
      warnings,
    )
    expect(result).not.toBeNull()
    expect(warnings.some((w) => w.includes('literal finite number'))).toBe(false)
  })

  it('rejects ["get", "k"] expression-form stop x → warns + bails', () => {
    const warnings: string[] = []
    const result = exprToXgis(['step', ['zoom'], 'small', ['get', 'threshold'], 'medium'], warnings)
    expect(result).toBeNull()
    const w = warnings.find(
      (w) => w.includes('["step"] stop') && w.includes('literal finite number'),
    )
    expect(w).toBeDefined()
  })

  it('rejects NaN stop x', () => {
    const warnings: string[] = []
    const result = exprToXgis(['step', ['zoom'], 'a', NaN, 'b'], warnings)
    expect(result).toBeNull()
    expect(warnings.some((w) => w.includes('literal finite number'))).toBe(true)
  })

  it('rejects Infinity stop x', () => {
    const warnings: string[] = []
    const result = exprToXgis(['step', ['zoom'], 'a', Infinity, 'b'], warnings)
    expect(result).toBeNull()
    expect(warnings.some((w) => w.includes('literal finite number'))).toBe(true)
  })

  it('reports WHICH stop failed (precision over silent bail)', () => {
    const warnings: string[] = []
    exprToXgis(['step', ['zoom'], 'a', 5, 'b', ['get', 'x'], 'c', 15, 'd'], warnings)
    const w = warnings.find((w) => w.includes('["step"] stop'))
    expect(w).toBeDefined()
    expect(w).toContain('stop 2') // The second stop (index 1, but the message says "stop 2")
  })

  it('input + value positions still accept expressions (not subject to literal constraint)', () => {
    const warnings: string[] = []
    const result = exprToXgis(
      ['step', ['get', 'magnitude'], ['concat', 'a', 'b'], 5, ['concat', 'c', 'd']],
      warnings,
    )
    expect(result).not.toBeNull()
    expect(warnings.some((w) => w.includes('literal finite number'))).toBe(false)
  })
})
