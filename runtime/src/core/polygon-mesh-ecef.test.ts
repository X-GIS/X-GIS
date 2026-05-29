// Unit tests for `generateWallMeshExtrudedECEF` — the Phase 2 PR 2c.2
// stride-14 ECEF-RTC wall + roof mesh generator.
//
// Coverage:
//   1. Single quad footprint at (lon=0, lat=0), height=100m — vertex
//      count, is_top discriminator, face_normal unit-magnitude.
//   2. Random footprint at lat=45° — roof ECEF magnitude matches
//      lonLatToECEFSphere(_, _, 100) within 1 mm.
//   3. Roof face_normal points outward (dot with vertex ECEF > 0.9).
//   4. Wall face_normal is horizontal (|fn · Up| < 0.1).

import { describe, expect, it } from 'vitest'
import type { RingPolygon } from '@xgis/compiler'
import { generateWallMeshExtrudedECEF } from './polygon-mesh'
import { lonLatToECEFSphere, tileEcefCenterFromMerc } from '../engine/projection/ecef'

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
  const my = Math.log(Math.tan(Math.PI / 4 + lat * DEG2RAD / 2)) * A
  return [mx, my]
}

interface UnpackedVertex {
  /** Dequanted ECEF RTC residual (metres), reconstructed via the GPU's math. */
  rx: number; ry: number; rz: number
  fid: number
  abs_lon: number; abs_lat: number
  fn_x: number; fn_y: number; fn_z: number
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
    (u16[lane + axis * 2]! * 65536 + u16[lane + axis * 2 + 1]!) * mesh.dequantScale - mesh.dequantHalf
  return {
    rx: deq(0), ry: deq(1), rz: deq(2),
    fid: v[o + 3]!,
    abs_lon: v[o + 4]!, abs_lat: v[o + 5]!,
    fn_x: v[o + 6]!, fn_y: v[o + 7]!, fn_z: v[o + 8]!,
    wall_height: v[o + 9]!,
    is_top: v[o + 10]!,
  }
}

function reconstructECEF(v: UnpackedVertex, center: readonly [number, number, number]): [number, number, number] {
  return [center[0] + v.rx, center[1] + v.ry, center[2] + v.rz]
}

describe('generateWallMeshExtrudedECEF', () => {
  it('emits stride-44-byte quantized verts with correct is_top discriminator for a single quad at the equator', () => {
    // 1° × 1° quad straddling (0, 0). CCW outer ring (positive area in
    // mx/my). 4 unique verts; ring is CLOSED (last == first).
    const p0 = lonLatToMerc(-0.5, -0.5)
    const p1 = lonLatToMerc( 0.5, -0.5)
    const p2 = lonLatToMerc( 0.5,  0.5)
    const p3 = lonLatToMerc(-0.5,  0.5)
    const polygons: RingPolygon[] = [{
      featId: 42,
      rings: [[p0, p1, p2, p3, p0]],  // CCW
    }]
    const heights = new Map<number, number>([[42, 100]])
    // Use the polygon centroid (approximately (0, 0)) as the tile
    // origin so synthetic-edge detection doesn't fire on the test
    // (extents differ from the bbox).
    const tileMx = 0  // far western world edge
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
    let wallBottom = 0, wallTop = 0
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

  it('roof ECEF magnitude matches lonLatToECEFSphere within 1 mm at lat=45°', () => {
    // 0.01° × 0.01° quad around (lon=10, lat=45), height 50m.
    const cx = 10, cy = 45
    const d = 0.005
    const corners = [
      lonLatToMerc(cx - d, cy - d),
      lonLatToMerc(cx + d, cy - d),
      lonLatToMerc(cx + d, cy + d),
      lonLatToMerc(cx - d, cy + d),
    ]
    const polygons: RingPolygon[] = [{
      featId: 7,
      rings: [[corners[0], corners[1], corners[2], corners[3], corners[0]]],
    }]
    const heights = new Map<number, number>([[7, 50]])
    // Tile origin far from bbox so synthetic-edge detection is inert.
    const tileMx = 0
    const tileMy = 0
    const center = tileEcefCenterFromMerc(corners[0][0], corners[0][1])

    const mesh = generateWallMeshExtrudedECEF(polygons, heights, undefined, tileMx, tileMy, center)

    // Reference ECEFs at corner lon/lat (NOT via the f32-quantized
    // abs_lon/abs_lat varyings — those are intentionally lossy for
    // GPU-side picking, not for sub-mm geometry reconstruction).
    const refCorners = [
      lonLatToECEFSphere(cx - d, cy - d, 50),
      lonLatToECEFSphere(cx + d, cy - d, 50),
      lonLatToECEFSphere(cx + d, cy + d, 50),
      lonLatToECEFSphere(cx - d, cy + d, 50),
    ]
    // Roof verts come after wall verts; wall vert count = 4 edges × 4
    // = 16, so verts 16..19 are roof, in input ring order.
    for (let i = 0; i < 4; i++) {
      const v = unpack(mesh, 16 + i)
      const [ex, ey, ez] = reconstructECEF(v, center)
      const [refX, refY, refZ] = refCorners[i]
      const dx = ex - refX, dy = ey - refY, dz = ez - refZ
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
    const cx = 120, cy = 30
    const d = 0.01
    const corners = [
      lonLatToMerc(cx - d, cy - d),
      lonLatToMerc(cx + d, cy - d),
      lonLatToMerc(cx + d, cy + d),
      lonLatToMerc(cx - d, cy + d),
    ]
    const polygons: RingPolygon[] = [{
      featId: 1,
      rings: [[corners[0], corners[1], corners[2], corners[3], corners[0]]],
    }]
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
    const cx = 120, cy = 30
    const d = 0.01
    const corners = [
      lonLatToMerc(cx - d, cy - d),
      lonLatToMerc(cx + d, cy - d),
      lonLatToMerc(cx + d, cy + d),
      lonLatToMerc(cx - d, cy + d),
    ]
    const polygons: RingPolygon[] = [{
      featId: 1,
      rings: [[corners[0], corners[1], corners[2], corners[3], corners[0]]],
    }]
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
      const upX = ex / pmag, upY = ey / pmag, upZ = ez / pmag
      const dot = Math.abs(v.fn_x * upX + v.fn_y * upY + v.fn_z * upZ)
      expect(dot).toBeLessThan(0.1)
    }
  })

  it('missing height entries default to 0 (no degenerate failure)', () => {
    const p0 = lonLatToMerc(-0.5, -0.5)
    const p1 = lonLatToMerc( 0.5, -0.5)
    const p2 = lonLatToMerc( 0.5,  0.5)
    const p3 = lonLatToMerc(-0.5,  0.5)
    const polygons: RingPolygon[] = [{
      featId: 99,
      rings: [[p0, p1, p2, p3, p0]],
    }]
    const heights = new Map<number, number>()  // empty
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
