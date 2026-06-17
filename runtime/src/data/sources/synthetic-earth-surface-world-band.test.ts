import { describe, it, expect } from 'vitest'
import { SyntheticEarthSurfaceBackend } from './synthetic-earth-surface-backend'
import type { BackendTileResult, TileSourceSink } from '../tile-source'
import { MERCATOR_LAT_LIMIT } from '../../engine/projection/projection'

// ═══ Synthetic earth-surface band tracks projType (source-honest world band) ═══
//
// The backend's mesh latitude band now follows worldBandForProjType, wired via
// the constructor (XGISMap passes the resolved projType on install and
// re-installs on setProjection when the band kind changes):
//   mercator-class (0/1/6) → ±MERCATOR_LAT_LIMIT (±85.05°): Web-Mercator data
//     has nothing beyond ±85°, so the bg fill stops there — source-honest, no
//     fake polar fill.
//   natural_earth (2) + sphere-class (3/4/5/7) → ±90°: rims reach the poles.
//
// This replaces the earlier gap guard that pinned the unwired ±90 hardcode.
// The backend now honors the band, so we assert the correct per-projType
// extent. (Pixel verification is impossible under SwiftShader — getImageData
// is empty — so this CPU-geometry check is the automatable path; the rendered
// disc extent was confirmed via page.screenshot.)
//
// GEOID-UNIFICATION + POLAR-CAP (F2): the bg encodes onto the SAME WGS84
// ellipsoid + RTC origin as tile ground polygons. For mercator-class (0/1/6)
// and natural_earth (2) bands — whose Web-Mercator source data legitimately
// stops at ±85.05° — the bg runs the shared tiler kernel (packECEFPolygonVertices)
// and its abs_lat caps at ±MERCATOR_LAT_LIMIT, the SAME cap real polar ground
// tiles carry (one geoid).
//
// SPHERE-class bands (ortho 3 / azimuthal_eq 4 / stereographic 5 / globe 7)
// must instead REACH the geographic poles: their disc/sphere silhouette is the
// projection of the FULL ±90 grid, so a ±85.05 cap leaves a black hole at each
// pole (userbug 09). F2 dual-encodes those bands: |lat|≤85.05 rows stay on the
// ellipsoid (geoid-identical to the kernel), while |lat|>85.05 polar rows carry
// the TRUE latitude (±90) via lonLatToECEF — source-honest caps. So sphere-class
// abs_lat now spans ±90; the |lat|≤85.05 equality with the ground geoid is
// unchanged (proven in surface-geoid-unification.test.ts).

// Decode a stride-6 vertex's TAIL latitude from float slot 5. ALL bands now hold
// TILE-LOCAL Mercator (mx − tileOriginMerc) in the f32 tail — reconstruct lat via
// origin + inverse Mercator. Mercator is clamp-bounded, so this TAIL latitude
// caps at ±85.05° for EVERY band; the sphere-class geographic poles (±90) are
// carried by the QUANTIZED ECEF lanes, NOT the tail (see #360 F1 — writing the
// raw ±90 degrees into the tail made `vs_main_ecef`'s abs_merc garbage so the
// globe fragment cull discarded the whole polar cap). The ECEF ±90 reach is
// pinned in synthetic-earth-surface-backend.test.ts (the dequant-lane checks).
const SLOT_A = 6378137
const SLOT_D2R = Math.PI / 180
const Z0_SOUTH = (Math.atan(Math.sinh(-Math.PI)) * 180) / Math.PI // z=0 tile south ≈ -85.0511°
const BG_TILE_MY = Math.log(Math.tan(Math.PI / 4 + (Z0_SOUTH * SLOT_D2R) / 2)) * SLOT_A
function decodeLat(slot5: number): number {
  const absMy = slot5 + BG_TILE_MY
  return (2 * Math.atan(Math.exp(absMy / SLOT_A)) - Math.PI / 2) / SLOT_D2R
}

function backendLatRange(projType?: number): { min: number; max: number } {
  const backend = new SyntheticEarthSurfaceBackend(projType)
  let result: BackendTileResult | null = null
  backend.attach({
    acceptResult: (_key: number, r: BackendTileResult) => { result = r },
  } as unknown as TileSourceSink)
  if (!result) throw new Error('backend did not emit a result on attach')
  const v = (result as BackendTileResult).vertices
  const n = v.length / 6
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < n; i++) {
    const lat = decodeLat(v[i * 6 + 5]!)
    if (lat < min) min = lat
    if (lat > max) max = lat
  }
  return { min, max }
}

describe('synthetic earth-surface band tracks projType (source-honest world band)', () => {
  it('mercator-class (0/1/6) clamps the bg mesh at ±85.05° — source-honest Web-Mercator extent', () => {
    for (const projType of [0, 1, 6]) {
      const { min, max } = backendLatRange(projType)
      expect(max).toBeCloseTo(MERCATOR_LAT_LIMIT, 1)
      expect(min).toBeCloseTo(-MERCATOR_LAT_LIMIT, 1)
    }
  })

  it('natural_earth (2) abs_lat caps at ±85.05° (kept on Merc-clamped ground geoid)', () => {
    // natural_earth keeps the kernel path (no polar-cap synthesis): its abs_lat
    // band caps at ±MERCATOR_LAT_LIMIT, the same ±85 cap real polar ground tiles
    // carry (one geoid). F2 polar caps apply only to the sphere-class bands.
    const { min, max } = backendLatRange(2)
    expect(max).toBeCloseTo(MERCATOR_LAT_LIMIT, 1)
    expect(min).toBeCloseTo(-MERCATOR_LAT_LIMIT, 1)
  })

  it('sphere-class (3/4/5/7) TAIL Mercator caps at ±85.05 — the ±90 poles ride the ECEF lanes, not the tail (#360 F1)', () => {
    // F2 dual-encode reaches the geographic poles through the QUANTIZED ECEF
    // POSITION lanes (lonLatToECEF(lon, ±90)) — pinned in
    // synthetic-earth-surface-backend.test.ts. The f32 TAIL, by contrast, carries
    // TILE-LOCAL MERCATOR (clamp-bounded), so its decoded latitude caps at the
    // ±85.05 Web-Mercator limit for EVERY band. Writing the raw ±90 degrees into
    // the tail (the prior bug) made `vs_main_ecef`'s abs_merc garbage, so on the
    // globe arm the fragment hemisphere-cull discarded every polar-cap fragment —
    // the #360 black hole. The tail MUST therefore stay Merc-clamped here.
    for (const projType of [3, 4, 5, 7]) {
      const { min, max } = backendLatRange(projType)
      expect(max).toBeCloseTo(MERCATOR_LAT_LIMIT, 1)   // tail clamps at +85.05 (NOT +90)
      expect(min).toBeCloseTo(-MERCATOR_LAT_LIMIT, 1)  // tail clamps at -85.05 (NOT -90)
      expect(max).toBeLessThan(86)                      // strictly NOT past the ±85 cap
    }
  })

  it('default projType (0) is mercator-clamped, NOT the old ±90 hardcode (regression)', () => {
    const { max } = backendLatRange() // no arg → constructor default 0
    expect(max).toBeCloseTo(MERCATOR_LAT_LIMIT, 1)
    expect(max).toBeLessThan(86) // was ±90 before the worldBand wiring
  })
})
