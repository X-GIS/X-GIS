// iter-313 — CPU-side render-error finder. Feeds representative +
// pathological GeoJSON geometry through decomposeFeatures →
// compileSingleTile and asserts the OUTPUT-buffer invariants the
// GPU silently depends on:
//
//   1. Every vertex float is finite (NaN / Infinity poison the
//      whole tile mesh — rasteriser discards primitives touching
//      a NaN vertex → blank patches).
//   2. Every index is in-bounds (out-of-range index = GPU read
//      past the vertex buffer → garbage triangle or driver crash).
//   3. Index count is a multiple of 3 (triangles) / 2 (line segs).
//   4. A polygon with real area produces ≥ 1 triangle (silent
//      drop = missing fill, the water-polygon class).
//
// These are the rendering-error classes that fuzz on a single
// helper can't catch — they emerge from the full clip → simplify
// → tessellate → DSFUN-pack pipeline.

import { describe, it, expect } from 'vitest'
import {
  decomposeFeatures, compileSingleTile, tileKey, tileKeyUnpack,
} from './vector-tiler'
import type { GeoJSONFeature } from './geojson-types'

// Polygon vertex stride — PR 2c.2 swapped Mercator-DSFUN stride-5
// for ECEF-DSFUN stride-9 (`[ex_h, ey_h, ez_h, ex_l, ey_l, ez_l, fid,
// abs_lon, abs_lat]`). Line stride stays at 10 (Mercator-DSFUN with
// arc + tangent slots).
// Phase 2 PR 2f: polygon fill vertices are now the quantized ECEF layout —
// stride 24 bytes = 6 floats (uint16×6 position in the first 12 bytes + f32
// fid/abs_lon/abs_lat at float slots 3/4/5).
const QUANT_POLY_STRIDE_FLOATS = 6
const DSFUN_LINE_STRIDE = 10

const poly = (coords: number[][][]): GeoJSONFeature => ({
  type: 'Feature', properties: {},
  geometry: { type: 'Polygon', coordinates: coords },
})
const line = (coords: number[][]): GeoJSONFeature => ({
  type: 'Feature', properties: {},
  geometry: { type: 'LineString', coordinates: coords },
})

interface CompiledLike {
  vertices: Float32Array
  indices: Uint32Array
  lineVertices: Float32Array
  lineIndices: Uint32Array
}

function assertFinite(arr: Float32Array, label: string): void {
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i]!)) {
      throw new Error(`${label}[${i}] non-finite: ${arr[i]}`)
    }
  }
}

function assertRenderInvariants(t: CompiledLike, ctx: string): void {
  // Only the f32 tail (fid/abs_lon/abs_lat at float slots 3/4/5) is checked
  // for finiteness — the first 12 bytes per vertex are uint16 fixed-point
  // position that, reinterpreted as f32, are intentionally arbitrary.
  const vCount = t.vertices.length / QUANT_POLY_STRIDE_FLOATS
  for (let v = 0; v < vCount; v++) {
    for (let s = 3; s < 6; s++) {
      const val = t.vertices[v * QUANT_POLY_STRIDE_FLOATS + s]!
      if (!Number.isFinite(val)) {
        throw new Error(`${ctx} vertices[${v}].f32[${s}] non-finite: ${val}`)
      }
    }
  }
  assertFinite(t.lineVertices, `${ctx} lineVertices`)
  // Index in-bounds + triangle/segment grouping.
  expect(t.indices.length % 3, `${ctx} poly index count multiple of 3`).toBe(0)
  for (let i = 0; i < t.indices.length; i++) {
    const idx = t.indices[i]!
    if (idx >= vCount) throw new Error(`${ctx} poly index ${idx} >= vertexCount ${vCount}`)
  }
  const lvCount = t.lineVertices.length / DSFUN_LINE_STRIDE
  expect(t.lineIndices.length % 2, `${ctx} line index count multiple of 2`).toBe(0)
  for (let i = 0; i < t.lineIndices.length; i++) {
    const idx = t.lineIndices[i]!
    if (idx >= lvCount) throw new Error(`${ctx} line index ${idx} >= lineVertexCount ${lvCount}`)
  }
}

// Compile a feature against the tile that contains its centroid.
function compileAt(feature: GeoJSONFeature, z: number, x: number, y: number) {
  const parts = decomposeFeatures([feature])
  return compileSingleTile(parts, z, x, y, 14)
}

