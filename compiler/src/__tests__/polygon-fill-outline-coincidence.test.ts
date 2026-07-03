// Fill/outline coincidence (d34aed2 invariant), golden-IR, no GPU.
//
// A single polygon's FILL and OUTLINE are emitted through separate paths in
// vector-tiler.ts:
//   FILL    = clipPolygonToRect(rings) → tessellate (stored as tile.polygons)
//   OUTLINE = clipLineToRect(original ring) → dropTileBoundaryEdges → tessellate
// They MUST trace the same boundary: every stroked outline vertex has to lie on
// the fill's boundary, otherwise the polygon renders with a visible gap (or
// spill) between its fill and its stroke.
//
// The historical bug: the FILL was decimated by simplifyPolygon at z < maxZoom
// while the OUTLINE kept the original ring's full detail. Douglas–Peucker only
// REMOVES vertices, so every surviving fill vertex stayed on the outline — but
// the dropped outline vertices then sat OFF the coarsened fill edges by up to
// the simplification tolerance, which doubles every zoom-out (measured up to
// ~4.7 km at z0 for the fixture below). The fix makes the fill use the same
// un-simplified clipped ring at every zoom, so they coincide by construction.
//
// This test EXERCISES A REAL TILE-BOUNDARY CROSSING (the outline appears in
// ≥2 tiles) at BOTH z == maxZoom and z < maxZoom, and asserts the max
// outline-vertex-to-fill-boundary distance is within a tight tolerance. It is
// the fail-before gate for the fix: before it, z < maxZoom diverges by
// hundreds of metres; after, it is f32-quantization noise (≈2 m).

import { describe, it, expect } from 'vitest'
import { compileGeoJSONToTiles, lonLatToMercF64, type CompiledTile } from '../tiler/vector-tiler'

// Polygon ~8° wide centred near (126, 37). The EAST edge is a dense sine wave
// (amplitude 0.15°, sampled every 0.02°) — fine detail the low-zoom
// simplification tolerance is large enough to remove from the fill. The shape
// spans several degrees so it crosses tile boundaries at low/mid zoom.
function wavyPolygon() {
  const cx = 126,
    cy = 37,
    W = 4,
    H = 4
  const ring: [number, number][] = []
  for (let lon = cx - W; lon <= cx + W; lon += 0.5) ring.push([lon, cy - H])
  for (let lat = cy - H; lat <= cy + H; lat += 0.02) {
    ring.push([cx + W + 0.15 * Math.sin((lat - (cy - H)) * Math.PI * 4), lat])
  }
  for (let lon = cx + W; lon >= cx - W; lon -= 0.5) ring.push([lon, cy + H])
  for (let lat = cy + H; lat >= cy - H; lat -= 0.5) ring.push([cx - W, lat])
  ring.push(ring[0]!)
  return {
    type: 'FeatureCollection' as const,
    features: [
      {
        type: 'Feature' as const,
        id: 1,
        geometry: { type: 'Polygon' as const, coordinates: [ring] },
        properties: { name: 'wavy' },
      },
    ],
  }
}

// Concave NOTCH polygon that straddles tile boundaries at low/mid zoom.
// A square ~8° wide centred near (126, 37) with a deep V-notch cut INTO
// the east edge (the notch tip is pulled ~1.3° inward). The concave
// corner is exactly where a fill/outline path divergence opens a gap,
// and the shape is large enough to cross tile boundaries (the divergence
// the loose-tolerance test below can't see lives at those crossings).
function notchPolygon() {
  const cx = 126,
    cy = 37,
    W = 4,
    H = 4
  const ring: [number, number][] = []
  for (let lon = cx - W; lon <= cx + W; lon += 0.5) ring.push([lon, cy - H])
  ring.push([cx + W, cy - 1])
  ring.push([cx + W - 1.3, cy]) // notch tip (concave corner)
  ring.push([cx + W, cy + 1])
  ring.push([cx + W, cy + H])
  for (let lon = cx + W; lon >= cx - W; lon -= 0.5) ring.push([lon, cy + H])
  ring.push([cx - W, cy - H])
  ring.push(ring[0]!)
  return {
    type: 'FeatureCollection' as const,
    features: [
      {
        type: 'Feature' as const,
        id: 1,
        geometry: { type: 'Polygon' as const, coordinates: [ring] },
        properties: { name: 'notch' },
      },
    ],
  }
}

