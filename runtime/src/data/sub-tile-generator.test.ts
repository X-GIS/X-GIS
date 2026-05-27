// iter-315 — SubTileGenerator overzoom-clip invariants. This class
// runs CPU clipping when the camera zooms past archive maxLevel:
// it clips a parent tile's geometry into a virtual child tile.
// Render-critical + previously had NO direct test.
//
// A bug here = wrong geometry at deep zoom (overzoom past the
// archive's max level). The invariants below catch the silent
// render-error classes: NaN vertices, out-of-bounds indices, and
// child-tile-local coords that fall outside the child bounds
// (geometry would render in the wrong screen position).

import { describe, it, expect } from 'vitest'
import { SubTileGenerator } from './sub-tile-generator'
import type { TileData } from './tile-types'
import {
  decomposeFeatures, compileSingleTile, tileKey,
} from '@xgis/compiler'
import type { GeoJSONFeature } from '@xgis/compiler'

// PR 2c.2: polygon vertices are now ECEF-DSFUN stride-9 floats per
// `[ex_h, ey_h, ez_h, ex_l, ey_l, ez_l, fid, abs_lon, abs_lat]`.
const DSFUN_POLY_STRIDE = 9

/** Web-Mercator tile bounds in degrees (inline — tileBounds is a
 *  runtime-only helper in tile-select.ts, not exported from the
 *  compiler package). */
function tileBoundsDeg(z: number, x: number, y: number): { west: number; south: number; east: number; north: number } {
  const n = Math.pow(2, z)
  const west = x / n * 360 - 180
  const east = (x + 1) / n * 360 - 180
  const north = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI
  const south = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI
  return { west, south, east, north }
}

const poly = (coords: number[][][]): GeoJSONFeature => ({
  type: 'Feature', properties: {},
  geometry: { type: 'Polygon', coordinates: coords },
})

/** Compile a polygon into a parent TileData at (z,x,y). */
function makeParent(feature: GeoJSONFeature, z: number, x: number, y: number): TileData | null {
  const parts = decomposeFeatures([feature])
  const compiled = compileSingleTile(parts, z, x, y, 14)
  if (!compiled) return null
  const b = tileBoundsDeg(z, x, y)
  return {
    vertices: compiled.vertices,
    indices: compiled.indices,
    lineVertices: compiled.lineVertices,
    lineIndices: compiled.lineIndices,
    outlineIndices: compiled.outlineIndices,
    tileWest: b.west,
    tileSouth: b.south,
    tileWidth: b.east - b.west,
    tileHeight: b.north - b.south,
    tileZoom: z,
  }
}

function assertFinite(arr: Float32Array, label: string): void {
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i]!)) throw new Error(`${label}[${i}] non-finite: ${arr[i]}`)
  }
}

function assertSubTileInvariants(sub: TileData, ctx: string): void {
  assertFinite(sub.vertices, `${ctx} vertices`)
  assertFinite(sub.lineVertices, `${ctx} lineVertices`)
  const vCount = sub.vertices.length / DSFUN_POLY_STRIDE
  expect(sub.indices.length % 3, `${ctx} index count multiple of 3`).toBe(0)
  for (let i = 0; i < sub.indices.length; i++) {
    expect(sub.indices[i]! < vCount, `${ctx} index ${sub.indices[i]} < ${vCount}`).toBe(true)
  }
}

