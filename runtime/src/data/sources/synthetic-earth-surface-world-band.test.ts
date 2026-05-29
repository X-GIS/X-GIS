import { describe, expect, it } from 'vitest'
import { SyntheticEarthSurfaceBackend } from './synthetic-earth-surface-backend'
import type { BackendTileResult, TileSourceSink } from '../tile-source'
import { worldBandForProjType } from '../../engine/projection/earth-surface-fill'
import { MERCATOR_LAT_LIMIT } from '../../engine/projection/projection'

// ═══ Source-honest world-band gap guard ═══
//
// `worldBandForProjType()` promises mercator-class projTypes (0/1/6) clamp the
// earth-surface fill at ±MERCATOR_LAT_LIMIT (±85.05°) — the source-honest band
// for Web-Mercator data, which has no data beyond ±85°. But
// `SyntheticEarthSurfaceBackend` hardcodes `'sphere-full'` (±90°) and never
// consumes projType, so the bg mesh reaches the geographic poles on EVERY
// projection. Visually confirmed during investigation: mercator (projType 0)
// and globe (projType 7) render a pixel-identical ±90° disc with the same bg
// fill — projType has zero effect on the band.
//
// This is intended scaffolding, not a fixed bug: worldBandForProjType is
// defined + unit-tested (earth-surface-fill.test.ts), but its runtime consumer
// (per-projType bands fed into the backend) is deferred. The backend comment
// itself notes the mesh ±90° "intentionally differ[s]" from the ±85° catalog
// bounds.
//
// This guard PINS that gap explicitly so it can't drift silently:
//   - asserts worldBandForProjType still promises ±85° for mercator-class
//   - asserts the backend currently ships ±90° regardless of projType
//   - asserts ±90° EXCEEDS the mercator band the design promises
// When the backend is wired to honor worldBandForProjType (mercator → ±85°),
// the ±90° assertions flip red — the signal that the gap has closed and this
// guard must be updated to the new per-projType contract.
//
// Why CPU-geometry and not pixels: SwiftShader headless returns empty
// getImageData (the ±90° disc was confirmed via page.screenshot only), so a
// CPU-side vertex-range check is the only automatable verification path.

function backendResult(): BackendTileResult {
  const backend = new SyntheticEarthSurfaceBackend()
  let result: BackendTileResult | null = null
  backend.attach({
    acceptResult: (_key: number, r: BackendTileResult) => { result = r },
  } as unknown as TileSourceSink)
  if (!result) throw new Error('backend did not emit a result on attach')
  return result
}

/** abs_lat tail field lives at stride-6 offset 5 (degrees) — see
 *  synthetic-earth-surface-backend.ts:156 (`vertices[f + 5] = lats[i]`). */
function vertexLatRange(r: BackendTileResult): { min: number; max: number } {
  const v = r.vertices
  const n = v.length / 6
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < n; i++) {
    const lat = v[i * 6 + 5]!
    if (lat < min) min = lat
    if (lat > max) max = lat
  }
  return { min, max }
}

describe('synthetic earth-surface world-band — source-honest gap guard', () => {
  it('worldBandForProjType promises mercator-class (0/1/6) → ±85.05° clamp', () => {
    expect(worldBandForProjType(0)).toBe('mercator-clamped')
    expect(worldBandForProjType(1)).toBe('mercator-clamped')
    expect(worldBandForProjType(6)).toBe('mercator-clamped')
  })

  it('backend ships ±90° vertices (sphere-full hardcode), NOT yet wired to worldBand', () => {
    const { min, max } = vertexLatRange(backendResult())
    // Sphere-full band: vertices span the full ±90° geographic range.
    expect(max).toBeCloseTo(90, 1)
    expect(min).toBeCloseTo(-90, 1)
  })

  it('GAP: bg reaches the poles, exceeding the mercator band worldBandForProjType promises', () => {
    const { max } = vertexLatRange(backendResult())
    // The mercator band would clamp at ±85.05°; the backend ships ±90°, so the
    // bg fill exceeds the source-honest mercator extent by ~5°. Flips red when
    // the backend honors worldBandForProjType(mercator).
    expect(max).toBeGreaterThan(MERCATOR_LAT_LIMIT + 1)
  })
})
