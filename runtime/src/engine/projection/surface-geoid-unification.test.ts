// Surface geoid-unification gate (projection-matrix PR-1).
//
// The half-globe screenshot bug was caused by render surfaces sitting on
// INCONSISTENT ECEF geoid bases that all feed the same u.mvp:
//   – tile ground polygons:   WGS84 ELLIPSOID (the tiler, authoritative)
//   – synthetic background:    SPHERE  (lonLatToECEFSphere about [0,0,0])
//   – extrusion walls:         SPHERE  (lonLatToECEFSphere)
// Sphere vs ellipsoid differ ~21 km at the poles ((1-E2) ≈ 0.99327), so the
// bg disc and extruded buildings rendered on a different geoid than the
// ground tiles.
//
// PR-1 unifies BACKGROUND and EXTRUSION-WALL ECEF onto the same WGS84
// ellipsoid basis the tiler uses. This gate is the unification PROOF: for a
// spread of (lat, lon) including high latitude, BOTH the background mesh ECEF
// and the extrusion-wall ECEF must equal the TILER's ellipsoid formula
// (N*cos*cos / N*cos*sin / N*(1-E2)*sinLat) within tight tolerance — i.e. all
// three surfaces share ONE geoid. The behaviour gate is CONSISTENCY (one
// geoid), NOT a frozen pixel baseline.

import { describe, it, expect } from 'vitest'
import type { RingPolygon } from '@xgis/compiler'
import { SyntheticEarthSurfaceBackend } from '@xgis/data'
import { generateWallMeshExtrudedECEF } from '@xgis/map'
import { tileEcefCenterFromMerc } from '@xgis/engine'
import type { BackendTileResult, TileSourceSink } from '@xgis/data'

// WGS84 — the SINGLE reference geoid every surface must land on.
const A = 6378137
const F = 1 / 298.257223563
const E2 = F * (2 - F)
const DEG2RAD = Math.PI / 180
// Rounded Web-Mercator clamp — applies to the PER-VERTEX abs_lat encode only.
const MERC_LAT_CLAMP = 85.051129
// Decoded z=0 tile-south (tile-catalog.ts:1102) — the value the render `off`
// anchor uses. The bg tile-corner ANCHOR is built from THIS, not the rounded
// clamp (they differ ~2.46 cm on X), so the geoid check's residual+center
// reconstruction must use the decoded anchor to stay within the quant tolerance.
const Z0_DECODED_SOUTH = Math.atan(Math.sinh(-Math.PI)) * 180 / Math.PI

/** The TILER's ellipsoid ECEF forward (vector-tiler.ts:225-232) at height h.
 *  This is the authoritative geoid; bg + extrusion must match it. */
function tilerEllipsoidECEF(lonDeg: number, latDeg: number, h = 0): [number, number, number] {
  const lonRad = lonDeg * DEG2RAD
  const latRad = latDeg * DEG2RAD
  const sinLat = Math.sin(latRad)
  const cosLat = Math.cos(latRad)
  const N = A / Math.sqrt(1 - E2 * sinLat * sinLat)
  return [
    (N + h) * cosLat * Math.cos(lonRad),
    (N + h) * cosLat * Math.sin(lonRad),
    (N * (1 - E2) + h) * sinLat,
  ]
}

function lonLatToMerc(lon: number, lat: number): [number, number] {
  const clamped = Math.max(-MERC_LAT_CLAMP, Math.min(MERC_LAT_CLAMP, lat))
  return [
    lon * DEG2RAD * A,
    Math.log(Math.tan(Math.PI / 4 + clamped * DEG2RAD / 2)) * A,
  ]
}

function recordingSink(): { sink: TileSourceSink; pushed: { result: BackendTileResult | null }[] } {
  const pushed: { result: BackendTileResult | null }[] = []
  const sink: TileSourceSink = {
    trackLoading: () => {},
    releaseLoading: () => {},
    hasTileData: () => false,
    getLoadingCount: () => 0,
    acceptResult: (_key, result) => { pushed.push({ result }) },
  }
  return { sink, pushed }
}