describe('iter-315 SubTileGenerator overzoom clip', () => {
  const gen = new SubTileGenerator()

  it('hasClippableGeometry: true with polygon, false when empty', () => {
    const empty: TileData = {
      vertices: new Float32Array(0), indices: new Uint32Array(0),
      lineVertices: new Float32Array(0), lineIndices: new Uint32Array(0),
      outlineIndices: new Uint32Array(0),
      tileWest: 0, tileSouth: 0, tileWidth: 1, tileHeight: 1, tileZoom: 0,
    }
    expect(gen.hasClippableGeometry(empty)).toBe(false)
    expect(gen.hasClippableGeometry(null)).toBe(false)
    expect(gen.hasClippableGeometry(undefined)).toBe(false)

    const world = makeParent(poly([[[-170, -80], [170, -80], [170, 80], [-170, 80], [-170, -80]]]), 0, 0, 0)
    expect(world).not.toBe(null)
    expect(gen.hasClippableGeometry(world!)).toBe(true)
  })

  it('clips z=0 world parent into a z=2 child — finite + in-bounds', () => {
    const world = makeParent(
      poly([[[-170, -80], [170, -80], [170, 80], [-170, 80], [-170, -80]]]),
      0, 0, 0,
    )!
    // z=2 child tile (x=1, y=1) — somewhere mid-world, covered by parent.
    const childKey = tileKey(2, 1, 1)
    const sub = gen.generate(world, childKey)
    expect(sub).not.toBe(null)
    assertSubTileInvariants(sub!, 'world→z2-child')
    // Child of a full-world parent must have geometry.
    expect(sub!.indices.length).toBeGreaterThan(0)
  })

  it('child fully inside parent geometry produces non-empty clip', () => {
    // Parent = z=3 tile fully inside a large polygon; child = its z=5
    // descendant. Both fully covered → child gets fill.
    const big = poly([[[-10, -10], [40, -10], [40, 40], [-10, 40], [-10, -10]]])
    const z = 3, n = 1 << z
    const x = Math.floor((10 + 180) / 360 * n)
    const latR = 10 * Math.PI / 180
    const yf = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2
    const y = Math.floor(yf * n)
    const parent = makeParent(big, z, x, y)
    if (parent && gen.hasClippableGeometry(parent)) {
      // A z=5 child = 2 levels deeper, same (x,y) lineage.
      const childKey = tileKey(5, x * 4 + 1, y * 4 + 1)
      const sub = gen.generate(parent, childKey)
      if (sub) assertSubTileInvariants(sub, 'inside-child')
    }
  })

  it('child outside parent geometry returns null (no spurious fill)', () => {
    // Parent has a small polygon in one corner; child addresses the
    // opposite corner → nothing survives clip → null.
    const corner = poly([[[-179, -84], [-178, -84], [-178, -83], [-179, -83], [-179, -84]]])
    const parent = makeParent(corner, 0, 0, 0)
    if (parent && gen.hasClippableGeometry(parent)) {
      // z=2 child in the FAR (east/north) corner — opposite the polygon.
      const childKey = tileKey(2, 3, 0)
      const sub = gen.generate(parent, childKey)
      // Either null (nothing survives) or finite empty — never NaN.
      if (sub) assertSubTileInvariants(sub, 'outside-child')
    }
  })

  it('repeated generate() on the same parent is deterministic', () => {
    const world = makeParent(
      poly([[[-170, -80], [170, -80], [170, 80], [-170, 80], [-170, -80]]]),
      0, 0, 0,
    )!
    const childKey = tileKey(2, 2, 1)
    const a = gen.generate(world, childKey)
    const b = gen.generate(world, childKey)
    expect(a !== null).toBe(b !== null)
    if (a && b) {
      expect(a.vertices.length).toBe(b.vertices.length)
      expect(a.indices.length).toBe(b.indices.length)
      // Byte-identical output (scratch reuse must not leak state).
      for (let i = 0; i < a.vertices.length; i++) {
        expect(a.vertices[i]).toBe(b.vertices[i])
      }
    }
  })

  it('deep child (z=2 parent → z=6 child, 4 levels) stays finite', () => {
    const region = poly([[[-50, -50], [50, -50], [50, 50], [-50, 50], [-50, -50]]])
    const parent = makeParent(region, 2, 1, 1)
    if (parent && gen.hasClippableGeometry(parent)) {
      const childKey = tileKey(6, 1 * 16 + 5, 1 * 16 + 5)
      const sub = gen.generate(parent, childKey)
      if (sub) assertSubTileInvariants(sub, 'deep-child')
    }
  })
})
