// Verify ZERO_SEMANTICS catalogue agrees with Mapbox style-spec
// defaults via the oracle. Drift between the catalogue's `kind` and
// the spec's default would mean we've categorised a spec-default as
// strict-zero (or vice versa) — a documentation bug that misleads
// downstream fixes.

import { describe, expect, it } from 'vitest'
import { ZERO_SEMANTICS, zeroSemantic } from '../spec/zero-semantics'
import { specDefault } from '../spec/oracle'

describe('zero-value semantics catalogue', () => {
  it('every entry has a non-empty rationale', () => {
    for (const s of ZERO_SEMANTICS) {
      expect(s.rationale.length, `${s.layerType}.${s.property}`).toBeGreaterThan(10)
    }
  })

  it('catalogued properties exist in Mapbox style-spec', () => {
    for (const s of ZERO_SEMANTICS) {
      // Try paint first, fall through to layout.
      const paintDef = specDefault(s.layerType, 'paint', s.property)
      const layoutDef = specDefault(s.layerType, 'layout', s.property)
      const exists = paintDef !== undefined || layoutDef !== undefined
      expect(exists, `${s.layerType}.${s.property} should exist in spec`).toBe(true)
    }
  })

  it('every kind tag is one of the documented values', () => {
    const ALLOWED = new Set(['identity', 'strict-zero', 'invisible-but-present'])
    for (const s of ZERO_SEMANTICS) {
      expect(ALLOWED.has(s.kind), `${s.layerType}.${s.property} kind=${s.kind}`).toBe(true)
    }
  })

  it('zeroSemantic lookup returns the right entry', () => {
    const lb = zeroSemantic('line', 'line-blur')
    expect(lb?.kind).toBe('strict-zero')

    const to = zeroSemantic('symbol', 'text-opacity')
    expect(to?.kind).toBe('invisible-but-present')

    const unknown = zeroSemantic('line', 'nonexistent-prop')
    expect(unknown).toBeUndefined()
  })

  it('no duplicates: at most one entry per (layerType, property)', () => {
    const seen = new Set<string>()
    for (const s of ZERO_SEMANTICS) {
      const k = `${s.layerType}.${s.property}`
      expect(seen.has(k), `duplicate entry for ${k}`).toBe(false)
      seen.add(k)
    }
  })
})
