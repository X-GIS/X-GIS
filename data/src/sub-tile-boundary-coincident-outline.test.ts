// #2553's RUNTIME half. The compiler tiler narrowed "is this edge synthetic?"
// from a GEOMETRIC test (both endpoints on the same tile-rect side ⇒ synthetic)
// to a PROVENANCE one (both endpoints inserted by the clipper ⇒ synthetic),
// because a REAL polygon edge lying along a tile side — a box on lon 0, a
// border on the equator — is geometrically indistinguishable from the clipper's
// own closing edge and was losing its outline stroke.
//
// `SubTileGenerator` re-answers the SAME question for the over-zoom path, on
// the PARENT tile's rect, and did not get that narrowing: a real edge on the
// parent boundary still lost its stroke past archive maxZoom, so a side of the
// feature vanished on zoom-in while the parent tile drew it.
//
// The provenance the compiler uses is an identity Set of vertex arrays and
// cannot reach here (`RingPolygon` is plain numbers, decoded from the archive
// or structured-cloned out of a worker). It does not have to: the parent tile
// already carries the RESOLVED verdict in its own `outlineVertices`, built by
// the compiler WITH provenance. This suite pins that both halves of the verdict
// survive into the sub-tile — the real edge strokes, the synthetic one does not.

import { describe, it, expect } from 'vitest'
import { SubTileGenerator } from '@xgis/data'
import type { TileData } from '@xgis/data'
import { decomposeFeatures, compileSingleTile, tileKey, lonLatToMercF64 } from '@xgis/compiler'
import type { GeoJSONFeature } from '@xgis/compiler'

/** Web-Mercator tile bounds in degrees (tileBounds is internal to the
 *  compiler — reimplement the standard scheme here). */
function tileBoundsDeg(
  z: number,
  x: number,
  y: number,
): { west: number; south: number; east: number; north: number } {
  const n = Math.pow(2, z)
  const west = (x / n) * 360 - 180
  const east = ((x + 1) / n) * 360 - 180
  const north = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI
  const south = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI
  return { west, south, east, north }
}

const poly = (coords: number[][][]): GeoJSONFeature => ({
  type: 'Feature',
  properties: {},
  geometry: { type: 'Polygon', coordinates: coords },
})

/** Compile a polygon into a parent TileData, forwarding BOTH the clipped
 *  `polygons` rings (the over-zoom outline path re-derives from them) and the
 *  compiler's own `outlineVertices` (the provenance-resolved verdict the
 *  narrowing reads back). maxZoom = z so the clipped ring is preserved
 *  verbatim. */
function makeParent(feature: GeoJSONFeature, z: number, x: number, y: number): TileData | null {
  const parts = decomposeFeatures([feature])
  const compiled = compileSingleTile(parts, z, x, y, z)
  if (!compiled) return null
  const b = tileBoundsDeg(z, x, y)
  return {
    vertices: compiled.vertices,
    dequantScale: compiled.dequantScale,
    dequantHalf: compiled.dequantHalf,
    indices: compiled.indices,
    lineVertices: compiled.lineVertices,
    lineIndices: compiled.lineIndices,
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- asserts the deprecated outlineIndices contract
    outlineIndices: compiled.outlineIndices,
    outlineVertices: compiled.outlineVertices,
    outlineLineIndices: compiled.outlineLineIndices,
    tileWest: b.west,
    tileSouth: b.south,
    tileWidth: b.east - b.west,
    tileHeight: b.north - b.south,
    tileZoom: z,
    polygons: compiled.polygons,
  }
}

const OUTLINE_STRIDE = 10
/** Metres. `targetMx` is exact in f64; the packed vertex is DSFUN f32+f32, so
 *  a metre of slack covers the split without reaching a neighbouring edge
 *  (the nearest one here is 1.1e6 m away). */
const EPS_MM = 1.0

/** Outline segments whose BOTH endpoints sit on the vertical line
 *  `x = targetMx`, and the total segment count (a zero total would make the
 *  "no synthetic stroke" arm vacuous). */
function segmentsOnVerticalLine(
  olv: Float32Array | undefined,
  oli: Uint32Array | undefined,
  originMx: number,
  targetMx: number,
): { on: number; total: number } {
  let on = 0,
    total = 0
  if (!olv || !oli) return { on, total }
  for (let i = 0; i + 1 < oli.length; i += 2) {
    const ia = oli[i]! * OUTLINE_STRIDE
    const ib = oli[i + 1]! * OUTLINE_STRIDE
    const ax = originMx + olv[ia]! + olv[ia + 2]!
    const bx = originMx + olv[ib]! + olv[ib + 2]!
    total++
    if (Math.abs(ax - targetMx) < EPS_MM && Math.abs(bx - targetMx) < EPS_MM) on++
  }
  return { on, total }
}

