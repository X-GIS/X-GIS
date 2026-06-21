// circle-pitch-alignment + circle-pitch-scale default suppression.
// Mirror of the translate-anchor pattern (iter 53). X-GIS uses
// viewport-aligned circles — authors writing 'viewport' (or 'auto'
// for pitch-alignment) match X-GIS behaviour and should not see a
// spurious warning. circle-pitch-scale 'map' is now SUPPORTED
// (Phase S Batch 3 — emits the circle-pitch-scale-map flag).
// circle-pitch-alignment 'map' remains the real gap (would project
// the disc onto the ground plane) and still warns.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function build(extra: Record<string, unknown>) {
  return {
    version: 8,
    sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
    layers: [{
      id: 'p', type: 'circle', source: 'v', 'source-layer': 'p',
      paint: { 'circle-radius': 3, 'circle-color': '#fff', ...extra },
    }],
  }
}

describe('circle pitch-alignment / pitch-scale default suppression', () => {
  it("circle-pitch-alignment 'viewport' → no warning", () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(build({ 'circle-pitch-alignment': 'viewport' }) as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('circle-pitch-alignment'))).toBe(false)
  })

  it("circle-pitch-alignment 'auto' → no warning (resolves to viewport)", () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(build({ 'circle-pitch-alignment': 'auto' }) as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('circle-pitch-alignment'))).toBe(false)
  })

  it("circle-pitch-alignment 'map' → warns (real gap)", () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(build({ 'circle-pitch-alignment': 'map' }) as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('circle-pitch-alignment'))).toBe(true)
  })

  it("circle-pitch-scale 'viewport' → no warning", () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(build({ 'circle-pitch-scale': 'viewport' }) as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('circle-pitch-scale'))).toBe(false)
  })

  it("circle-pitch-scale 'map' → supported (emits circle-pitch-scale-map flag, no warning) [Phase S Batch 3]", () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(build({ 'circle-pitch-scale': 'map' }) as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('circle-pitch-scale'))).toBe(false)
  })

  it("['literal', 'viewport'] (v8 strict wrap) → unwrapped + suppressed", () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(build({ 'circle-pitch-alignment': ['literal', 'viewport'] }) as never, { coverage })
    expect(coverage.warnings.some(w => w.includes('circle-pitch-alignment'))).toBe(false)
  })
})
