// ["distance-from-center"] (#2119) vs symbol-placement: "line" / "line-center"
// — the anchor-not-well-defined half of #2119's scope. A line-placed
// label's anchor moves continuously along the line, so the accessor has no
// single well-defined value there; the converter warns precisely (ADR-0012
// §1: property + reason + alternative) instead of letting it silently read
// null with no explanation.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function buildStyle(placement: string, opacityExpr: unknown) {
  return {
    version: 8,
    sources: { v: { type: 'vector', url: 'x.pmtiles' } },
    layers: [
      {
        id: 'labels',
        type: 'symbol',
        source: 'v',
        'source-layer': 'poi',
        layout: {
          'text-field': '{name}',
          'symbol-placement': placement,
        },
        paint: {
          'text-opacity': opacityExpr,
        },
      },
    ],
  }
}

// Opaque inside 0.5 half-diagonal units, half-opacity from 0.5 up to 1,
// gone (0) once off-screen (>=1) — the issue's own "opacity fade" example.
const FADE = ['step', ['distance-from-center'], 1, 0.5, 0.5, 1, 0]

// The anchor-warning text is matched on a substring unique to THIS
// warning (not just "[\"distance-from-center\"]", which can also appear
// inside an unrelated warning that happens to echo the raw expression
// JSON) so a false match can't hide a real regression.
const ANCHOR_WARN_FRAGMENT = 'no single well-defined feature anchor'

describe('["distance-from-center"] vs line-placed symbol layers', () => {
  it('symbol-placement "line" + distance-from-center usage warns precisely', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle('line', FADE) as never, { coverage })
    const w = coverage.warnings.find((w) => w.includes(ANCHOR_WARN_FRAGMENT))
    expect(w).toBeDefined()
    expect(w).toContain('labels') // names the layer
    expect(w).toContain('symbol-placement "line"') // names the property/value
    expect(w).toContain('symbol-placement: "point"') // the alternative
  })

  it('symbol-placement "line-center" + distance-from-center usage also warns', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle('line-center', FADE) as never, { coverage })
    const w = coverage.warnings.find((w) => w.includes(ANCHOR_WARN_FRAGMENT))
    expect(w).toBeDefined()
    expect(w).toContain('symbol-placement "line-center"')
  })

  it('symbol-placement "point" (the well-defined case) does NOT warn', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle('point', FADE) as never, { coverage })
    expect(coverage.warnings.some((w) => w.includes(ANCHOR_WARN_FRAGMENT))).toBe(false)
  })

  it('symbol-placement "line" WITHOUT distance-from-center does NOT warn (no false positive)', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle('line', 1) as never, { coverage })
    expect(coverage.warnings.some((w) => w.includes(ANCHOR_WARN_FRAGMENT))).toBe(false)
  })
})
