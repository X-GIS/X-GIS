// Phase 2 PR 2c.3 — US-001 — SyntheticEarthSurfaceBackend unit tests.
//
// Covers AC2c.3.1 surface shape:
//   - meta exposes web-mercator-xyz scheme + TILE_LAYOUT_VERSION + z=0 only.
//   - loadTile pushes exactly one BackendTileResult with 8385 verts × stride-6
//     and 49152 indices (128x64 grid — F1 rim-smoothing density).
//   - Corner verts reconstruct the per-projType band (sphere ±90°, mercator
//     ±85°) via abs_lon/abs_lat.
//   - DSFUN hi+lo reconstructs ECEF metres at sphere magnitudes.

import { describe, it, expect } from 'vitest'
import { tileKey } from '@xgis/compiler'
import { SyntheticEarthSurfaceBackend } from './synthetic-earth-surface-backend'
import { lonLatToECEF, tileEcefCenterFromMerc } from '../../engine/projection/ecef'
import {
  TILE_LAYOUT_VERSION,
  type BackendTileResult,
  type TileSourceSink,
} from '../tile-source'

// WGS84 semi-major axis — matches the tiler + the render-side `off`.
const A = 6378137
const DEG2RAD = Math.PI / 180
// #398: polygon fill stride 28 B = 7 f32 = 14 u16 per vertex.
const FILL_FLOATS_PER_VERT = 7
const FILL_U16_PER_VERT = 14
// Source-honest Web-Mercator latitude clamp applied to the PER-VERTEX abs_lat
// encode (the rounded ±85 cap real polar ground verts also carry). The bg
// consolidates onto the tiler kernel, so the same clamp governs its abs_lat.
const MERC_LAT_CLAMP = 85.051129
// The DECODED z=0 tile-south latitude — the EXACT value the tile catalog
// reconstructs (tile-catalog.ts:1102, atan(sinh(±π))·180/π) and the value the
// render-side `off` anchor feeds through clampLat (vector-tile-renderer.ts:5041).
// It sits just INSIDE the rounded ±85.051129 clamp, so clampLat returns it
// unchanged. The bg tile-corner ANCHOR must be reconstructed from THIS decoded
// latitude (NOT the rounded MERC_LAT_CLAMP) — building Z0_TILE_CENTER from the
// rounded value would make the anchor cross-path pin a tautology that passes
// even when the bg anchor and the render `off` differ by ~2.46 cm.
const Z0_DECODED_SOUTH = Math.atan(Math.sinh(-Math.PI)) * 180 / Math.PI
// The z=0 synthetic tile's ELLIPSOID corner anchor — the SAME value the
// render-side per-tile pack reconstructs into cam_ecef_off. The bg pack and the
// render `off` MUST agree here, else the RTC origins fail to cancel in 3D.
const Z0_TILE_MX = -180 * DEG2RAD * A
const Z0_TILE_MY = Math.log(Math.tan(Math.PI / 4 + Z0_DECODED_SOUTH * DEG2RAD / 2)) * A
const Z0_TILE_CENTER = tileEcefCenterFromMerc(Z0_TILE_MX, Z0_TILE_MY)

function makeRecordingSink(): {
  sink: TileSourceSink
  pushed: { key: number; result: BackendTileResult | null }[]
} {
  const pushed: { key: number; result: BackendTileResult | null }[] = []
  const sink: TileSourceSink = {
    trackLoading: () => {},
    releaseLoading: () => {},
    hasTileData: () => false,
    getLoadingCount: () => 0,
    acceptResult: (key, result) => { pushed.push({ key, result }) },
  }
  return { sink, pushed }
}