describe('iter-313 compileSingleTile render-buffer invariants', () => {
  it('z=0 full-world rectangle — finite + in-bounds + non-empty', () => {
    const world = poly([[[-179, -85], [179, -85], [179, 85], [-179, 85], [-179, -85]]])
    const t = compileAt(world, 0, 0, 0)
    expect(t).not.toBe(null)
    assertRenderInvariants(t!, 'world-z0')
    expect(t!.indices.length).toBeGreaterThan(0)  // has fill
  })

  it('antimeridian-spanning polygon at z=0 does not produce NaN', () => {
    // Ring crosses ±180. The MM projection + clip must not emit NaN.
    const cross = poly([[[170, -10], [-170, -10], [-170, 10], [170, 10], [170, -10]]])
    const t = compileAt(cross, 0, 0, 0)
    if (t) assertRenderInvariants(t, 'antimeridian-z0')
  })

  it('polygon with a hole — outer + hole both finite, fill present', () => {
    const withHole = poly([
      [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],          // outer
      [[3, 3], [3, 7], [7, 7], [7, 3], [3, 3]],              // hole (CW)
    ])
    // z=5 tile near (lon 5, lat 5).
    const z = 5
    const n = 1 << z
    const x = Math.floor((5 + 180) / 360 * n)
    const ylat = 5 * Math.PI / 180
    const yf = (1 - Math.log(Math.tan(ylat) + 1 / Math.cos(ylat)) / Math.PI) / 2
    const y = Math.floor(yf * n)
    const t = compileAt(withHole, z, x, y)
    if (t) {
      assertRenderInvariants(t, 'hole-z5')
      expect(t.indices.length).toBeGreaterThan(0)
    }
  })

  it('near-degenerate sliver polygon (1e-7° wide) does not crash or NaN', () => {
    const sliver = poly([[[0, 0], [1e-7, 0], [1e-7, 10], [0, 10], [0, 0]]])
    const t = compileAt(sliver, 0, 0, 0)
    if (t) assertRenderInvariants(t, 'sliver-z0')
  })

  it('self-intersecting bowtie polygon — finite output (no NaN from earcut)', () => {
    const bowtie = poly([[[0, 0], [10, 10], [10, 0], [0, 10], [0, 0]]])
    const t = compileAt(bowtie, 0, 0, 0)
    if (t) assertRenderInvariants(t, 'bowtie-z0')
  })

  it('polygon at extreme north (lat 84.9, near Mercator limit) finite', () => {
    const arctic = poly([[[0, 84], [5, 84], [5, 84.9], [0, 84.9], [0, 0]]])
    const t = compileAt(arctic, 2, 2, 0)
    if (t) assertRenderInvariants(t, 'arctic-z2')
  })

  it('line crossing tile boundary — finite line vertices + in-bounds seg indices', () => {
    const l = line([[-10, 0], [10, 0]])
    const t = compileAt(l, 0, 0, 0)
    if (t) assertRenderInvariants(t, 'line-z0')
  })

  it('zero-length line segment (identical points) no NaN', () => {
    const l = line([[5, 5], [5, 5]])
    const t = compileAt(l, 0, 0, 0)
    if (t) assertRenderInvariants(t, 'zero-line-z0')
  })

  it('collinear line (3 points on a line) finite', () => {
    const l = line([[0, 0], [5, 5], [10, 10]])
    const t = compileAt(l, 0, 0, 0)
    if (t) assertRenderInvariants(t, 'collinear-line-z0')
  })

  it('many-vertex circle polygon (1000 pts) finite + bounded indices', () => {
    const ring: number[][] = []
    for (let i = 0; i <= 1000; i++) {
      const a = (i / 1000) * 2 * Math.PI
      ring.push([Math.cos(a) * 5, Math.sin(a) * 5])
    }
    const t = compileAt(poly([ring]), 0, 0, 0)
    if (t) {
      assertRenderInvariants(t, 'circle-z0')
      expect(t.indices.length).toBeGreaterThan(0)
    }
  })

  it('polygon fully outside tile → null or empty (no spurious geometry)', () => {
    // Polygon near lon 100, compiled against tile at lon -100.
    const far = poly([[[100, 50], [101, 50], [101, 51], [100, 51], [100, 50]]])
    const z = 3, n = 1 << z
    const x = Math.floor((-100 + 180) / 360 * n)
    const t = compileAt(far, z, x, 2)
    // Either null (rejected) or empty fill — never NaN, never
    // out-of-bounds.
    if (t) assertRenderInvariants(t, 'far-z3')
  })

  it('multiple deep tiles (z=14) over a city-scale polygon stay finite', () => {
    // Seoul-ish small polygon at z=14.
    const block = poly([[
      [126.977, 37.566], [126.978, 37.566],
      [126.978, 37.567], [126.977, 37.567], [126.977, 37.566],
    ]])
    const z = 14, n = 1 << z
    const x = Math.floor((126.9775 + 180) / 360 * n)
    const latR = 37.5665 * Math.PI / 180
    const yf = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2
    const y = Math.floor(yf * n)
    const t = compileAt(block, z, x, y)
    if (t) assertRenderInvariants(t, 'seoul-z14')
  })

  it('tileKey/tileKeyUnpack used in the harness are consistent (sanity)', () => {
    const k = tileKey(14, 100, 200)
    expect(tileKeyUnpack(k)).toEqual([14, 100, 200])
  })
})