/** Distance (MM) from point P to segment AB. */
function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax,
    dy = by - ay,
    L2 = dx * dx + dy * dy
  if (L2 === 0) return Math.hypot(px - ax, py - ay)
  let t = ((px - ax) * dx + (py - ay) * dy) / L2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

const STRIDE = 10 // outlineVertices: [mx_h, my_h, mx_l, my_l, feat, arc, tinX, tinY, toutX, toutY]

/** Fill boundary edges (absolute MM) from a tile's emitted polygon ring set. */
function fillEdges(tile: CompiledTile): Array<[number, number, number, number]> {
  const edges: Array<[number, number, number, number]> = []
  for (const p of tile.polygons ?? []) {
    for (const ring of p.rings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!,
          b = ring[(i + 1) % ring.length]!
        edges.push([a[0]!, a[1]!, b[0]!, b[1]!])
      }
    }
  }
  return edges
}

/** Max distance (MM) from any outline vertex/midpoint to the nearest fill edge
 *  in this tile, plus counts that prove the assertion is NON-VACUOUS. */
function maxOutlineOffFill(tile: CompiledTile): {
  max: number
  outSegs: number
  nFillEdges: number
} {
  const olv = tile.outlineVertices,
    oli = tile.outlineLineIndices
  const edges = fillEdges(tile)
  if (!olv || !oli || oli.length === 0 || edges.length === 0)
    return { max: 0, outSegs: 0, nFillEdges: edges.length }
  const [twMx, tsMy] = lonLatToMercF64(tile.tileWest, tile.tileSouth)
  let max = 0,
    outSegs = 0
  for (let i = 0; i < oli.length; i += 2) {
    const ia = oli[i]! * STRIDE,
      ib = oli[i + 1]! * STRIDE
    const ax = twMx + olv[ia]! + olv[ia + 2]!,
      ay = tsMy + olv[ia + 1]! + olv[ia + 3]!
    const bx = twMx + olv[ib]! + olv[ib + 2]!,
      by = tsMy + olv[ib + 1]! + olv[ib + 3]!
    outSegs++
    for (const [px, py] of [
      [ax, ay],
      [bx, by],
      [(ax + bx) / 2, (ay + by) / 2],
    ] as const) {
      let best = Infinity
      for (const [ex, ey, fx, fy] of edges) {
        const d = distToSeg(px, py, ex, ey, fx, fy)
        if (d < best) best = d
      }
      if (best > max) max = best
    }
  }
  return { max, outSegs, nFillEdges: edges.length }
}

