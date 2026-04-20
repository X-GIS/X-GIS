import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import {
  compileGeoJSONToTiles,
  compileSingleTile,
  decomposeFeatures,
  tileKey,
  lonLatToMercF64,
  type GeoJSONFeatureCollection,
  type CompiledTile,
} from '@xgis/compiler'

// USER BUG (2026-04-20): at
//   demo.html?id=fixture_translucent_stroke#8.64/27.43511/-1.14730/45.0/72.1
// the polygon fill and the stroke outline do NOT visually coincide.
// At pitch 45° they appear at dramatically different screen positions.
//
// compileSingleTile has TWO distinct clip paths for a polygon feature:
//   Fill:    clipPolygonToRect  in LON/LAT space  (tb.west..tb.east × tb.south..tb.north)
//   Stroke:  clipLineToRect     in MERCATOR space (stMxW..stMxE × stMyS..stMyN)
// With a large source triangle (vertices at ±20° / ±30° lat), the
// boundary vs interior points differ between these spaces because
// lat→mercY is non-linear. Hypothesis: for tiles whose visible slice
// of the triangle is sensitive to that nonlinearity, fill and
// outline end up as geometrically different shapes.
//
// This test loads the exact fixture-triangle.geojson, compiles it at
// the z=9 tile covering the user's camera centre, and asserts that:
//
//   (1) Every outline line vertex lies (within a small tolerance) on
//       one of the polygon fill's boundary edges, AND
//   (2) Every polygon boundary edge is traced by some outline segment
//
// If these hold, the bug is in the GPU / renderer. If they fail, the
// bug is in the compiler — the fill and outline were emitted from
// different geometry.

const __dirname = dirname(fileURLToPath(import.meta.url))
const TRIANGLE_PATH = resolve(__dirname, '../../../playground/public/data/fixture-triangle.geojson')

function loadTriangle(): GeoJSONFeatureCollection {
  return JSON.parse(readFileSync(TRIANGLE_PATH, 'utf8')) as GeoJSONFeatureCollection
}

/** DSFUN polygon vertex stride 5: [mx_h, my_h, mx_l, my_l, fid] */
const POLY_STRIDE = 5
/** DSFUN line vertex stride 10: [mx_h, my_h, mx_l, my_l, fid, arc, tin_x, tin_y, tout_x, tout_y] */
const LINE_STRIDE = 10

/** Reconstruct a polygon-fill vertex's full-precision tile-local
 *  Mercator (mx, my) from the DSFUN hi/lo pair. */
function polyVertex(vertices: Float32Array, i: number): [number, number] {
  const base = i * POLY_STRIDE
  return [vertices[base] + vertices[base + 2], vertices[base + 1] + vertices[base + 3]]
}

/** Reconstruct a line vertex's full-precision tile-local Mercator. */
function lineVertex(vertices: Float32Array, i: number): [number, number] {
  const base = i * LINE_STRIDE
  return [vertices[base] + vertices[base + 2], vertices[base + 1] + vertices[base + 3]]
}

/** Extract the outer boundary edges of the triangle mesh — every
 *  triangle edge that appears in exactly one triangle. These are the
 *  edges the stroke outline should trace. */
function extractPolygonBoundaryEdges(tile: CompiledTile): Array<[number, number, number, number]> {
  const edgeCount = new Map<string, { count: number; a: [number, number]; b: [number, number] }>()
  const keyOf = (a: [number, number], b: [number, number]): string => {
    // Sort so (a, b) and (b, a) hash the same.
    const forward = a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])
    const p0 = forward ? a : b
    const p1 = forward ? b : a
    return `${p0[0].toFixed(3)},${p0[1].toFixed(3)}|${p1[0].toFixed(3)},${p1[1].toFixed(3)}`
  }
  for (let i = 0; i < tile.indices.length; i += 3) {
    const i0 = tile.indices[i]
    const i1 = tile.indices[i + 1]
    const i2 = tile.indices[i + 2]
    const p0 = polyVertex(tile.vertices, i0)
    const p1 = polyVertex(tile.vertices, i1)
    const p2 = polyVertex(tile.vertices, i2)
    for (const [a, b] of [[p0, p1], [p1, p2], [p2, p0]] as const) {
      const k = keyOf(a, b)
      const existing = edgeCount.get(k)
      if (existing) existing.count++
      else edgeCount.set(k, { count: 1, a, b })
    }
  }
  // Boundary edges appear in exactly one triangle (interior edges
  // appear in two and cancel).
  const boundary: Array<[number, number, number, number]> = []
  for (const v of edgeCount.values()) {
    if (v.count === 1) boundary.push([v.a[0], v.a[1], v.b[0], v.b[1]])
  }
  return boundary
}

