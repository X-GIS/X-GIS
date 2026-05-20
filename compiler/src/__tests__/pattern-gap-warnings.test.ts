// Regression gate: every bitmap-pattern paint property STILL waiting
// on the Stage 2 UV-tiled fragment shader emits a specific gap
// warning naming its sprite-atlas dependency, with TWO distinct
// messages depending on whether a colour fallback is also authored:
//   * pattern alone → empty layer / uncoloured walls
//   * pattern + colour → pattern dropped, colour fallback renders
//
// iter-177 promoted `fill-pattern` to Stage 1 (compiler emits a
// `fill-pattern-<name>` utility + runtime samples the sprite centre
// pixel as a flat fill colour). It no longer warns, so it dropped
// from this matrix and has its own coverage test below. The
// remaining patterns (`line-pattern`, `fill-extrusion-pattern`) keep
// the legacy warn-only contract until their Stage-N implementations.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

interface Case {
  property: string
  layerType: string
  colourProp: string
  alone: { message: string }
  withColour: { message: string }
}

// iter-178 promoted `line-pattern` to Stage 1 alongside fill-pattern,
// so it joined fill-pattern in dropping from the warn-only matrix.
// fill-extrusion-pattern keeps the legacy contract.
const CASES: Case[] = [
  { property: 'fill-extrusion-pattern', layerType: 'fill-extrusion', colourProp: 'fill-extrusion-color',
    alone:      { message: 'declared without fill-extrusion-color' },
    withColour: { message: 'set alongside fill-extrusion-color' } },
]

// iter-177/178 — `fill-pattern` + `line-pattern` Stage 1 emit a
// `fill-pattern-<name>` / `stroke-pattern-<name>` utility silently
// (no warning) regardless of whether a colour fallback is also
// authored. These pinned tests catch a regression to the legacy
// warn-only contract.
describe('fill-pattern Stage 1 — no Batch-2 warning', () => {
  const baseStyle = (extra: Record<string, unknown>) => ({
    version: 8,
    sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
    layers: [{
      id: 'l', type: 'fill', source: 'v', 'source-layer': 'a',
      paint: { 'fill-pattern': 'my-pat', ...extra },
    }],
  })
  for (const [variant, extra] of [
    ['alone', {}],
    ['+ fill-color', { 'fill-color': '#fff' }],
  ] as const) {
    it(`fill-pattern ${variant} emits no Batch-2 warning`, () => {
      const coverage = { sources: [], layers: [], warnings: [] as string[] }
      convertMapboxStyle(baseStyle(extra) as never, { coverage })
      const stale = coverage.warnings.find(w =>
        w.includes('declared without fill-color')
        || w.includes('set alongside fill-color')
        || w.includes('Batch 2 sprite-atlas')
        || (w.includes('fill-pattern') && w.includes('not yet supported')))
      expect(stale, `unexpected legacy warning for fill-pattern ${variant}: ${stale}`).toBeUndefined()
    })
  }
})

describe('line-pattern Stage 1 — no Batch-2 warning', () => {
  const baseStyle = (extra: Record<string, unknown>) => ({
    version: 8,
    sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
    layers: [{
      id: 'l', type: 'line', source: 'v', 'source-layer': 'a',
      paint: { 'line-pattern': 'my-pat', 'line-width': 1, ...extra },
    }],
  })
  for (const [variant, extra] of [
    ['alone', {}],
    ['+ line-color', { 'line-color': '#fff' }],
  ] as const) {
    it(`line-pattern ${variant} emits no Batch-2 warning`, () => {
      const coverage = { sources: [], layers: [], warnings: [] as string[] }
      convertMapboxStyle(baseStyle(extra) as never, { coverage })
      const stale = coverage.warnings.find(w =>
        w.includes('declared without line-color')
        || w.includes('set alongside line-color')
        || w.includes('Batch 2 sprite-atlas')
        || (w.includes('line-pattern') && w.includes('not yet supported')))
      expect(stale, `unexpected legacy warning for line-pattern ${variant}: ${stale}`).toBeUndefined()
    })
  }
})

function buildStyle(c: Case, includeColour: boolean): Record<string, unknown> {
  const paint: Record<string, unknown> = { [c.property]: 'my-pattern' }
  if (includeColour) paint[c.colourProp] = '#fff'
  if (c.layerType === 'fill-extrusion') paint['fill-extrusion-height'] = 10
  if (c.layerType === 'line') paint['line-width'] = 1
  return {
    version: 8,
    sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
    layers: [{
      id: 'l', type: c.layerType, source: 'v', 'source-layer': 'a', paint,
    }],
  }
}

describe('pattern-property gap warning specificity', () => {
  for (const c of CASES) {
    it(`${c.property} alone → "${c.alone.message}" warning`, () => {
      const coverage = { sources: [], layers: [], warnings: [] as string[] }
      convertMapboxStyle(buildStyle(c, false) as never, { coverage })
      const w = coverage.warnings.find(w => w.includes(c.alone.message))
      expect(w, `expected warning for ${c.property} alone`).toBeDefined()
      // Must NOT also surface via the generic ignored-properties blob.
      expect(coverage.warnings.some(
        w => w.includes('ignored paint properties') && w.includes(c.property),
      )).toBe(false)
    })

    it(`${c.property} + ${c.colourProp} → "${c.withColour.message}" warning`, () => {
      const coverage = { sources: [], layers: [], warnings: [] as string[] }
      convertMapboxStyle(buildStyle(c, true) as never, { coverage })
      const w = coverage.warnings.find(w => w.includes(c.withColour.message))
      expect(w, `expected warning for ${c.property} + colour`).toBeDefined()
      expect(coverage.warnings.some(
        w => w.includes('ignored paint properties') && w.includes(c.property),
      )).toBe(false)
    })
  }
})