describe('SyntheticEarthSurfaceBackend — meta shape', () => {
  it('reports web-mercator-xyz scheme, current TILE_LAYOUT_VERSION, single z=0 tile', () => {
    const backend = new SyntheticEarthSurfaceBackend()
    expect(backend.meta.scheme).toBe('web-mercator-xyz')
    expect(backend.meta.layoutVersion).toBe(TILE_LAYOUT_VERSION)
    expect(backend.meta.minZoom).toBe(0)
    expect(backend.meta.maxZoom).toBe(0)
    expect(backend.meta.bounds).toEqual([-180, -85, 180, 85])
  })

  it('has(key) returns true only for tileKey(0,0,0)', () => {
    const backend = new SyntheticEarthSurfaceBackend()
    expect(backend.has(tileKey(0, 0, 0))).toBe(true)
    expect(backend.has(tileKey(1, 0, 0))).toBe(false)
    expect(backend.has(tileKey(2, 1, 1))).toBe(false)
  })
})

describe('SyntheticEarthSurfaceBackend — attach + loadTile', () => {
  it('attach pushes the z=0 tile result synchronously', () => {
    const backend = new SyntheticEarthSurfaceBackend()
    const { sink, pushed } = makeRecordingSink()
    backend.attach(sink)
    expect(pushed.length).toBe(1)
    expect(pushed[0].key).toBe(tileKey(0, 0, 0))
    expect(pushed[0].result).not.toBeNull()
  })

  it('emits 8385 verts × stride-7 (#398 quantized + true_lat) + 49152 indices from 128x64 grid', () => {
    const backend = new SyntheticEarthSurfaceBackend()
    const { sink, pushed } = makeRecordingSink()
    backend.attach(sink)
    const result = pushed[0].result!
    expect(result.vertices.length).toBe(129 * 65 * 7)   // (128+1)*(64+1) verts
    expect(result.indices.length).toBe(128 * 64 * 6)    // 49152
    expect(result.lineVertices.length).toBe(0)
    expect(result.lineIndices.length).toBe(0)
    // Quantized buffer must carry its dequant companion params.
    expect(result.dequantScale).toBeGreaterThan(0)
    expect(result.dequantHalf).toBeGreaterThan(0)
  })

  it('loadTile(z=0 key) re-pushes the cached result object without rebuilding', () => {
    const backend = new SyntheticEarthSurfaceBackend()
    const { sink, pushed } = makeRecordingSink()
    backend.attach(sink)
    backend.loadTile(tileKey(0, 0, 0))
    expect(pushed.length).toBe(2)
    expect(pushed[1].result).toBe(pushed[0].result)
  })

  it('loadTile ignores non-z0 keys', () => {
    const backend = new SyntheticEarthSurfaceBackend()
    const { sink, pushed } = makeRecordingSink()
    backend.attach(sink)
    backend.loadTile(tileKey(1, 0, 0))
    expect(pushed.length).toBe(1)
  })
})