/** Extract outline line segments from the outlineLineIndices pairs. */
function extractOutlineSegments(tile: CompiledTile): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = []
  const verts = tile.outlineVertices
  const idx = tile.outlineLineIndices
  if (!verts || !idx || verts.length === 0 || idx.length === 0) return out
  for (let i = 0; i < idx.length; i += 2) {
    const i0 = idx[i]
    const i1 = idx[i + 1]
    const [x0, y0] = lineVertex(verts, i0)
    const [x1, y1] = lineVertex(verts, i1)
    out.push([x0, y0, x1, y1])
  }
  return out
}

/** Squared distance from point p to segment ab. */
function pointToSegmentSqDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const lenSq = dx * dx + dy * dy
  if (lenSq < 1e-12) {
    const ex = p[0] - a[0], ey = p[1] - a[1]
    return ex * ex + ey * ey
  }
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  const cx = a[0] + t * dx, cy = a[1] + t * dy
  const ex = p[0] - cx, ey = p[1] - cy
  return ex * ex + ey * ey
}

// Which z=9 tile the user's camera sits in.
function cameraTile(z: number, lat: number, lon: number): { z: number; x: number; y: number } {
  const n = Math.pow(2, z)
  const x = Math.floor((lon + 180) / 360 * n)
  const clampedLat = Math.max(-85.051129, Math.min(85.051129, lat))
  const y = Math.floor((1 - Math.log(Math.tan(Math.PI / 4 + clampedLat * Math.PI / 360)) / Math.PI) / 2 * n)
  return { z, x, y }
}

// ═══════════════════════════════════════════════════════════════════

describe('Polygon fill vs stroke alignment (user bug repro)', () => {
  const BUG = { lat: 27.43511, lon: -1.14730 }
  // The right edge of the triangle (30,-20)→(0,30) crosses the user's
  // latitude at lon ≈ 1.56 — this is a BOUNDARY tile where both fill
  // AND outline should be present.
  const BOUNDARY = { lat: 27.43511, lon: 1.56 }

  // Walk a few zooms around the user's camera zoom. For each zoom,
  // pick a tile on the triangle boundary (not interior / full-cover).
  for (const z of [7, 8, 9, 10]) {
    it(`z=${z} boundary tile: outline traces polygon fill boundary`, () => {
      const gj = loadTriangle()
      const parts = decomposeFeatures(gj.features)
      const { x, y } = cameraTile(z, BOUNDARY.lat, BOUNDARY.lon)
      const tile = compileSingleTile(parts, z, x, y, 22)
      expect(tile, `z=${z} tile (${x}, ${y}): compileSingleTile returned null`).not.toBeNull()
      if (!tile) return

      // Basic shape sanity.
      expect(tile.vertices.length, `z=${z}: no polygon vertices`).toBeGreaterThan(0)
      expect(tile.outlineVertices.length, `z=${z}: no outline vertices`).toBeGreaterThan(0)

      const boundaryEdges = extractPolygonBoundaryEdges(tile)
      const outlineSegments = extractOutlineSegments(tile)
      expect(boundaryEdges.length, `z=${z}: no fill boundary edges`).toBeGreaterThan(0)
      expect(outlineSegments.length, `z=${z}: no outline segments`).toBeGreaterThan(0)

      // Every outline endpoint should land on a polygon-fill boundary
      // edge within tolerance. Tolerance 1 m (tile-local Mercator) —
      // the lon/lat vs Mercator clip difference at a tile crossing is
      // O(Δlat² × R) which can reach many meters for a 50° triangle.
      //
      // If this fails the compiler is emitting geometrically
      // different fill vs outline, and the user sees them drift
      // apart in the renderer (the exact reported symptom).
      const TOL = 1.0
      const TOL_SQ = TOL * TOL
      const misaligned: Array<{ ox: number; oy: number; minDist: number }> = []
      for (const seg of outlineSegments) {
        for (const [ox, oy] of [[seg[0], seg[1]], [seg[2], seg[3]]] as const) {
          let minSq = Infinity
          for (const e of boundaryEdges) {
            const d = pointToSegmentSqDist([ox, oy], [e[0], e[1]], [e[2], e[3]])
            if (d < minSq) minSq = d
          }
          if (minSq > TOL_SQ) {
            misaligned.push({ ox, oy, minDist: Math.sqrt(minSq) })
          }
        }
      }

      if (misaligned.length > 0) {
        const summary = misaligned.slice(0, 5).map(m =>
          `  (${m.ox.toFixed(2)}, ${m.oy.toFixed(2)}) → ${m.minDist.toFixed(2)} m from nearest fill edge`
        ).join('\n')
        console.log(
          `[z=${z}] ${misaligned.length}/${outlineSegments.length * 2} outline endpoints off the fill boundary (max ${Math.max(...misaligned.map(m => m.minDist)).toFixed(2)} m):\n${summary}`,
        )
        // Debug: dump the fill boundary + outline segments so we can
        // see HOW they diverge geometrically.
        const fillSummary = boundaryEdges.slice(0, 4).map(e =>
          `    fill  (${e[0].toFixed(2)}, ${e[1].toFixed(2)}) → (${e[2].toFixed(2)}, ${e[3].toFixed(2)})`
        ).join('\n')
        const lineSummary = outlineSegments.slice(0, 4).map(s =>
          `    line  (${s[0].toFixed(2)}, ${s[1].toFixed(2)}) → (${s[2].toFixed(2)}, ${s[3].toFixed(2)})`
        ).join('\n')
        console.log(`  [z=${z}] fill boundary edges (first 4):\n${fillSummary}`)
        console.log(`  [z=${z}] outline segments (first 4):\n${lineSummary}`)
      }
      expect(misaligned.length,
        `${misaligned.length} outline endpoints > ${TOL} m from nearest fill edge`,
      ).toBe(0)
    })
  }
})