describe('surface geoid unification — bg + extrusion share the tiler ellipsoid', () => {
  it('BACKGROUND mesh ECEF == tiler ellipsoid ECEF across a lat/lon spread (incl. high latitude)', () => {
    // The z=0 synthetic tile's ellipsoid anchor (the value the render-side
    // `off` reconstructs); bg residuals are relative to it. Built from the
    // DECODED tile-south (Z0_DECODED_SOUTH) — the same latitude the bg backend
    // anchors on and clampLat(tileSouth) yields render-side — NOT the rounded
    // clamp, so residual + center reconstructs the absolute ECEF exactly.
    const [tileMx, tileMy] = lonLatToMerc(-180, Z0_DECODED_SOUTH)
    const center = tileEcefCenterFromMerc(tileMx, tileMy)

    // Sphere band (projType 7) so the spread includes the polar (±90) rows.
    // F2 dual-encode: |lat|≤85.05 rows take the Merc-clamped ellipsoid ECEF
    // (geoid-identical to the kernel/ground tiles — the ≤85 equality this gate
    // protects is UNCHANGED); |lat|>85.05 polar rows take lonLatToECEF(lon, ±90)
    // directly (bg-only source-honest caps, no tiler equivalent). The reference
    // is the SAME tiler ellipsoid forward for BOTH — passed the encode latitude.
    const backend = new SyntheticEarthSurfaceBackend(7)
    const { sink, pushed } = recordingSink()
    backend.attach(sink)
    const result = pushed[0].result!
    const v = result.vertices
    const u16 = new Uint16Array(v.buffer)
    const { dequantScale: scale, dequantHalf: half } = result
    const vertexCount = v.length / 7   // #398: fill stride 28 B = 7 f32
    const deq = (lane: number): number =>
      (u16[lane] * 65536 + u16[lane + 1]) * scale - half

    // Grid layout (earth-surface-fill.ts): row-major, cols = widthSegments+1 =
    // 129, rows = heightSegments+1 = 65, sphere band lat ∈ [-90, 90]. Derive the
    // PRECISE (f64) grid lon/lat from the index — NOT the lossy f32 abs_lon/
    // abs_lat varyings — and apply the SAME encode rule (polar rows keep the
    // true ±90, the rest are Merc-clamped) so the gate is a true geoid check
    // rather than f32-rounding noise.
    const cols = 129
    const gridLon = (idx: number): number => -180 + (360 * (idx % cols)) / 128
    const gridLat = (idx: number): number => {
      const lat = -90 + (180 * Math.floor(idx / cols)) / 64
      return Math.abs(lat) > MERC_LAT_CLAMP
        ? lat
        : Math.max(-MERC_LAT_CLAMP, Math.min(MERC_LAT_CLAMP, lat))
    }

    // Sample a representative spread of grid vertices (every 37th vertex
    // strides across rows + cols, plus both poles).
    const samples = new Set<number>([0, vertexCount - 1])
    for (let i = 0; i < vertexCount; i += 37) samples.add(i)

    // Tolerance = the double-u16 quant resolution, NOT a fixed 1 mm. The bg
    // spans the whole globe (~1.3e7 m) about a single tile-corner anchor, so
    // the per-axis step = dequantScale ≈ 6 mm (span/2^32); the worst-case 3D
    // round-trip error is ≤ sqrt(3) * (dequantScale/2) per the round-to-nearest
    // bound. 4*dequantScale (~24 mm) is a safe ceiling that still proves the
    // BASIS is the ellipsoid (a sphere basis would miss by ~21 km at the pole).
    const tol = 4 * scale
    let checked = 0
    for (const idx of samples) {
      const lane = idx * 14   // #398: fill stride 14 u16/vert
      const ex = deq(lane) + center[0]
      const ey = deq(lane + 2) + center[1]
      const ez = deq(lane + 4) + center[2]
      const [rx, ry, rz] = tilerEllipsoidECEF(gridLon(idx), gridLat(idx), 0)
      const err = Math.hypot(ex - rx, ey - ry, ez - rz)
      expect(err).toBeLessThan(tol)  // ≤ quant resolution — one geoid
      checked++
    }
    expect(checked).toBeGreaterThan(10)
    // Guard the tolerance itself: dequantScale must stay finite/positive and far
    // below the ~21 km sphere↔ellipsoid pole delta this test would catch.
    expect(scale).toBeGreaterThan(0)
    expect(tol).toBeLessThan(1)  // < 1 m — orders below the 21 km basis error
  })

  it('EXTRUSION-WALL ECEF (roof + base) == tiler ellipsoid ECEF at high latitude', () => {
    const STRIDE = 11  // POLYGON_EXTRUDED_FORMAT stride / 4
    // Footprint at high latitude (lon=10, lat=60) so the sphere↔ellipsoid
    // delta (~10 m at lat=60 on the z-axis) is well above the 1 mm gate.
    const cx = 10, cy = 60
    const d = 0.005
    const baseH = 20
    const topH = 120
    const corners: [number, number][] = [
      lonLatToMerc(cx - d, cy - d),
      lonLatToMerc(cx + d, cy - d),
      lonLatToMerc(cx + d, cy + d),
      lonLatToMerc(cx - d, cy + d),
    ]
    const lonlat: [number, number][] = [
      [cx - d, cy - d],
      [cx + d, cy - d],
      [cx + d, cy + d],
      [cx - d, cy + d],
    ]
    const polygons: RingPolygon[] = [{
      featId: 5,
      rings: [[corners[0], corners[1], corners[2], corners[3], corners[0]]],
    }]
    const heights = new Map<number, number>([[5, topH - baseH]])
    const bases = new Map<number, number>([[5, baseH]])
    const center = tileEcefCenterFromMerc(corners[0][0], corners[0][1])

    const mesh = generateWallMeshExtrudedECEF(polygons, heights, bases, 0, 0, center)
    const v = mesh.vertices
    const u16 = new Uint16Array(v.buffer, v.byteOffset)
    const deq = (i: number, axis: number): number =>
      (u16[i * STRIDE * 2 + axis * 2] * 65536 + u16[i * STRIDE * 2 + axis * 2 + 1]) *
        mesh.dequantScale - mesh.dequantHalf
    const absECEF = (i: number): [number, number, number] =>
      [center[0] + deq(i, 0), center[1] + deq(i, 1), center[2] + deq(i, 2)]
    const isTop = (i: number): number => v[i * STRIDE + 10]!

    // Roof verts are the last 4 (after 16 wall verts), in input ring order at
    // the top height. Each must equal the tiler ellipsoid ECEF at (lon,lat,topH).
    const vertCount = v.length / STRIDE
    expect(vertCount).toBe(20)
    for (let i = 0; i < 4; i++) {
      const [ex, ey, ez] = absECEF(16 + i)
      const [rx, ry, rz] = tilerEllipsoidECEF(lonlat[i][0], lonlat[i][1], topH)
      const err = Math.hypot(ex - rx, ey - ry, ez - rz)
      expect(err).toBeLessThan(1e-3)
      expect(isTop(16 + i)).toBe(1)
    }

    // Wall BASE ring (is_top=0) must equal the ground geoid at (lon,lat,baseH)
    // — same ellipsoid the surrounding flat fill uses, just lifted to the base.
    // Walls emit (a_bot, b_bot, a_top, b_top) per edge in CCW ring order, so the
    // base verts map to precise corners: edge e → a_bot=corner e, b_bot=corner
    // (e+1)%4. Use the precise input lon/lat (NOT the lossy f32 abs_lon/abs_lat
    // varyings) so the 1 mm gate is a true geoid check, not f32-rounding noise.
    for (let e = 0; e < 4; e++) {
      const aBot = e * 4 + 0
      const bBot = e * 4 + 1
      expect(isTop(aBot)).toBe(0)
      expect(isTop(bBot)).toBe(0)
      for (const [vi, corner] of [[aBot, e], [bBot, (e + 1) % 4]] as const) {
        const [ex, ey, ez] = absECEF(vi)
        const [rx, ry, rz] = tilerEllipsoidECEF(lonlat[corner][0], lonlat[corner][1], baseH)
        const err = Math.hypot(ex - rx, ey - ry, ez - rz)
        expect(err).toBeLessThan(1e-3)
      }
    }
  })

  it('DIRECT: bg vertex and extrusion-wall base vertex at the SAME (lon,lat,h=0) produce equal ECEF', () => {
    // Direct bg==wall pin (not transitive through the ellipsoid reference): take
    // the SAME geographic point (lon=0, lat=0, height=0) on both surfaces and
    // assert their reconstructed absolute ECEF agree to ≤ the bg quant step.
    // If bg and walls ever drift onto different geoids, this fails directly even
    // if each independently happened to match some shared reference formula.
    const STRIDE = 11

    // ── bg surface: the z=0 mesh vertex at (lon=0, lat=0) (col=16, row=8). ──
    const [bgTileMx, bgTileMy] = lonLatToMerc(-180, Z0_DECODED_SOUTH)
    const bgCenter = tileEcefCenterFromMerc(bgTileMx, bgTileMy)
    const backend = new SyntheticEarthSurfaceBackend(0)
    const { sink, pushed } = recordingSink()
    backend.attach(sink)
    const bg = pushed[0].result!
    const bgU16 = new Uint16Array(bg.vertices.buffer)
    const bgDeq = (lane: number): number =>
      (bgU16[lane] * 65536 + bgU16[lane + 1]) * bg.dequantScale - bg.dequantHalf
    const cols = 129
    const bgIdx = 32 * cols + 64           // lon=0, lat=0
    const bgLane = bgIdx * 14   // #398: fill stride 14 u16/vert
    const bgECEF: [number, number, number] = [
      bgCenter[0] + bgDeq(bgLane),
      bgCenter[1] + bgDeq(bgLane + 2),
      bgCenter[2] + bgDeq(bgLane + 4),
    ]

    // ── wall surface: a footprint with a base corner at (lon=0, lat=0), base
    // height 0, so its a_bot vertex sits at exactly the SAME geographic point. ──
    const c0 = lonLatToMerc(0, 0)
    const c1 = lonLatToMerc(0.01, 0)
    const c2 = lonLatToMerc(0.01, 0.01)
    const c3 = lonLatToMerc(0, 0.01)
    const polygons: RingPolygon[] = [{ featId: 5, rings: [[c0, c1, c2, c3, c0]] }]
    const heights = new Map<number, number>([[5, 80]])
    const bases = new Map<number, number>([[5, 0]])   // base height 0 → ground level
    const wallCenter = tileEcefCenterFromMerc(c0[0], c0[1])
    const mesh = generateWallMeshExtrudedECEF(polygons, heights, bases, 0, 0, wallCenter)
    const wU16 = new Uint16Array(mesh.vertices.buffer, mesh.vertices.byteOffset)
    const wDeq = (i: number, axis: number): number =>
      (wU16[i * STRIDE * 2 + axis * 2] * 65536 + wU16[i * STRIDE * 2 + axis * 2 + 1]) *
        mesh.dequantScale - mesh.dequantHalf
    // First wall edge: a_bot (vertex 0) is corner 0 = (lon=0, lat=0) at base 0.
    const wallECEF: [number, number, number] = [
      wallCenter[0] + wDeq(0, 0),
      wallCenter[1] + wDeq(0, 1),
      wallCenter[2] + wDeq(0, 2),
    ]
    expect(mesh.vertices[0 * STRIDE + 10]).toBe(0)  // is_top=0 → base vertex

    // Tolerance = the bg quant step (~6 mm) plus the wall quant step — sum the two
    // round-trip resolutions. Both surfaces run the SAME WGS84 ellipsoid forward,
    // so the only gap is quantization, NOT a geoid difference (a sphere basis
    // would miss by ~21 km at the pole / metres at mid-lat).
    const tol = bg.dequantScale + mesh.dequantScale
    const err = Math.hypot(
      bgECEF[0] - wallECEF[0],
      bgECEF[1] - wallECEF[1],
      bgECEF[2] - wallECEF[2],
    )
    expect(err).toBeLessThan(tol)
    // Sanity: at the equator (lon=0,lat=0,h=0) both must land near (A,0,0).
    expect(bgECEF[0]).toBeCloseTo(A, 1)
    expect(wallECEF[0]).toBeCloseTo(A, 1)
  })
})