describe('polygon fill/outline coincidence (d34aed2)', () => {
  // Tolerance: well below the pre-fix divergence (≥150 m at z<maxZoom for this
  // fixture) and above the post-fix f32-DSFUN reconstruction noise (≈2 m).
  const TOL_MM = 15

  it('z == maxZoom: every outline vertex lies on the fill boundary (boundary-crossing)', () => {
    const maxZoom = 6
    const set = compileGeoJSONToTiles(wavyPolygon(), { minZoom: 0, maxZoom })
    const level = set.levels.find((l) => l.zoom === maxZoom)
    expect(level, 'maxZoom level compiled').toBeDefined()

    let tilesWithBoth = 0,
      worst = 0,
      totalOutSegs = 0
    for (const [, tile] of level!.tiles) {
      const r = maxOutlineOffFill(tile)
      if (r.outSegs === 0 || r.nFillEdges === 0) continue
      tilesWithBoth++
      totalOutSegs += r.outSegs
      worst = Math.max(worst, r.max)
    }
    // NON-VACUITY: a boundary-crossing polygon must populate outline+fill in
    // MULTIPLE tiles (proves we exercise a real tile crossing, not one interior tile).
    expect(
      tilesWithBoth,
      'outline+fill present across multiple tiles (real crossing)',
    ).toBeGreaterThanOrEqual(2)
    expect(totalOutSegs, 'has stroked outline segments').toBeGreaterThan(10)
    expect(worst, `max outline-off-fill at z==maxZoom = ${worst.toFixed(1)}m`).toBeLessThan(TOL_MM)
  })

  it('z < maxZoom: fill stays coincident with the (full-detail) outline — no simplification gap', () => {
    const maxZoom = 6
    const set = compileGeoJSONToTiles(wavyPolygon(), { minZoom: 0, maxZoom })

    // Scan EVERY z below maxZoom: this is where the simplification divergence
    // lived (and grew on zoom-out). All must coincide post-fix.
    for (const level of set.levels) {
      if (level.zoom >= maxZoom) continue
      let tilesWithBoth = 0,
        worst = 0,
        worstTile = ''
      for (const [, tile] of level.tiles) {
        const r = maxOutlineOffFill(tile)
        if (r.outSegs === 0 || r.nFillEdges === 0) continue
        tilesWithBoth++
        if (r.max > worst) {
          worst = r.max
          worstTile = `${tile.z}/${tile.x}/${tile.y}`
        }
      }
      if (tilesWithBoth === 0) continue // some very low z may full-cover (quad) → no outline
      expect(
        worst,
        `z=${level.zoom}: max outline-off-fill = ${worst.toFixed(1)}m at ${worstTile} (pre-fix this was hundreds of m from fill simplification)`,
      ).toBeLessThan(TOL_MM)
    }
  })

  // STRICT coincidence: after unifying the outline onto the fill's
  // `clipped` ring, every outline vertex is a vertex OF the fill ring (or
  // on an edge), so the outline-vertex→fill-edge distance is f32-DSFUN
  // reconstruction noise, NOT the 2–15 m the loose test tolerated.
  //
  // EPS_STRICT discriminates the fix from the pre-fix line-clip path:
  //   • pre-fix (line-clip of ORIGINAL ring): outline vertices land up to
  //     ~3.8 m off the fill edge at tile crossings (different clipper +
  //     precision rounding) — FAILS a 0.05 m bound.
  //   • post-fix (outline from `clipped`): identical vertices → ~0 m.
  // This is the fail-before / pass-after gate. The wavy fixture crosses
  // tile boundaries; the notch fixture adds a concave corner.
  const EPS_STRICT = 0.05 // metres (MM)

  for (const [name, makeFC, maxZoom] of [
    ['wavy (boundary-crossing)', wavyPolygon, 6],
    ['notch (concave + boundary-crossing)', notchPolygon, 6],
  ] as const) {
    it(`STRICT: ${name} — every outline vertex lies on a fill edge (≤${EPS_STRICT} m) at all zooms`, () => {
      const set = compileGeoJSONToTiles(makeFC(), { minZoom: 0, maxZoom })
      let scannedTiles = 0,
        scannedSegs = 0,
        worstAll = 0,
        worstAt = ''
      for (const level of set.levels) {
        for (const [, tile] of level.tiles) {
          const r = maxOutlineOffFill(tile)
          if (r.outSegs === 0 || r.nFillEdges === 0) continue
          scannedTiles++
          scannedSegs += r.outSegs
          if (r.max > worstAll) {
            worstAll = r.max
            worstAt = `${tile.z}/${tile.x}/${tile.y}`
          }
        }
      }
      // NON-VACUITY: must actually exercise outline+fill tiles, including
      // boundary crossings (≥2 tiles carry both across all zooms).
      expect(scannedTiles, `${name}: outline+fill tiles scanned`).toBeGreaterThanOrEqual(2)
      expect(scannedSegs, `${name}: outline segments scanned`).toBeGreaterThan(20)
      expect(
        worstAll,
        `${name}: max outline-vertex-off-fill = ${worstAll.toFixed(3)}m at ${worstAt} ` +
          `(pre-fix the line-clip path diverged ~3.8 m at tile crossings; the unify makes them identical)`,
      ).toBeLessThan(EPS_STRICT)
    })
  }
})