describe('SyntheticEarthSurfaceBackend — vertex content', () => {
  // PR 2f: position is quantized u16×6 in the first 12 bytes (floats 0..2);
  // f32 tail is fid(3), abs_lon(4), abs_lat(5). Dequant a position axis from
  // the u16 lanes: q = hi*65536 + lo; axis = q*scale - half.
  const dequantAxis = (u16: Uint16Array, lane: number, scale: number, half: number): number => {
    const q = u16[lane] * 65536 + u16[lane + 1]
    return q * scale - half
  }

  it('first vertex (lon=-180, lat=-90) reaches the south pole via the QUANTIZED ECEF lanes; f32 tail is tile-local Mercator', () => {
    // F2 polar-cap dual-encode: the sphere band's polar rows (|lat| > 85.05°)
    // forward the TRUE latitude to the WGS84 ellipsoid, so the disc/sphere
    // silhouette reaches the geographic pole (no ±85 cap hole). The pole is
    // reached via the QUANTIZED ECEF POSITION lanes — NOT the f32 tail, which
    // (post #392 / #360 F1 fix) carries TILE-LOCAL MERCATOR so `vs_main_ecef`'s
    // abs_merc reconstruction + fragment hemisphere-cull stay valid. Writing
    // DEGREES into the tail (the prior bug) made abs_merc garbage → the globe
    // cull discarded every polar-cap fragment (the #360 black hole).
    const backend = new SyntheticEarthSurfaceBackend(7)
    const { sink, pushed } = makeRecordingSink()
    backend.attach(sink)
    const result = pushed[0].result!
    const v = result.vertices
    const u16 = new Uint16Array(v.buffer)
    const { dequantScale: scale, dequantHalf: half } = result
    // The QUANTIZED position reconstructs the TRUE south pole (the cap reaches ±90).
    const ex = dequantAxis(u16, 0, scale, half) + Z0_TILE_CENTER[0]
    const ey = dequantAxis(u16, 2, scale, half) + Z0_TILE_CENTER[1]
    const ez = dequantAxis(u16, 4, scale, half) + Z0_TILE_CENTER[2]
    const [px, py, pz] = lonLatToECEF(-180, -90)
    expect(ex).toBeCloseTo(px, 1)
    expect(ey).toBeCloseTo(py, 1)
    expect(ez).toBeCloseTo(pz, 1)
    // f32 tail = tile-local Mercator. lon=-180 is the tile-west origin → local X = 0.
    expect(v[4]).toBeCloseTo(0, 2)   // local_merc X
  })

  it('last vertex (lon=+180, lat=+90) reaches the north pole via the QUANTIZED ECEF lanes; f32 tail is tile-local Mercator', () => {
    const backend = new SyntheticEarthSurfaceBackend(7)
    const { sink, pushed } = makeRecordingSink()
    backend.attach(sink)
    const result = pushed[0].result!
    const v = result.vertices
    const u16 = new Uint16Array(v.buffer)
    const { dequantScale: scale, dequantHalf: half } = result
    const last = 129 * 65 - 1
    const lane = last * FILL_U16_PER_VERT
    const ex = dequantAxis(u16, lane, scale, half) + Z0_TILE_CENTER[0]
    const ey = dequantAxis(u16, lane + 2, scale, half) + Z0_TILE_CENTER[1]
    const ez = dequantAxis(u16, lane + 4, scale, half) + Z0_TILE_CENTER[2]
    const [px, py, pz] = lonLatToECEF(180, 90)
    expect(ex).toBeCloseTo(px, 1)
    expect(ey).toBeCloseTo(py, 1)
    expect(ez).toBeCloseTo(pz, 1)
    // f32 tail = tile-local Mercator. lon=+180 → local X = (180+180)·deg2rad·A
    // (~4e7 m; f32 ulp ≈ 4 m there, so compare within a few metres).
    expect(Math.abs(v[last * FILL_FLOATS_PER_VERT + 4]! - 360 * DEG2RAD * A)).toBeLessThan(5)   // local_merc X
  })

  it('quantized position at the mid vertex reconstructs the tiler ELLIPSOID ECEF (A,0,0)', () => {
    const backend = new SyntheticEarthSurfaceBackend()
    const { sink, pushed } = makeRecordingSink()
    backend.attach(sink)
    const result = pushed[0].result!
    const v = result.vertices
    const u16 = new Uint16Array(v.buffer)
    // Sample the mid-row, mid-col vertex — lon=0, lat=0 → ECEF (A, 0, 0).
    // Mid row index = 32 (heightSegments/2), mid col index = 64 (widthSegments/2).
    const cols = 129
    const idx = 32 * cols + 64
    const lane = idx * FILL_U16_PER_VERT   // u16 lane base (14 lanes / vertex)
    const { dequantScale: scale, dequantHalf: half } = result
    // Dequant is the RTC residual about the z=0 tileEcefCenter (ELLIPSOID),
    // so the absolute ECEF = residual + tileEcefCenter.
    const ex = dequantAxis(u16, lane, scale, half) + Z0_TILE_CENTER[0]
    const ey = dequantAxis(u16, lane + 2, scale, half) + Z0_TILE_CENTER[1]
    const ez = dequantAxis(u16, lane + 4, scale, half) + Z0_TILE_CENTER[2]
    // At lon=0, lat=0 the WGS84 ellipsoid forward = (A, 0, 0) (equator).
    // double-u16 over a ~1.3e7 m range → ~3 mm step; 0.01 m tolerance.
    const [refX, refY, refZ] = lonLatToECEF(0, 0)
    expect(ex).toBeCloseTo(refX, 1)
    expect(ey).toBeCloseTo(refY, 1)
    expect(ez).toBeCloseTo(refZ, 1)
    expect(refX).toBeCloseTo(A, 1)  // sanity: equator radius == semi-major axis
    // The f32 tail now holds TILE-LOCAL Mercator (local_merc = mx − tileOrigin);
    // reconstruct lon/lat (origin + local → inverse Mercator). Mid vertex = (0,0).
    const absMx = v[idx * FILL_FLOATS_PER_VERT + 4]! + Z0_TILE_MX
    const absMy = v[idx * FILL_FLOATS_PER_VERT + 5]! + Z0_TILE_MY
    expect(absMx / (DEG2RAD * A)).toBeCloseTo(0, 4)               // lon ≈ 0
    expect((2 * Math.atan(Math.exp(absMy / A)) - Math.PI / 2) / DEG2RAD).toBeCloseTo(0, 4) // lat ≈ 0
  })

  it('bg vertex ECEF == tiler ELLIPSOID ECEF across a lat/lon spread (basis unified, caps at ±90)', () => {
    // For each sampled grid vertex, reconstruct absolute ECEF = residual +
    // tileEcefCenter and assert it equals lonLatToECEF(lon, encLat(lat)) — the
    // SAME WGS84 ellipsoid forward the tiler runs for ground polygons — to ≤1mm.
    // This is the direct 'bg ECEF == tiler ellipsoid ECEF' unification check.
    // Sphere band (projType 7): the |lat|≤85.05 rows still match the kernel's
    // Merc-clamped ellipsoid ECEF (geoid-unification preserved), while the polar
    // (±90) rows match lonLatToECEF(lon, ±90) DIRECTLY — the F2 source-honest
    // caps that fill the polar holes.
    const backend = new SyntheticEarthSurfaceBackend(7)
    const { sink, pushed } = makeRecordingSink()
    backend.attach(sink)
    const result = pushed[0].result!
    const v = result.vertices
    const u16 = new Uint16Array(v.buffer)
    const { dequantScale: scale, dequantHalf: half } = result
    const vertexCount = v.length / FILL_FLOATS_PER_VERT
    // Derive the PRECISE (f64) grid lon/lat from the index — NOT the lossy f32
    // abs_lon/abs_lat varyings — and apply the SAME encode rule: polar rows keep
    // the true latitude (±90), the rest are Merc-clamped (matches packECEFWithPolarCaps).
    const cols = 129
    const gridLon = (i: number): number => -180 + (360 * (i % cols)) / 128
    const gridLat = (i: number): number => {
      const lat = -90 + (180 * Math.floor(i / cols)) / 64
      return Math.abs(lat) > MERC_LAT_CLAMP
        ? lat
        : Math.max(-MERC_LAT_CLAMP, Math.min(MERC_LAT_CLAMP, lat))
    }
    // Sample a spread: south pole row, mid, an off-meridian high-lat vertex,
    // and the north pole row.
    const samples = [
      0,                    // (lon=-180, lat=-90) → TRUE -90 (polar cap)
      32 * cols + 64,       // (lon=0,    lat=0)
      62 * cols + 80,       // off-meridian high northern lat (84.375° ≤ cap)
      vertexCount - 1,      // (lon=+180, lat=+90) → TRUE +90 (polar cap)
    ]
    // Tolerance = the double-u16 quant resolution. The bg spans the whole globe
    // about a single tile-corner anchor → per-axis step = dequantScale ≈ 6 mm;
    // 4*dequantScale is a safe ceiling that still proves the BASIS is the
    // ellipsoid (sphere would miss by ~21 km at the pole), NOT lonLatToECEFSphere.
    const tol = 4 * scale
    for (const idx of samples) {
      const lane = idx * FILL_U16_PER_VERT
      const ex = dequantAxis(u16, lane, scale, half) + Z0_TILE_CENTER[0]
      const ey = dequantAxis(u16, lane + 2, scale, half) + Z0_TILE_CENTER[1]
      const ez = dequantAxis(u16, lane + 4, scale, half) + Z0_TILE_CENTER[2]
      const [refX, refY, refZ] = lonLatToECEF(gridLon(idx), gridLat(idx))
      const err = Math.hypot(ex - refX, ey - refY, ez - refZ)
      expect(err).toBeLessThan(tol)
    }
    expect(tol).toBeLessThan(1)  // < 1 m — orders below the 21 km basis error
  })

  it('bg pack anchor == render-side tileEcefCenter (z=0 corner, DECODED south) so RTC origins cancel', () => {
    // The bg residuals are about the z=0 synthetic tile corner. Reconstruct the
    // implied anchor from a known vertex: anchor = absECEF(vertex) − residual.
    // absECEF for the lon=0/lat=0 mid vertex is lonLatToECEF(0,0). The anchor we
    // recover MUST equal tileEcefCenterFromMerc(tileWest=-180, clampLat(tileSouth))
    // — the exact value vector-tile-renderer.ts:5032-5054 recomputes for `off`.
    // Z0_TILE_CENTER is built from the DECODED z=0 tile-south (Z0_DECODED_SOUTH),
    // NOT the rounded MERC_LAT_CLAMP, so this is a real cross-path pin: it FAILS
    // if the bg anchors on the rounded constant (~2.46 cm off the render `off`).
    const backend = new SyntheticEarthSurfaceBackend()
    const { sink, pushed } = makeRecordingSink()
    backend.attach(sink)
    const result = pushed[0].result!
    const v = result.vertices
    const u16 = new Uint16Array(v.buffer)
    const { dequantScale: scale, dequantHalf: half } = result
    const cols = 129
    const idx = 32 * cols + 64         // lon=0, lat=0
    const lane = idx * FILL_U16_PER_VERT
    const [absX, absY, absZ] = lonLatToECEF(0, 0)
    const anchorX = absX - dequantAxis(u16, lane, scale, half)
    const anchorY = absY - dequantAxis(u16, lane + 2, scale, half)
    const anchorZ = absZ - dequantAxis(u16, lane + 4, scale, half)
    // Tolerance = 2 * dequantScale (~12 mm) — comfortably above the double-u16
    // residual round-trip noise (~6 mm step at the globe span) yet WELL below the
    // ~24.5 mm X-axis gap between the DECODED and rounded-clamp anchors. A fixed
    // 0.05 m (toBeCloseTo(...,1)) would silently pass the rounded-constant bug;
    // this scale-tied bound makes the pin discriminating: it FAILS if the bg
    // anchored on the rounded MERC_LAT_CLAMP instead of the decoded tile-south.
    const anchorTol = 2 * scale
    expect(Math.abs(anchorX - Z0_TILE_CENTER[0])).toBeLessThan(anchorTol)
    expect(Math.abs(anchorY - Z0_TILE_CENTER[1])).toBeLessThan(anchorTol)
    expect(Math.abs(anchorZ - Z0_TILE_CENTER[2])).toBeLessThan(anchorTol)
  })

  it('feat_id is 0 for every vertex (single synthetic feature)', () => {
    const backend = new SyntheticEarthSurfaceBackend()
    const { sink, pushed } = makeRecordingSink()
    backend.attach(sink)
    const v = pushed[0].result!.vertices
    for (let i = 0; i < 129 * 65; i++) {
      expect(v[i * FILL_FLOATS_PER_VERT + 3]).toBe(0)
    }
  })
})

describe('SyntheticEarthSurfaceBackend — fill color', () => {
  it('updateFillColor stores the rgba quad for downstream consumers', () => {
    const backend = new SyntheticEarthSurfaceBackend()
    backend.updateFillColor([0.1, 0.2, 0.3, 0.4])
    expect(Array.from(backend.getFillColor())).toEqual([0.1, 0.2, 0.3, 0.4])
  })

  it('defaults to transparent (alpha=0) before updateFillColor is called', () => {
    const backend = new SyntheticEarthSurfaceBackend()
    expect(backend.getFillColor()[3]).toBe(0)
  })
})
