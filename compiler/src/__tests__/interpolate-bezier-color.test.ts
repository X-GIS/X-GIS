// `["interpolate", ["cubic-bezier", …], input, z0, color0, …]` with COLOUR
// stops. Numeric-valued bezier interpolates already densify (iter 62);
// colour stops previously folded to plain linear-sRGB with a warning.
// This pins the colour-stop densification: sRGB channel samples taken at
// the bezier-EASED fraction, emitted as a dense linear interpolate the
// runtime approximates. Pure compile-time, GPU-free.

import { describe, it, expect } from 'vitest'
import { exprToXgis } from '../convert/expressions'

function convert(mapbox: unknown): { result: string | null; warnings: string[] } {
  const warnings: string[] = []
  return { result: exprToXgis(mapbox as never, warnings), warnings }
}

// Parse `interpolate(.x, z0, "#hex0", z1, "#hex1", …)` into [z, hex] pairs.
function parseStops(src: string): Array<[number, string]> {
  const inner = src.replace(/^interpolate\([^,]+,\s*/, '').replace(/\)$/, '')
  const toks = inner.split(',').map(s => s.trim())
  const out: Array<[number, string]> = []
  for (let i = 0; i < toks.length; i += 2) {
    out.push([Number(toks[i]), toks[i + 1]!.replace(/"/g, '')])
  }
  return out
}

// ease-in curve: eased(0.5) < 0.5, so the midpoint colour sits closer to
// the START stop than a linear ramp would.
const EASE_IN = ['cubic-bezier', 0.42, 0, 1, 1]

describe('interpolate cubic-bezier with colour stops', () => {
  it('densifies colour stops instead of folding to linear', () => {
    const { result, warnings } = convert(
      ['interpolate', EASE_IN, ['get', 'x'], 0, '#000000', 10, '#ffffff'],
    )
    expect(result).not.toBeNull()
    expect(result!.startsWith('interpolate(.x,')).toBe(true)
    // A 2-stop input densifies to 6 samples per segment (+ endpoint).
    const stops = parseStops(result!)
    expect(stops.length).toBeGreaterThan(2)
    // Every stop value is a hex colour.
    for (const [, hex] of stops) expect(hex).toMatch(/^#[0-9a-f]{6}$/i)
    // No "folded to linear" downgrade; the dense-sample note instead.
    expect(warnings.some(w => /folded to linear/.test(w))).toBe(false)
    expect(warnings.some(w => /cubic-bezier/.test(w) && /sample/i.test(w))).toBe(true)
  })

  it('midpoint colour reflects bezier easing (ease-in → darker than linear #808080)', () => {
    const { result } = convert(
      ['interpolate', EASE_IN, ['get', 'x'], 0, '#000000', 10, '#ffffff'],
    )
    const stops = parseStops(result!)
    const mid = stops.find(([z]) => z === 5)
    expect(mid, 'expected a densified stop at z=5').toBeDefined()
    const channel = parseInt(mid![1].slice(1, 3), 16)
    // Linear would be ~0x80 (128); ease-in pulls it well below.
    expect(channel).toBeLessThan(120)
  })

  it('non-hex (expression) colour stops still fall back to linear with a warning', () => {
    const { result, warnings } = convert(
      ['interpolate', EASE_IN, ['get', 'x'], 0, ['get', 'c0'], 10, '#ffffff'],
    )
    expect(result!.startsWith('interpolate(.x,')).toBe(true)
    expect(warnings.some(w => /folded to linear/.test(w))).toBe(true)
  })
})
