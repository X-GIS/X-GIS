// symbol-avoid-edges keeps its specific gap warning (moot for X-GIS'
// cross-tile collision model). symbol-z-order was PROMOTED from a gap
// warning to a real end-to-end implementation (Phase S Batch 4) — its
// valid enum values now emit a `label-z-order-<v>` utility and no longer
// warn; only an invalid enum value warns. The threading is gated in
// symbol-z-order-threading.test.ts; here we just assert the WARNING
// surface (avoid-edges still warns; valid z-order no longer does).

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function warningsOf(style: unknown): string[] {
  const coverage = { sources: [], layers: [], warnings: [] as string[] }
  convertMapboxStyle(style as never, { coverage })
  return coverage.warnings
}

function buildSymbol(layout: Record<string, unknown>): unknown {
  return {
    version: 8,
    sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
    layers: [
      {
        id: 'lbl',
        type: 'symbol',
        source: 'v',
        'source-layer': 'a',
        layout: { 'text-field': '{name}', ...layout },
        paint: { 'text-color': '#000' },
      },
    ],
  }
}

describe('symbol-z-order + symbol-avoid-edges warning surface', () => {
  it('symbol-z-order: "viewport-y" (now implemented) does NOT warn', () => {
    const w = warningsOf(buildSymbol({ 'symbol-z-order': 'viewport-y' }))
    expect(w.some((s) => s.includes('symbol-z-order'))).toBe(false)
  })

  it('symbol-z-order: "source" (now implemented) does NOT warn', () => {
    const w = warningsOf(buildSymbol({ 'symbol-z-order': 'source' }))
    expect(w.some((s) => s.includes('symbol-z-order'))).toBe(false)
  })

  it('symbol-z-order: "auto" (default) does NOT warn', () => {
    const w = warningsOf(buildSymbol({ 'symbol-z-order': 'auto' }))
    expect(w.some((s) => s.includes('symbol-z-order'))).toBe(false)
  })

  it('symbol-z-order: invalid enum → enum-validation warn', () => {
    const w = warningsOf(buildSymbol({ 'symbol-z-order': 'sideways' }))
    expect(w.some((s) => s.includes('symbol-z-order') && s.includes('not a valid enum'))).toBe(true)
  })

  it('symbol-avoid-edges: true → specific warn (moot for cross-tile collision)', () => {
    const w = warningsOf(buildSymbol({ 'symbol-avoid-edges': true }))
    expect(
      w.some((s) => s.includes('symbol-avoid-edges') && s.includes('cross-tile collision')),
    ).toBe(true)
  })

  it('symbol-avoid-edges: false (default) does NOT warn', () => {
    const w = warningsOf(buildSymbol({ 'symbol-avoid-edges': false }))
    expect(w.some((s) => s.includes('symbol-avoid-edges'))).toBe(false)
  })

  it('layer without these properties does NOT warn', () => {
    const w = warningsOf(buildSymbol({}))
    expect(w.some((s) => s.includes('symbol-z-order') || s.includes('symbol-avoid-edges'))).toBe(
      false,
    )
  })
})
