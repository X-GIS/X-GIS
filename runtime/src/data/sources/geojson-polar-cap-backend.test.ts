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
import { tileKey } from '@xgis/compiler'

const MERC_LAT_CLAMP = 85.051129
const FILL_FLOATS_PER_VERT = 6
const FILL_LAT_FLOAT = 5

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
  it('emits a vertex with abs_lat≈90 carrying a finite, non-degenerate ECEF residual', () => {
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

    let poleVertex = -1
    for (let i = 0; i < count; i++) {
      const absLat = verts[i * FILL_FLOATS_PER_VERT + FILL_LAT_FLOAT]!
      if (Math.abs(absLat - 90) < 1e-3) { poleVertex = i; break }
    }
    expect(poleVertex).toBeGreaterThanOrEqual(0)

    // Decode the stride-6 quantized residual: q = hi*65536 + lo; residual =
    // q * dequantScale - dequantHalf. The pole vertex must decode to a finite,
    // non-zero residual (it does NOT sit exactly at the tile-corner anchor).
    const u = poleVertex * 12
    const axes = [0, 2, 4].map((lane) => {
      const q = u16[u + lane]! * 65536 + u16[u + lane + 1]!
      return q * res.dequantScale - res.dequantHalf
    })
    for (const a of axes) expect(Number.isFinite(a)).toBe(true)
    expect(axes.some((a) => Math.abs(a) > 1)).toBe(true)
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
    expect(show.paintShapes.fill).toEqual({ kind: 'constant', value: [0, 0, 1, 1] })
    expect(name).toBe('ocean__polar_cap')
  })

  it('updateGeoJSONPolarCapShowFill re-points the fill', () => {
    const show = buildGeoJSONPolarCapShow(capSourceName('land'), [0, 0, 1, 1])
    updateGeoJSONPolarCapShowFill(show, [0, 0.5, 0, 1])
    expect(show.resolvedFillRgba).toEqual([0, 0.5, 0, 1])
    expect(show.paintShapes.fill).toEqual({ kind: 'constant', value: [0, 0.5, 0, 1] })
  })
})
