// circle-pitch-alignment + circle-pitch-scale default suppression.
// Mirror of the translate-anchor pattern (iter 53). Authors writing the
// value that already matches X-GIS behaviour should not see a spurious
// warning. circle-pitch-scale 'map' is SUPPORTED (Phase S Batch 3 —
// emits the circle-pitch-scale-map flag).
//
// #2118 — circle-pitch-alignment 'map' is SUPPORTED TOO now (it emits
// circle-pitch-alignment-map and the point VS lays the disc in the
// ground plane), so the row below that used to assert "still warns"
// asserts the opposite. What survives as a warning is the ONE pairing
// that is genuinely deferred: 'map' alignment with an EXPLICIT
// 'viewport' scale, which needs MapLibre's perspective_ratio
// compensation and would otherwise be silently approximated.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function build(extra: Record<string, unknown>) {
  return {
    version: 8,
    sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
    layers: [
      {
        id: 'p',
        type: 'circle',
        source: 'v',
        'source-layer': 'p',
        paint: { 'circle-radius': 3, 'circle-color': '#fff', ...extra },
      },
    ],
  }
}

describe('circle pitch-alignment / pitch-scale default suppression', () => {
  it("circle-pitch-alignment 'viewport' → no warning", () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(build({ 'circle-pitch-alignment': 'viewport' }) as never, { coverage })
    expect(coverage.warnings.some((w) => w.includes('circle-pitch-alignment'))).toBe(false)
  })

  it("circle-pitch-alignment 'auto' → no warning (resolves to viewport)", () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(build({ 'circle-pitch-alignment': 'auto' }) as never, { coverage })
    expect(coverage.warnings.some((w) => w.includes('circle-pitch-alignment'))).toBe(false)
  })

  it("circle-pitch-alignment 'map' → supported, no warning (#2118)", () => {
    // Was "→ warns (real gap)" until #2118. An author who writes only
    // circle-pitch-alignment:map is asking for the ground-plane disc at the
    // SPEC default scale ('map'), which is exactly the supported pairing —
    // so there is nothing left to warn about.
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(build({ 'circle-pitch-alignment': 'map' }) as never, { coverage })
    expect(coverage.warnings.some((w) => w.includes('circle-pitch-alignment'))).toBe(false)
  })

  it("circle-pitch-alignment 'map' + explicit circle-pitch-scale 'viewport' → warns PRECISELY", () => {
    // The deferral, and the whole point of warning instead of approximating:
    // that pair needs a perspective_ratio whose single authority is not on main.
    // The message must name the property, the reason AND a way forward — a bare
    // "not supported" leaves the author with nothing to do (ADR-0012 §1).
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(
      build({ 'circle-pitch-alignment': 'map', 'circle-pitch-scale': 'viewport' }) as never,
      { coverage },
    )
    const w = coverage.warnings.find((x) => x.includes('circle-pitch-alignment'))
    expect(w, 'the deferred pairing must warn').toBeDefined()
    expect(w).toContain('circle-pitch-scale')
    expect(w).toContain('perspective_ratio')
    expect(w).toContain('Alternative:')
  })

  it("circle-pitch-scale 'viewport' → no warning", () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(build({ 'circle-pitch-scale': 'viewport' }) as never, { coverage })
    expect(coverage.warnings.some((w) => w.includes('circle-pitch-scale'))).toBe(false)
  })

  it("circle-pitch-scale 'map' → supported (emits circle-pitch-scale-map flag, no warning) [Phase S Batch 3]", () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(build({ 'circle-pitch-scale': 'map' }) as never, { coverage })
    expect(coverage.warnings.some((w) => w.includes('circle-pitch-scale'))).toBe(false)
  })

  it("['literal', 'viewport'] (v8 strict wrap) → unwrapped + suppressed", () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(build({ 'circle-pitch-alignment': ['literal', 'viewport'] }) as never, {
      coverage,
    })
    expect(coverage.warnings.some((w) => w.includes('circle-pitch-alignment'))).toBe(false)
  })
})