// ═══════════════════════════════════════════════════════════════════
// Additional diagnostic: compare clip spaces directly for this
// triangle / tile combo.
// ═══════════════════════════════════════════════════════════════════

describe('Polygon fill vs stroke alignment: clip-space disparity diagnostic', () => {
  it('reports the metric distance between lon/lat-clipped corners and Mercator-clipped corners', () => {
    const gj = loadTriangle()
    const parts = decomposeFeatures(gj.features)
    const { x, y } = cameraTile(9, 27.43511, -1.14730)
    const tile = compileSingleTile(parts, 9, x, y, 22)
    if (!tile) return

    // Just report bounding boxes — useful "is there any divergence at
    // all" signal even if the main assertion above is lenient.
    let fillMinX = Infinity, fillMaxX = -Infinity, fillMinY = Infinity, fillMaxY = -Infinity
    const count = tile.vertices.length / POLY_STRIDE
    for (let i = 0; i < count; i++) {
      const [mx, my] = polyVertex(tile.vertices, i)
      if (mx < fillMinX) fillMinX = mx
      if (mx > fillMaxX) fillMaxX = mx
      if (my < fillMinY) fillMinY = my
      if (my > fillMaxY) fillMaxY = my
    }
    let lineMinX = Infinity, lineMaxX = -Infinity, lineMinY = Infinity, lineMaxY = -Infinity
    const lcount = tile.outlineVertices.length / LINE_STRIDE
    for (let i = 0; i < lcount; i++) {
      const [mx, my] = lineVertex(tile.outlineVertices, i)
      if (mx < lineMinX) lineMinX = mx
      if (mx > lineMaxX) lineMaxX = mx
      if (my < lineMinY) lineMinY = my
      if (my > lineMaxY) lineMaxY = my
    }
    console.log(
      `[z=9 tile ${x}/${y}] fill bbox: (${fillMinX.toFixed(1)}..${fillMaxX.toFixed(1)}, ` +
      `${fillMinY.toFixed(1)}..${fillMaxY.toFixed(1)})`,
    )
    console.log(
      `[z=9 tile ${x}/${y}] line bbox: (${lineMinX.toFixed(1)}..${lineMaxX.toFixed(1)}, ` +
      `${lineMinY.toFixed(1)}..${lineMaxY.toFixed(1)})`,
    )
    console.log(
      `[z=9 tile ${x}/${y}] Δ bbox: x=(${(lineMinX - fillMinX).toFixed(2)}, ${(lineMaxX - fillMaxX).toFixed(2)}) ` +
      `y=(${(lineMinY - fillMinY).toFixed(2)}, ${(lineMaxY - fillMaxY).toFixed(2)}) m`,
    )
  })
})
