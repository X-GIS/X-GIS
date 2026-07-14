// Unit tests for `generateWallMeshExtrudedECEF` — the Phase 2 PR 2c.2
// stride-14 ECEF-RTC wall + roof mesh generator.
//
// Coverage:
//   1. Single quad footprint at (lon=0, lat=0), height=100m — vertex
//      count, is_top discriminator, face_normal unit-magnitude.
//   2. Random footprint at lat=45° — roof ECEF magnitude matches
//      lonLatToECEF (WGS84 ellipsoid, _, _, 100) within 1 mm.
//   3. Roof face_normal points outward (dot with vertex ECEF > 0.9).
//   4. Wall face_normal is horizontal (|fn · Up| < 0.1).

import { describe, expect, it } from 'vitest'
import type { RingPolygon } from '@xgis/compiler'
import { generateWallMeshExtrudedECEF } from './polygon-mesh'
import { lonLatToECEF, tileEcefCenterFromMerc } from '@xgis/shared'

// Phase 2 PR 2f: quantized ECEF extruded layout — stride 44 bytes = 11
// floats. uint16×6 position in the first 12 bytes; f32 tail at float slots
// 3..10 (fid, abs_lon, abs_lat, face_normal×3, wall_height, is_top).
const STRIDE = 11
const A = 6378137
const DEG2RAD = Math.PI / 180

// Convert (lon, lat) in degrees to tile-local Mercator metres given a
// tile origin (also in Mercator metres). For the simple test fixtures
// here the tile origin is the world centre, so absolute Mercator
// equals the tile-local coordinate the test passes into the ring.
function lonLatToMerc(lon: number, lat: number): [number, number] {
  const mx = lon * DEG2RAD * A
  const my = Math.log(Math.tan(Math.PI / 4 + (lat * DEG2RAD) / 2)) * A
  return [mx, my]
}

interface UnpackedVertex {
  /** Dequanted ECEF RTC residual (metres), reconstructed via the GPU's math. */
  rx: number
  ry: number
  rz: number
  fid: number
  abs_lon: number
  abs_lat: number
  fn_x: number
  fn_y: number
  fn_z: number
  wall_height: number
  is_top: number
}

interface MeshLike {
  vertices: Float32Array
  dequantScale: number
  dequantHalf: number
}

function unpack(mesh: MeshLike, i: number): UnpackedVertex {
  const o = i * STRIDE
  const v = mesh.vertices
  // Dequant position via the GPU VS math: q = hi*65536 + lo; axis = q*scale - half.
  const u16 = new Uint16Array(v.buffer, v.byteOffset)
  const lane = i * STRIDE * 2
  const deq = (axis: number): number =>
    (u16[lane + axis * 2]! * 65536 + u16[lane + axis * 2 + 1]!) * mesh.dequantScale -
    mesh.dequantHalf
  return {
    rx: deq(0),
    ry: deq(1),
    rz: deq(2),
    fid: v[o + 3]!,
    abs_lon: v[o + 4]!,
    abs_lat: v[o + 5]!,
    fn_x: v[o + 6]!,
    fn_y: v[o + 7]!,
    fn_z: v[o + 8]!,
    wall_height: v[o + 9]!,
    is_top: v[o + 10]!,
  }
}

function reconstructECEF(
  v: UnpackedVertex,
  center: readonly [number, number, number],
): [number, number, number] {
  return [center[0] + v.rx, center[1] + v.ry, center[2] + v.rz]
}

