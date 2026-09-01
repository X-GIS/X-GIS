// Mapbox source `scheme` field accepts only "xyz" (default) or "tms".
// An unknown value (typo like "XYZ" / "wms" / "TMS") silently falls
// through to xyz without diagnostic — the map renders without
// reflecting the authored intent. Iter 79 surfaces this gap.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function warningsOf(style: unknown): string[] {
  const coverage = { sources: [], layers: [], warnings: [] as string[] }
  convertMapboxStyle(style as never, { coverage })
  return coverage.warnings
}

describe('source scheme unknown-value gate', () => {
  it('scheme: "wms" warns with the offending value', () => {
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'raster', tiles: ['https://x/{z}/{x}/{y}.png'], scheme: 'wms' } },
      layers: [],
    })
    expect(w.some((s) => s.includes('scheme') && s.includes('wms'))).toBe(true)
  })

  it('scheme: "XYZ" (case-typo) warns', () => {
    // Spec is lowercase "xyz". Uppercase typo silently falls through
    // without this gate.
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'raster', tiles: ['https://x/{z}/{x}/{y}.png'], scheme: 'XYZ' } },
      layers: [],
    })
    expect(w.some((s) => s.includes('scheme') && s.includes('XYZ'))).toBe(true)
  })

  it('scheme: "TMS" (case-typo) warns', () => {
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'raster', tiles: ['https://x/{z}/{x}/{y}.png'], scheme: 'TMS' } },
      layers: [],
    })
    expect(w.some((s) => s.includes('scheme') && s.includes('TMS'))).toBe(true)
  })

  it('scheme: "xyz" (default) does NOT warn', () => {
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'raster', tiles: ['https://x/{z}/{x}/{y}.png'], scheme: 'xyz' } },
      layers: [],
    })
    expect(w.some((s) => s.includes('scheme'))).toBe(false)
  })

  it('scheme: "tms" no longer warns on a raster source — it is EMITTED (#1985)', () => {
    // The Y-flip warning this file used to pin is retired: `scheme` now reaches the tile
    // URL builder, which substitutes `2^z − 1 − y` for `{y}`. The unknown-value gate
    // above is the half that survives, because an unrecognised value still falls back to
    // xyz (matching MapLibre, which tests `scheme === 'tms'` and defaults everything
    // else). The emit witness itself lives in source-scheme-emit.test.ts.
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'raster', tiles: ['https://x/{z}/{x}/{y}.png'], scheme: 'tms' } },
      layers: [],
    })
    expect(w.some((s) => s.includes('scheme'))).toBe(false)
  })
})
