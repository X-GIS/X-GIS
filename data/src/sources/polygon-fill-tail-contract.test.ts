// POLYGON_FILL_FORMAT f32-tail producer/consumer CONTRACT gate.
//
// The polygon fill VS `vs_main_ecef` (runtime/src/engine/shaders/dsl/
// polygon.ts:454-461) reads the two f32 tail slots (abs_lon @float4, abs_lat
// @float5) as TILE-LOCAL MERCATOR and reconstructs ABSOLUTE Mercator for the
// fragment hemisphere-cull:  abs_merc = tail + tile_origin_merc.
//
// EVERY producer of POLYGON_FILL_FORMAT must therefore write `merc − tileOrigin`
// into those slots. #392 migrated the tail from raw DEGREES to tile-local
// Mercator — but `packECEFWithPolarCaps` was left STALE writing degrees, so on
// the globe arm `abs_merc` was garbage and the hemisphere cull discarded the
// whole polar cap: the #360 black hole. Per-producer unit tests did NOT catch it
// (they asserted the degrees value — they codified the bug).
//
// This gate pins BOTH producers — the compiler tiler kernel
// `packECEFPolygonVertices` AND the runtime `packECEFWithPolarCaps` — to the
// consumer's reconstruction, so a future producer (or a revert) that writes
// degrees / absolute-merc instead of tile-local-merc fails HERE, at pack time,
// not at the pole. Pairs with the fragment-discard-bisect skill.

import { describe, it, expect } from 'vitest'
import { packECEFPolygonVertices } from '@xgis/compiler'
import { packECEFWithPolarCaps, MERC_LAT_CLAMP } from './polar-cap-ecef-pack'
import { tileEcefCenterFromMerc } from '@xgis/shared'

const A = 6378137
const DEG2RAD = Math.PI / 180
const FILL = 7 // floats per vertex (POLYGON_FILL_FORMAT stride, #398)
const LON_SLOT = 4 // abs_lon (tile-local Mercator X)
const LAT_SLOT = 5 // abs_lat (tile-local Mercator Y)
const TRUELAT_SLOT = 6 // true_lat (UNCLAMPED latitude degrees — disc arm, #398)

const mercX = (lonDeg: number): number => lonDeg * DEG2RAD * A
const mercY = (latDeg: number): number =>
  Math.log(Math.tan(Math.PI / 4 + (latDeg * DEG2RAD) / 2)) * A

// The z=0 synthetic-tile origin (lon=-180, decoded tile-south) — the SAME anchor
// the synthetic + polar-cap backends use and the renderer writes to
// `tile_origin_merc`. The consumer reconstructs abs_merc = tail + this origin.
const Z0_SOUTH = (Math.atan(Math.sinh(-Math.PI)) * 180) / Math.PI
const ORIGIN: readonly [number, number] = [mercX(-180), mercY(Z0_SOUTH)]
const ANCHOR = tileEcefCenterFromMerc(ORIGIN[0], ORIGIN[1])

/** Consumer contract: abs_merc = tail + tile_origin_merc (vs_main_ecef). */
function absMercFromTail(t4: number, t5: number): [number, number] {
  return [t4 + ORIGIN[0], t5 + ORIGIN[1]]
}

// f32 tail at ~2e7 m has ulp ≈ 2 m; assert within a few metres.
const NEAR_M = 8

describe('POLYGON_FILL_FORMAT f32 tail contract: slots 4/5 are TILE-LOCAL Mercator', () => {
  it('packECEFPolygonVertices (compiler kernel) writes tail + origin == absolute Mercator', () => {
    const lon = 30,
      lat = 50
    const mx = mercX(lon),
      my = mercY(lat)
    // scratch is stride-3 [mx, my, fid] (absolute Mercator metres).
    const { vertices } = packECEFPolygonVertices([mx, my, 0], ANCHOR, ORIGIN)
    const [absMx, absMy] = absMercFromTail(vertices[LON_SLOT]!, vertices[LAT_SLOT]!)
    expect(Math.abs(absMx - mx)).toBeLessThan(NEAR_M)
    expect(Math.abs(absMy - my)).toBeLessThan(NEAR_M)
    // #398 slot 6: ground/non-polar true_lat == the clamped-decoded latitude.
    // lat=50 is below the Merc clamp, so the abs_lat slot decodes to 50 and
    // true_lat must agree (the disc arm reads the SAME latitude for ground).
    const decodedLat = (2 * Math.atan(Math.exp(absMy / A)) - Math.PI / 2) / DEG2RAD
    expect(vertices[TRUELAT_SLOT]!).toBeCloseTo(lat, 4)
    expect(vertices[TRUELAT_SLOT]!).toBeCloseTo(decodedLat, 4)
  })

  it('packECEFWithPolarCaps writes tile-local Mercator (clamped), NOT degrees — #360 regression gate', () => {
    // A POLAR vertex (lat 90 > clamp) + a mid vertex. The polar row is the exact
    // one #360 mis-packed: its tail must be Mercator-clamped to ±85.05, never
    // the raw 90 degrees (which decodes — once `+ origin` — to a back-facing
    // bogus lat/lon that the hemisphere cull discards).
    const mesh = new Float32Array([30, 90, 30, 50]) // (lon,lat) × 2
    const { vertices } = packECEFWithPolarCaps(mesh, 2, ANCHOR, ORIGIN)

    // vertex 0: lon=30, lat=90 → tail + origin == (mercX(30), mercY(85.051129)).
    const [absMx0, absMy0] = absMercFromTail(vertices[LON_SLOT]!, vertices[LAT_SLOT]!)
    expect(Math.abs(absMx0 - mercX(30))).toBeLessThan(NEAR_M)
    // The clamped Mercator-Y is POSITIVE ~+2.0e7; the degrees bug would land
    // ~-2.0e7 (90 + the south origin), so this assertion is the discriminator.
    expect(Math.abs(absMy0 - mercY(MERC_LAT_CLAMP))).toBeLessThan(NEAR_M)
    // Decoded latitude is Merc-clamped — never the raw ±90 nor a degrees artefact.
    const lat0 = (2 * Math.atan(Math.exp(absMy0 / A)) - Math.PI / 2) / DEG2RAD
    expect(lat0).toBeCloseTo(MERC_LAT_CLAMP, 2)
    // #398 slot 6: the POLAR row keeps the TRUE unclamped latitude (±90) — this
    // is what the disc (flat_rel) arm projects from to reach the pole, while
    // abs_lat (slot 5) stays Merc-clamped for the hemisphere cull.
    expect(vertices[TRUELAT_SLOT]!).toBeCloseTo(90, 4)

    // vertex 1: lon=30, lat=50 (below the clamp) → straight Mercator passthrough.
    const [absMx1, absMy1] = absMercFromTail(vertices[FILL + LON_SLOT]!, vertices[FILL + LAT_SLOT]!)
    expect(Math.abs(absMx1 - mercX(30))).toBeLessThan(NEAR_M)
    expect(Math.abs(absMy1 - mercY(50))).toBeLessThan(NEAR_M)
    // #398 slot 6: a below-clamp row's true_lat == its actual latitude (50).
    expect(vertices[FILL + TRUELAT_SLOT]!).toBeCloseTo(50, 4)
  })
})