describe('generateWallMeshExtrudedECEF', () => {
  it('emits stride-44-byte quantized verts with correct is_top discriminator for a single quad at the equator', () => {
    // 1° × 1° quad straddling (0, 0). CCW outer ring (positive area in
    // mx/my). 4 unique verts; ring is CLOSED (last == first).
    const p0 = lonLatToMerc(-0.5, -0.5)
    const p1 = lonLatToMerc(0.5, -0.5)
    const p2 = lonLatToMerc(0.5, 0.5)
    const p3 = lonLatToMerc(-0.5, 0.5)
    const polygons: RingPolygon[] = [
      {
        featId: 42,
        rings: [[p0, p1, p2, p3, p0]], // CCW
      },
    ]
    const heights = new Map<number, number>([[42, 100]])
    // Use the polygon centroid (approximately (0, 0)) as the tile
    // origin so synthetic-edge detection doesn't fire on the test
    // (extents differ from the bbox).
    const tileMx = 0 // far western world edge
    const tileMy = 0
    const center = tileEcefCenterFromMerc(0, 0)

    const mesh = generateWallMeshExtrudedECEF(polygons, heights, undefined, tileMx, tileMy, center)

    // 4 walls × 4 verts = 16 wall verts + 4 roof verts (outer ring,
    // closing dup stripped) = 20.
    const vertCount = mesh.vertices.length / STRIDE
    expect(vertCount).toBe(20)
    // 4 walls × 6 + 2 roof tris × 3 = 30.
    expect(mesh.indices.length).toBe(30)

    // First 16 verts = walls in (a_bot, b_bot, a_top, b_top) order.
    // a_bot + b_bot = is_top 0; a_top + b_top = is_top 1.
    let wallBottom = 0,
      wallTop = 0
    for (let i = 0; i < 16; i++) {
      const v = unpack(mesh, i)
      if (v.is_top === 0) wallBottom++
      else if (v.is_top === 1) wallTop++
      expect(v.fid).toBe(42)
      expect(v.wall_height).toBeCloseTo(100, 4)
    }
    expect(wallBottom).toBe(8)
    expect(wallTop).toBe(8)

    // Remaining 4 verts = roof, all is_top = 1.
    for (let i = 16; i < 20; i++) {
      const v = unpack(mesh, i)
      expect(v.is_top).toBe(1)
      expect(v.fid).toBe(42)
      expect(v.wall_height).toBeCloseTo(100, 4)
    }

    // face_normal magnitudes ≈ 1 across all vertices.
    for (let i = 0; i < vertCount; i++) {
      const v = unpack(mesh, i)
      const mag = Math.hypot(v.fn_x, v.fn_y, v.fn_z)
      expect(mag).toBeCloseTo(1, 5)
    }
  })

  it('roof ECEF magnitude matches lonLatToECEF (WGS84 ellipsoid) within 1 mm at lat=45°', () => {
    // 0.01° × 0.01° quad around (lon=10, lat=45), height 50m.
    const cx = 10,
      cy = 45
    const d = 0.005
    const corners = [
      lonLatToMerc(cx - d, cy - d),
      lonLatToMerc(cx + d, cy - d),
      lonLatToMerc(cx + d, cy + d),
      lonLatToMerc(cx - d, cy + d),
    ]
    const polygons: RingPolygon[] = [
      {
        featId: 7,
        rings: [[corners[0], corners[1], corners[2], corners[3], corners[0]]],
      },
    ]
    const heights = new Map<number, number>([[7, 50]])
    // Tile origin far from bbox so synthetic-edge detection is inert.
    const tileMx = 0
    const tileMy = 0
    const center = tileEcefCenterFromMerc(corners[0][0], corners[0][1])

    const mesh = generateWallMeshExtrudedECEF(polygons, heights, undefined, tileMx, tileMy, center)

    // Reference ECEFs at corner lon/lat on the WGS84 ELLIPSOID (NOT via
    // the f32-quantized abs_lon/abs_lat varyings — those are intentionally
    // lossy for GPU-side picking, not for sub-mm geometry reconstruction).
    // The generator now uses lonLatToECEF (ellipsoid) so wall/roof verts
    // share the tiler's geoid; the reference is re-pointed to match.
    const refCorners = [
      lonLatToECEF(cx - d, cy - d, 50),
      lonLatToECEF(cx + d, cy - d, 50),
      lonLatToECEF(cx + d, cy + d, 50),
      lonLatToECEF(cx - d, cy + d, 50),
    ]
    // Roof verts come after wall verts; wall vert count = 4 edges × 4
    // = 16, so verts 16..19 are roof, in input ring order.
    for (let i = 0; i < 4; i++) {
      const v = unpack(mesh, 16 + i)
      const [ex, ey, ez] = reconstructECEF(v, center)
      const [refX, refY, refZ] = refCorners[i]
      const dx = ex - refX,
        dy = ey - refY,
        dz = ez - refZ
      const err = Math.hypot(dx, dy, dz)
      // DSFUN-reconstructed ECEF carries sub-mm precision relative to
      // the per-tile centre. 1 mm is the agreed gate (`AGENTS.md`
      // tier-3 spec).
      expect(err).toBeLessThan(1e-3)
    }
  })

  it('roof face_normal points outward (dot with ECEF position > 0.9)', () => {
    // Larger building footprint so vertex ECEF magnitudes are well
    // above floating-point noise. Centred at (lon=120, lat=30).
    const cx = 120,
      cy = 30
    const d = 0.01
    const corners = [
      lonLatToMerc(cx - d, cy - d),
      lonLatToMerc(cx + d, cy - d),
      lonLatToMerc(cx + d, cy + d),
      lonLatToMerc(cx - d, cy + d),
    ]
    const polygons: RingPolygon[] = [
      {
        featId: 1,
        rings: [[corners[0], corners[1], corners[2], corners[3], corners[0]]],
      },
    ]
    const heights = new Map<number, number>([[1, 200]])
    const tileMx = 0
    const tileMy = 0
    const center = tileEcefCenterFromMerc(corners[0][0], corners[0][1])

    const mesh = generateWallMeshExtrudedECEF(polygons, heights, undefined, tileMx, tileMy, center)

    // Roof verts at indices 16..19.
    for (let i = 16; i < 20; i++) {
      const v = unpack(mesh, i)
      const [ex, ey, ez] = reconstructECEF(v, center)
      const pmag = Math.hypot(ex, ey, ez)
      const dot = (v.fn_x * ex + v.fn_y * ey + v.fn_z * ez) / pmag
      // Roof normal IS the radial up — dot with position direction ≈ 1.
      expect(dot).toBeGreaterThan(0.9)
    }
  })

  it('wall face_normal is horizontal (|fn · radial_up| < 0.1)', () => {
    const cx = 120,
      cy = 30
    const d = 0.01
    const corners = [
      lonLatToMerc(cx - d, cy - d),
      lonLatToMerc(cx + d, cy - d),
      lonLatToMerc(cx + d, cy + d),
      lonLatToMerc(cx - d, cy + d),
    ]
    const polygons: RingPolygon[] = [
      {
        featId: 1,
        rings: [[corners[0], corners[1], corners[2], corners[3], corners[0]]],
      },
    ]
    const heights = new Map<number, number>([[1, 200]])
    const tileMx = 0
    const tileMy = 0
    const center = tileEcefCenterFromMerc(corners[0][0], corners[0][1])

    const mesh = generateWallMeshExtrudedECEF(polygons, heights, undefined, tileMx, tileMy, center)

    // Wall verts at indices 0..15.
    for (let i = 0; i < 16; i++) {
      const v = unpack(mesh, i)
      const [ex, ey, ez] = reconstructECEF(v, center)
      const pmag = Math.hypot(ex, ey, ez)
      const upX = ex / pmag,
        upY = ey / pmag,
        upZ = ez / pmag
      const dot = Math.abs(v.fn_x * upX + v.fn_y * upY + v.fn_z * upZ)
      expect(dot).toBeLessThan(0.1)
    }
  })

  it('missing height entries default to 0 (no degenerate failure)', () => {
    const p0 = lonLatToMerc(-0.5, -0.5)
    const p1 = lonLatToMerc(0.5, -0.5)
    const p2 = lonLatToMerc(0.5, 0.5)
    const p3 = lonLatToMerc(-0.5, 0.5)
    const polygons: RingPolygon[] = [
      {
        featId: 99,
        rings: [[p0, p1, p2, p3, p0]],
      },
    ]
    const heights = new Map<number, number>() // empty
    const tileMx = 0
    const tileMy = 0
    const center = tileEcefCenterFromMerc(0, 0)

    const mesh = generateWallMeshExtrudedECEF(polygons, heights, undefined, tileMx, tileMy, center)

    // Still emits walls + roof (degenerate-but-present), wall_height = 0.
    for (let i = 0; i < mesh.vertices.length / STRIDE; i++) {
      const v = unpack(mesh, i)
      expect(v.wall_height).toBe(0)
    }
  })
})