// Parent z=3 x=5 y=2 — lon [45, 90], lat [40.98, 66.51].
const PZ = 3,
  PX = 5,
  PY = 2
const PB = tileBoundsDeg(PZ, PX, PY)
const parentOriginMx = lonLatToMercF64(PB.west, PB.south)[0]
const westEdgeMx = lonLatToMercF64(PB.west, 0)[0] // lon 45 — the REAL edge
const eastEdgeMx = lonLatToMercF64(PB.east, 0)[0] // lon 90 — the SYNTHETIC edge

/** One polygon carrying BOTH cases against the same parent rect:
 *   - its WEST side is exactly lon 45 = the parent's west edge, and is a real
 *     source edge the clipper never touched;
 *   - it runs east to lon 120, so Sutherland-Hodgman closes it along lon 90 =
 *     the parent's east edge, which is synthetic.
 *  Both are "both endpoints on the same parent-rect side" — the geometric test
 *  cannot separate them, which is the whole point. */
const boundaryBox = poly([
  [
    [45, 45],
    [120, 45],
    [120, 60],
    [45, 60],
    [45, 45],
  ],
])

// Sub-tiles at z=5 (over-zoom past the parent), lat row y=11 = [40.98, 48.92]
// so both share the box's lat span. x=20 is the parent's west column (its west
// edge IS lon 45); x=23 is the parent's east column (east edge IS lon 90).
const SUB_Z = 5,
  SUB_Y = 11,
  SUB_X_WEST = 20,
  SUB_X_EAST = 23

describe('#2553 runtime half — a real parent-boundary edge keeps its over-zoom stroke', () => {
  it('the parent tile itself strokes the real side and not the synthetic one', () => {
    // Premise of the fix: the parent's OWN outline is the provenance-resolved
    // verdict. If this arm ever flips, the narrowing below is reading a
    // channel that no longer carries the answer.
    const parent = makeParent(boundaryBox, PZ, PX, PY)
    expect(parent).not.toBeNull()
    const real = segmentsOnVerticalLine(
      parent!.outlineVertices,
      parent!.outlineLineIndices,
      parentOriginMx,
      westEdgeMx,
    )
    const synthetic = segmentsOnVerticalLine(
      parent!.outlineVertices,
      parent!.outlineLineIndices,
      parentOriginMx,
      eastEdgeMx,
    )
    expect(real.total, 'parent must emit an outline at all').toBeGreaterThan(0)
    expect(real.on, 'parent strokes its real west-boundary edge (#2553)').toBeGreaterThan(0)
    expect(synthetic.on, 'parent does not stroke its synthetic east clip edge').toBe(0)
  })

  it('the over-zoom sub-tile keeps the real edge on the parent boundary', () => {
    const parent = makeParent(boundaryBox, PZ, PX, PY)
    expect(parent).not.toBeNull()
    expect(parent!.polygons, 'parent must forward clipped rings').toBeDefined()

    const sb = tileBoundsDeg(SUB_Z, SUB_X_WEST, SUB_Y)
    const sub = new SubTileGenerator().generate(parent!, tileKey(SUB_Z, SUB_X_WEST, SUB_Y))
    expect(sub).not.toBeNull()
    const { on, total } = segmentsOnVerticalLine(
      sub!.outlineVertices,
      sub!.outlineLineIndices,
      lonLatToMercF64(sb.west, sb.south)[0],
      westEdgeMx,
    )
    // The box's south side runs through this sub-tile, so a zero total would
    // mean the outline path emitted nothing at all rather than dropping a side.
    expect(total, 'sub-tile must emit the box edges that fall inside it').toBeGreaterThan(0)
    expect(
      on,
      'the real polygon edge lying on the parent west boundary must still stroke',
    ).toBeGreaterThan(0)
  })

  it('the over-zoom sub-tile still drops the synthetic parent clip edge', () => {
    // Non-vacuity: the narrowing must not simply keep every rect-coincident
    // edge — the Sutherland-Hodgman closing edge along lon 90 is the #347
    // "vertical line through Russia" and stays dropped.
    const parent = makeParent(boundaryBox, PZ, PX, PY)
    expect(parent).not.toBeNull()

    const sb = tileBoundsDeg(SUB_Z, SUB_X_EAST, SUB_Y)
    const sub = new SubTileGenerator().generate(parent!, tileKey(SUB_Z, SUB_X_EAST, SUB_Y))
    expect(sub).not.toBeNull()
    const { on, total } = segmentsOnVerticalLine(
      sub!.outlineVertices,
      sub!.outlineLineIndices,
      lonLatToMercF64(sb.west, sb.south)[0],
      eastEdgeMx,
    )
    expect(total, 'sub-tile must emit the box edges that fall inside it').toBeGreaterThan(0)
    expect(on, 'no outline segment may run along the synthetic parent east clip edge').toBe(0)
  })
})
