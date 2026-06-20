// Issue #360 F1 — per-source polar-cap backend fail-before / unit coverage.
//
// CPU-verifiable invariants only. The actual pole-hole CLOSING is a GPU render
// behaviour (the polygon ECEF VS projecting the abs_lat=±90 rows to the pole)
// and is confirmed by the real-GPU gate, NOT here.

import { describe, it, expect } from 'vitest'
import {
  generatePolarCapMesh,
  detectCapPoles,
  capSourceName,
  GeoJSONPolarCapBackend,
} from './geojson-polar-cap-backend'
import {
  buildGeoJSONPolarCapShow,
  updateGeoJSONPolarCapShowFill,
} from '../../engine/geojson-polar-cap-show'
import type { GeoJSONFeatureCollection } from '../../loader/geojson'
import type { BackendTileResult, TileSourceSink } from '../tile-source'
import { lonLatToECEF, tileEcefCenterFromMerc } from '../../engine/projection/ecef'
import { tileKey } from '@xgis/compiler'

const MERC_LAT_CLAMP = 85.051129
const FILL_FLOATS_PER_VERT = 7   // #398: stride 28 B = 7 f32 (added true_lat)
const FILL_U16_PER_VERT = 14
const FILL_LAT_FLOAT = 5
const FILL_TRUELAT_FLOAT = 6
const A = 6378137
const DEG2RAD = Math.PI / 180
// The z=0 synthetic tile's ELLIPSOID corner anchor — the SAME value the cap
// backend packs about (lon=-180, decoded z0-south); the render-side `off`
// reconstructs it, so absolute ECEF = residual + anchor.
const Z0_DECODED_SOUTH = Math.atan(Math.sinh(-Math.PI)) * 180 / Math.PI
const Z0_TILE_MX = -180 * DEG2RAD * A
const Z0_TILE_MY = Math.log(Math.tan(Math.PI / 4 + Z0_DECODED_SOUTH * DEG2RAD / 2)) * A
const Z0_TILE_CENTER = tileEcefCenterFromMerc(Z0_TILE_MX, Z0_TILE_MY)

// Stride-2 lon/lat → row of latitudes present in the mesh.
function latsOf(verts: Float32Array): number[] {
  const out: number[] = []
  for (let i = 1; i < verts.length; i += 2) out.push(verts[i]!)
  return out
}

describe('generatePolarCapMesh', () => {
  it('north-only cap has rows at ≈90 and ≈85.05 and NONE below 85.05', () => {
    const { vertices, indices } = generatePolarCapMesh({ north: true, south: false })
    const lats = latsOf(vertices)
    expect(lats.some((l) => Math.abs(l - 90) < 1e-3)).toBe(true)
    expect(lats.some((l) => Math.abs(l - MERC_LAT_CLAMP) < 1e-3)).toBe(true)
    // North cap only — every latitude is on or above the clamp boundary.
    expect(lats.every((l) => l >= MERC_LAT_CLAMP - 1e-3)).toBe(true)
    expect(lats.some((l) => l < 0)).toBe(false)
    // A non-empty triangle set was emitted.
    expect(indices.length).toBeGreaterThan(0)
  })

  it('south-only cap mirrors to the South Pole and never crosses the equator', () => {
    const { vertices } = generatePolarCapMesh({ north: false, south: true })
    const lats = latsOf(vertices)
    expect(lats.some((l) => Math.abs(l + 90) < 1e-3)).toBe(true)
    expect(lats.some((l) => Math.abs(l + MERC_LAT_CLAMP) < 1e-3)).toBe(true)
    expect(lats.every((l) => l <= -MERC_LAT_CLAMP + 1e-3)).toBe(true)
  })

  it('both poles concatenate with offset indices that stay in range', () => {
    const both = generatePolarCapMesh({ north: true, south: true })
    const north = generatePolarCapMesh({ north: true, south: false })
    expect(both.vertices.length).toBe(north.vertices.length * 2)
    const maxIdx = both.indices.reduce((m, v) => Math.max(m, v), 0)
    expect(maxIdx).toBeLessThan(both.vertices.length / 2)
  })
})