// ─────────────────────────────────────────────────────────────────
// #1079 — extrusion roof coverage when a feature clip-splits into N pieces.
//
// End-to-end guard for the fixed pipeline: the tiler (#1079) now emits ONE
// RingPolygon PER disjoint piece rather than flattening all pieces' outers
// into one entry's `rings`. This is the FIRST test here exercising
// `polygons.length > 1`. It pins the consumer contract that makes the fix
// pay off: two SEPARATE RingPolygons produce roof triangles covering BOTH
// footprints — whereas the OLD flattened shape (all outers in one entry)
// leaves piece #2 un-roofed because the consumer reads rings[1..] as holes.
// ─────────────────────────────────────────────────────────────────
describe('generateWallMeshExtrudedECEF — #1079 multi-piece roof coverage', () => {
  // Two DISJOINT CCW squares (positive mx/my area), far apart in lon so their
  // roof vertices separate cleanly by longitude. Both belong to one feature
  // (featId 7) — the shape a clip-split feature takes after the #1079 fix.
  const sqA = [
    lonLatToMerc(1.0, 1.0),
    lonLatToMerc(1.2, 1.0),
    lonLatToMerc(1.2, 1.2),
    lonLatToMerc(1.0, 1.2),
    lonLatToMerc(1.0, 1.0),
  ]
  const sqB = [
    lonLatToMerc(2.0, 2.0),
    lonLatToMerc(2.2, 2.0),
    lonLatToMerc(2.2, 2.2),
    lonLatToMerc(2.0, 2.2),
    lonLatToMerc(2.0, 2.0),
  ]
  const heights = new Map<number, number>([[7, 100]])
  const center = tileEcefCenterFromMerc(sqA[0][0], sqA[0][1])

  // 2D point-in-triangle (inclusive of edges), operating on the stored
  // abs_lon/abs_lat degrees (EARTH.sphereR === 6378137 === the test's A, so
  // the ring-mx round-trips to the input lon/lat exactly).
  const pointInTri = (
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
  ): boolean => {
    const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by)
    const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy)
    const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay)
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0
    return !(hasNeg && hasPos)
  }

  // Extract ROOF triangles (all three verts radial-up = roof, not wall) as
  // [lon,lat] triples in the stored abs_lon/abs_lat space.
  const roofTriangles = (
    mesh: ReturnType<typeof generateWallMeshExtrudedECEF>,
  ): Array<[number, number][]> => {
    const vertCount = mesh.vertices.length / STRIDE
    const isRoof: boolean[] = []
    const lonlat: [number, number][] = []
    for (let i = 0; i < vertCount; i++) {
      const v = unpack(mesh, i)
      const [ex, ey, ez] = reconstructECEF(v, center)
      const pmag = Math.hypot(ex, ey, ez)
      const radialDot = (v.fn_x * ex + v.fn_y * ey + v.fn_z * ez) / pmag
      isRoof.push(v.is_top === 1 && radialDot > 0.9)
      lonlat.push([v.abs_lon, v.abs_lat])
    }
    const tris: Array<[number, number][]> = []
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const i0 = mesh.indices[t]!,
        i1 = mesh.indices[t + 1]!,
        i2 = mesh.indices[t + 2]!
      if (isRoof[i0] && isRoof[i1] && isRoof[i2]) tris.push([lonlat[i0]!, lonlat[i1]!, lonlat[i2]!])
    }
    return tris
  }

  const covered = (tris: Array<[number, number][]>, lon: number, lat: number): boolean =>
    tris.some((tr) =>
      pointInTri(lon, lat, tr[0][0], tr[0][1], tr[1][0], tr[1][1], tr[2][0], tr[2][1]),
    )

  it('two SEPARATE RingPolygons roof BOTH footprints (the #1079-fixed producer output)', () => {
    const polygons: RingPolygon[] = [
      { featId: 7, rings: [sqA] },
      { featId: 7, rings: [sqB] },
    ]
    const mesh = generateWallMeshExtrudedECEF(polygons, heights, undefined, 0, 0, center)
    const tris = roofTriangles(mesh)
    // Interior, off-diagonal query points inside each square.
    expect(covered(tris, 1.05, 1.14), 'square A footprint roofed').toBe(true)
    expect(covered(tris, 2.05, 2.14), 'square B footprint roofed').toBe(true)
  })

  it('the OLD flattened shape (both outers in ONE entry) leaves piece #2 un-roofed', () => {
    // Regression contrast: this is what the tiler emitted BEFORE #1079 — a
    // single RingPolygon whose rings=[outerA, outerB]. The consumer reads
    // rings[1] (outer B) as a HOLE, so B's footprint is never roofed. Pins
    // WHY the producer must emit separate entries.
    const flattened: RingPolygon[] = [{ featId: 7, rings: [sqA, sqB] }]
    const mesh = generateWallMeshExtrudedECEF(flattened, heights, undefined, 0, 0, center)
    const tris = roofTriangles(mesh)
    expect(covered(tris, 1.05, 1.14), 'square A still roofed').toBe(true)
    expect(covered(tris, 2.05, 2.14), 'square B punched out (bug)').toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────
// #1083 — extrusion walls must NOT be grown on clip-synthetic tile-boundary
// edges. When the tiler clips a building that straddles a tile boundary,
// Sutherland-Hodgman inserts an axis-aligned edge lying exactly on the tile
// rect. That edge is a seam, not a face; extruding a wall on it draws an
// interior wall along the tile boundary (MapLibre skips it via the same
// isBoundaryEdge idea). The generator suppresses these ONLY when the caller
// threads the tile's ABSOLUTE Mercator extent.
// ─────────────────────────────────────────────────────────────────
describe('generateWallMeshExtrudedECEF — #1083 tile-boundary seam walls', () => {
  // Tile rect in ABSOLUTE Mercator metres (mid-latitude, ~10 km square).
  const west = 100000,
    east = 110000,
    south = 4000000,
    north = 4010000
  const extent = { west, south, east, north }
  // RTC anchor at the tile SW corner (matches the production upload caller).
  // tileMx/tileMy are unused by the generator but passed for parity.
  const center = tileEcefCenterFromMerc(west, south)
  const heights = new Map<number, number>([[5, 100]])

  // Base edge of wall `w` as [mxA, mxB] in ABSOLUTE Mercator, recovered from
  // the stored abs_lon (mx = lon·DEG2RAD·A). Walls are 4 verts in
  // (a_bot, b_bot, a_top, b_top) order → base endpoints are verts 4w, 4w+1.
  const wallBaseMx = (mesh: MeshLike, w: number): [number, number] => {
    const a = unpack(mesh, w * 4)
    const b = unpack(mesh, w * 4 + 1)
    return [a.abs_lon * DEG2RAD * A, b.abs_lon * DEG2RAD * A]
  }
  const onEast = (mx: number): boolean => Math.abs(mx - east) < 1
  // Wall quads whose base edge lies on the east boundary. Roof adds 4 verts
  // (footprint corners) after the walls, so wallCount = (verts − 4) / 4.
  const wallsOnEast = (mesh: MeshLike): number => {
    const walls = (mesh.vertices.length / STRIDE - 4) / 4
    let n = 0
    for (let w = 0; w < walls; w++) {
      const [ma, mb] = wallBaseMx(mesh, w)
      if (onEast(ma) && onEast(mb)) n++
    }
    return n
  }

  it('drops the wall on a tile-boundary clip edge; keeps the other three + roof (#1083)', () => {
    // CCW square clipped at the EAST tile edge: v1,v2 sit exactly on mx=east.
    // Ring SW → SE(east) → NE(east) → NW → close. Edge SE→NE (index 1) is the
    // clip-synthetic seam; the other three edges are real building faces.
    const v0: [number, number] = [west + 2000, south + 2000] // SW interior
    const v1: [number, number] = [east, south + 2000] // SE on east boundary
    const v2: [number, number] = [east, north - 2000] // NE on east boundary
    const v3: [number, number] = [west + 2000, north - 2000] // NW interior
    const polygons: RingPolygon[] = [{ featId: 5, rings: [[v0, v1, v2, v3, v0]] }]

    // Control: NO extent → every edge extrudes (legacy behaviour).
    const control = generateWallMeshExtrudedECEF(polygons, heights, undefined, west, south, center)
    expect(control.vertices.length / STRIDE).toBe(20) // 4 walls·4 + 4 roof
    expect(control.indices.length).toBe(30) // 4·6 + 2·3
    expect(wallsOnEast(control)).toBe(1) // the seam wall exists pre-skip

    // Fixed: extent supplied → the SE→NE seam edge emits no wall.
    const fixed = generateWallMeshExtrudedECEF(
      polygons,
      heights,
      undefined,
      west,
      south,
      center,
      extent,
    )
    // FAIL-BEFORE: pre-fix ignores `extent` → 20 verts; post-fix → 16.
    expect(fixed.vertices.length / STRIDE).toBe(16) // 3 walls·4 + 4 roof
    expect(fixed.indices.length).toBe(24) // 3·6 + 2·3
    // The seam wall is gone; no surviving wall sits on the east boundary.
    expect(wallsOnEast(fixed)).toBe(0)

    // The first surviving wall (edge SW→SE, verts 0..3) is unchanged: its
    // quantization-independent f32 tail matches control byte-for-byte, and
    // its reconstructed ECEF matches within 1 mm (robust to any dequant-
    // range shift from the dropped verts).
    for (let v = 0; v < 4; v++) {
      for (let s = 3; s < STRIDE; s++)
        expect(fixed.vertices[v * STRIDE + s]).toBe(control.vertices[v * STRIDE + s])
      const pf = reconstructECEF(unpack(fixed, v), center)
      const pc = reconstructECEF(unpack(control, v), center)
      expect(Math.hypot(pf[0] - pc[0], pf[1] - pc[1], pf[2] - pc[2])).toBeLessThan(1e-3)
    }

    // Roof unchanged: the 4 footprint-corner verts (indices 12..15) remain,
    // all is_top = 1 → 2 triangles.
    for (let i = 12; i < 16; i++) expect(unpack(fixed, i).is_top).toBe(1)
  })

  it('keeps walls on interior axis-aligned edges that are NOT on the tile boundary', () => {
    // Square fully INSIDE the tile: every edge is vertical/horizontal but
    // offset ≥ 2 km from the rect, so none is a boundary seam. All 4 walls
    // must survive even with the extent supplied — the predicate keys on
    // boundary POSITION, not axis-alignment.
    const v0: [number, number] = [west + 2000, south + 2000]
    const v1: [number, number] = [east - 2000, south + 2000]
    const v2: [number, number] = [east - 2000, north - 2000]
    const v3: [number, number] = [west + 2000, north - 2000]
    const polygons: RingPolygon[] = [{ featId: 5, rings: [[v0, v1, v2, v3, v0]] }]
    const mesh = generateWallMeshExtrudedECEF(
      polygons,
      heights,
      undefined,
      west,
      south,
      center,
      extent,
    )
    expect(mesh.vertices.length / STRIDE).toBe(20) // all 4 walls + roof kept
    expect(mesh.indices.length).toBe(30)
  })
})
