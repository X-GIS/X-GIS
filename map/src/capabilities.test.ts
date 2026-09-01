// Runtime capability table integrity: every entry has a clear
// supported flag, gaps have explanatory notes, and lookups round-trip.

import { describe, expect, it } from 'vitest'
import { RUNTIME_CAPABILITIES, runtimeCapability, runtimeGaps } from './capabilities'

describe('runtime capability table', () => {
  it('every unsupported entry has a note explaining why', () => {
    for (const c of RUNTIME_CAPABILITIES) {
      if (!c.supported) {
        expect(c.note?.length ?? 0, `${c.layerType}.${c.property}:${c.variant}`).toBeGreaterThan(10)
      }
    }
  })

  it('no duplicate (layerType, property, variant) tuples', () => {
    const seen = new Set<string>()
    for (const c of RUNTIME_CAPABILITIES) {
      const k = `${c.layerType}|${c.property}|${c.variant}`
      expect(seen.has(k), `duplicate: ${k}`).toBe(false)
      seen.add(k)
    }
  })

  it('runtimeCapability lookup round-trips a known supported tuple', () => {
    const c = runtimeCapability('fill', 'fill-color', 'constant')
    expect(c?.supported).toBe(true)
  })

  it('runtimeCapability lookup round-trips a known gap tuple', () => {
    // Re-pointed in #2166: text-pitch-alignment used to be the sample gap here.
    // It is still one — the ground basis is wired DIAGONALLY across the two label
    // dispatch paths, so point-on-tiled and line-on-raw both billboard — but it is
    // no longer a good SAMPLE, because whether it is a gap is exactly the question
    // that row keeps being re-litigated over. text-opacity/data-driven is a stable
    // one. The assertion is about the LOOKUP, not about which property happens to
    // be unsupported today.
    const c = runtimeCapability('symbol', 'text-opacity', 'data-driven')
    expect(c?.supported).toBe(false)
    expect(c?.note).toContain('Per-feature')
  })

  it('runtimeGaps surfaces all unsupported entries', () => {
    const gaps = runtimeGaps()
    expect(gaps.length).toBeGreaterThan(0)
    for (const g of gaps) {
      expect(g.supported).toBe(false)
    }
  })
})