describe('GeoJSONPolarCapBackend packed output', () => {
  it('a pole vertex reaches the TRUE north pole ECEF via the quantized lanes (NOT the f32 tail)', () => {
    // #360 F1 fix: the cap reaches ±90 through the QUANTIZED ECEF POSITION lanes.
    // The f32 tail now carries TILE-LOCAL MERCATOR (so `vs_main_ecef`'s abs_merc
    // reconstruction + the fragment hemisphere-cull stay valid) — writing DEGREES
    // there (the prior bug) made abs_merc garbage so the globe cull discarded the
    // whole cap. We therefore locate the pole by ECEF, not by a tail abs_lat=90.
    let captured: BackendTileResult | null = null
    const sink: TileSourceSink = {
      trackLoading() {},
      releaseLoading() {},
      hasTileData() { return false },
      getLoadingCount() { return 0 },
      acceptResult(_key, result) { captured = result },
    }
    const backend = new GeoJSONPolarCapBackend('ocean', { north: true, south: false }, [0, 0, 1, 1])
    backend.attach(sink)
    expect(captured).not.toBeNull()
    const res = captured as unknown as BackendTileResult
    const verts = res.vertices
    const u16 = new Uint16Array(verts.buffer)
    const count = verts.length / FILL_FLOATS_PER_VERT

    // Reconstruct each vertex's absolute ECEF (residual + tile anchor) and find
    // the one closest to the true north pole.
    const [npx, npy, npz] = lonLatToECEF(0, 90)
    let best = -1, bestErr = Infinity
    for (let i = 0; i < count; i++) {
      const u = i * FILL_U16_PER_VERT
      const ex = (u16[u]! * 65536 + u16[u + 1]!) * res.dequantScale - res.dequantHalf + Z0_TILE_CENTER[0]
      const ey = (u16[u + 2]! * 65536 + u16[u + 3]!) * res.dequantScale - res.dequantHalf + Z0_TILE_CENTER[1]
      const ez = (u16[u + 4]! * 65536 + u16[u + 5]!) * res.dequantScale - res.dequantHalf + Z0_TILE_CENTER[2]
      const err = Math.hypot(ex - npx, ey - npy, ez - npz)
      if (err < bestErr) { bestErr = err; best = i }
    }
    expect(best).toBeGreaterThanOrEqual(0)
    // The nearest cap vertex sits AT the true north pole (sub-metre after the
    // double-u16 dequant over a ~1.3e7 m range).
    expect(bestErr).toBeLessThan(1)
    // DISCRIMINATING fail-before: the f32 tail is TILE-LOCAL MERCATOR, NOT
    // degrees. Vertex 0 is the cap's SW corner (lon=-180, lat=85.05) → its
    // local Mercator X is 0 (the tile-west origin). The prior bug wrote the
    // raw longitude (-180°) here, so this assertion fails on the old pack.
    expect(verts[0 * FILL_FLOATS_PER_VERT + 4]!).toBeCloseTo(0, 2)   // local_merc X (was -180)
    // Its tail Mercator-Y reconstructs to the ±85.05 clamp boundary, never ±90
    // (the pole is carried by the ECEF lanes above, not the Mercator-capped tail).
    const absMy0 = verts[0 * FILL_FLOATS_PER_VERT + FILL_LAT_FLOAT]! + Z0_TILE_MY
    const tailLat0 = (2 * Math.atan(Math.exp(absMy0 / A)) - Math.PI / 2) / DEG2RAD
    expect(Math.abs(tailLat0)).toBeCloseTo(MERC_LAT_CLAMP, 2)
    // #398: the SW corner sits on the clamp boundary, so its UNCLAMPED true_lat
    // equals 85.05 here; the row that DOES reach the pole carries 90 in this
    // slot (the disc arm projects from true_lat, closing the annular hole).
    expect(verts[0 * FILL_FLOATS_PER_VERT + FILL_TRUELAT_FLOAT]!).toBeCloseTo(MERC_LAT_CLAMP, 2)
    // At least one cap row carries the true ±90 pole latitude in the slot.
    let sawPole = false
    for (let i = 0; i < count; i++) {
      if (Math.abs(verts[i * FILL_FLOATS_PER_VERT + FILL_TRUELAT_FLOAT]! - 90) < 1e-2) sawPole = true
    }
    expect(sawPole).toBe(true)
  })

  it('serves only the z=0 tile', () => {
    const backend = new GeoJSONPolarCapBackend('land', { north: false, south: true }, [0, 1, 0, 1])
    expect(backend.has(tileKey(0, 0, 0))).toBe(true)
    expect(backend.has(tileKey(1, 0, 0))).toBe(false)
  })
})

describe('detectCapPoles', () => {
  // A full-longitude ring sitting on the +85.0511 clamp (ocean / Arctic).
  function ringAt(lat: number): GeoJSONFeatureCollection {
    const coords: [number, number][] = []
    for (let lon = -180; lon <= 180; lon += 10) coords.push([lon, lat])
    coords.push(coords[0]!)
    return {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [coords] },
        properties: {},
      }],
    } as GeoJSONFeatureCollection
  }

  it('detects the north pole for an ocean-like ring at +85.0511', () => {
    expect(detectCapPoles(ringAt(85.0511))).toEqual({ north: true, south: false })
  })

  it('detects the south pole for an Antarctica-like ring at -85.0511', () => {
    expect(detectCapPoles(ringAt(-85.0511))).toEqual({ north: false, south: true })
  })

  it('detects neither pole for a mid-latitude ring', () => {
    expect(detectCapPoles(ringAt(40))).toEqual({ north: false, south: false })
  })
})

describe('cap show builder', () => {
  it('carries resolvedFillRgba and a matching targetName', () => {
    const name = capSourceName('ocean')
    const show = buildGeoJSONPolarCapShow(name, [0, 0, 1, 1])
    expect(show.targetName).toBe(name)
    expect(show.resolvedFillRgba).toEqual([0, 0, 1, 1])
    expect(show.paintShapes.fill.fill).toEqual({ kind: 'constant', value: [0, 0, 1, 1] })
    expect(name).toBe('ocean__polar_cap')
  })

  it('updateGeoJSONPolarCapShowFill re-points the fill', () => {
    const show = buildGeoJSONPolarCapShow(capSourceName('land'), [0, 0, 1, 1])
    updateGeoJSONPolarCapShowFill(show, [0, 0.5, 0, 1])
    expect(show.resolvedFillRgba).toEqual([0, 0.5, 0, 1])
    expect(show.paintShapes.fill.fill).toEqual({ kind: 'constant', value: [0, 0.5, 0, 1] })
  })
})
