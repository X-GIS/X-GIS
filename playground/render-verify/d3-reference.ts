// Oracle-B reference renderer: draw the SAME synthetic geometry with
// d3-geo's geoPath onto a Canvas2D context. This is the math-derived,
// trivially-trustworthy ground truth the GPU frame is diffed against.
//
// Runs IN-BROWSER (the Oracle-B spec builds the canvas + ctx in-page so the
// d3 reference and the GPU readback live in the same colour space / DPR).
//
// Colours are pinned to the X-GIS fixture layer colours (fixture-render-
// verify.xgis) so the pixel diff measures GEOMETRY/PROJECTION placement, not
// a palette mismatch. The hex values are the Tailwind shades the fixture's
// `fill-*` / `stroke-*` utilities resolve to (compiler/src/tokens/colors.ts).

import { geoPath, type GeoProjection } from 'd3-geo'
import type { GeoJSONFeatureCollection, GeoJSONFeature } from './fixtures'

// ── Spherical polygon winding fix ─────────────────────────────────────────
// d3-geo treats GeoJSON polygons as SPHERICAL regions: a ring's winding order
// selects interior vs its complement (the rest of the globe). d3 expects the
// EXTERIOR ring to be CLOCKWISE (negative signed planar area in lon/lat with
// y-up) so the enclosed region is the small patch. RFC 7946 instead mandates
// CCW exteriors — the classic mismatch — and fixtures.ts authors its squares
// CCW. Fed as-is, d3 reads each CCW ring as "everything EXCEPT the square" and
// floods the whole canvas emerald.
//
// We rewind a COPY of each polygon so the shared fixtures.ts objects are never
// mutated (other lanes consume them): exterior ring forced CW, holes forced
// CCW. Lines/points have no winding semantics and pass through untouched.

type Ring = [number, number][]

/** Signed planar area of a ring (shoelace). >0 ⇒ CCW, <0 ⇒ CW (y-up). */
function signedArea(ring: Ring): number {
  let sum = 0
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    const [x1, y1] = ring[i]
    const [x2, y2] = ring[i + 1]
    sum += x1 * y2 - x2 * y1
  }
  return sum / 2
}

/** Return a reversed COPY of a ring (preserves closure first==last). */
function reverseRing(ring: Ring): Ring {
  return ring.slice().reverse() as Ring
}

/**
 * Return a winding-corrected COPY of a Polygon feature for d3's spherical
 * reading: exterior ring CW (signedArea < 0), interior holes CCW. The input
 * feature is never mutated.
 */
function rewindPolygonFeatureForD3(f: GeoJSONFeature): GeoJSONFeature {
  if (f.geometry.type !== 'Polygon') return f
  const rings = f.geometry.coordinates as Ring[]
  const fixed = rings.map((ring, i) => {
    const ccw = signedArea(ring) > 0
    // Exterior (i===0): want CW ⇒ reverse if currently CCW.
    // Holes (i>0):      want CCW ⇒ reverse if currently CW.
    const needsReverse = i === 0 ? ccw : !ccw
    return needsReverse ? reverseRing(ring) : ring.slice()
  })
  return {
    ...f,
    geometry: { type: 'Polygon', coordinates: fixed },
  }
}

/** Per-family draw colours — keep in sync with fixture-render-verify.xgis. */
export const STYLE = {
  // layer poly_fill  | fill-emerald-500
  polyFill: '#10b981',
  // layer poly_fill  | stroke-emerald-700  (gives fills a crisp edge)
  polyStroke: '#047857',
  polyStrokeWidth: 1.5,
  // layer the_lines  | stroke-rose-500 stroke-3
  lineStroke: '#f43f5e',
  lineWidth: 3,
  // layer graticule  | stroke-sky-400 stroke-1
  gridStroke: '#38bdf8',
  gridWidth: 1,
  // layer the_points | fill-amber-500 size-N (rendered as filled discs)
  pointFill: '#f59e0b',
  pointRadius: 5,
} as const

export interface ReferenceStyle {
  polyFill: string
  polyStroke: string
  polyStrokeWidth: number
  lineStroke: string
  lineWidth: number
  gridStroke: string
  gridWidth: number
  pointFill: string
  pointRadius: number
}

interface DrawArgs {
  graticule: GeoJSONFeatureCollection
  polys: GeoJSONFeatureCollection
  lines: GeoJSONFeatureCollection
  points: GeoJSONFeatureCollection
}

/**
 * Render the four fixture families to a 2D context via d3-geo geoPath.
 * Draw order mirrors a typical map stack: fills, then grid + lines, then
 * points on top.
 *
 * @param ctx        a CanvasRenderingContext2D (or OffscreenCanvas ctx).
 * @param fc         the four FeatureCollections (from fixtures.ts).
 * @param projection a configured d3 projection (from camera-map.ts).
 * @param style      colours/widths (defaults to STYLE).
 */
export function renderReferenceToCanvas(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  fc: DrawArgs,
  projection: GeoProjection,
  style: ReferenceStyle = STYLE,
): void {
  // geoPath types are written against the DOM CanvasRenderingContext2D; an
  // OffscreenCanvas 2D context is shape-compatible for the path methods used.
  const path = geoPath(projection, ctx as unknown as CanvasRenderingContext2D)

  // ── Polygons: fill + thin stroke ──────────────────────────────────────
  // Rewind each polygon's rings to d3's expected spherical winding (exterior
  // CW) on a COPY, so the fill is the 3 discrete squares — not the whole-globe
  // complement — and the shared fixtures objects stay untouched.
  ctx.beginPath()
  for (const f of fc.polys.features) {
    const rewound = rewindPolygonFeatureForD3(f)
    path(rewound as unknown as GeoJSONFeature & object)
  }
  ctx.fillStyle = style.polyFill
  ctx.fill()
  ctx.lineWidth = style.polyStrokeWidth
  ctx.strokeStyle = style.polyStroke
  ctx.lineJoin = 'round'
  ctx.stroke()

  // ── Graticule grid ────────────────────────────────────────────────────
  ctx.beginPath()
  for (const f of fc.graticule.features) path(f as unknown as GeoJSONFeature & object)
  ctx.lineWidth = style.gridWidth
  ctx.strokeStyle = style.gridStroke
  ctx.lineCap = 'round'
  ctx.stroke()

  // ── Lines (incl. antimeridian crosser) ────────────────────────────────
  // d3 clips line geometry to the projection's clip extent, so an
  // antimeridian crosser wraps as a continuous segment rather than a
  // full-width tear — exactly the invariant the GPU seam must match.
  ctx.beginPath()
  for (const f of fc.lines.features) path(f as unknown as GeoJSONFeature & object)
  ctx.lineWidth = style.lineWidth
  ctx.strokeStyle = style.lineStroke
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.stroke()

  // ── Points as filled discs (geoPath renders Point as a circle of
  //    radius = path.pointRadius()). ─────────────────────────────────────
  path.pointRadius(style.pointRadius)
  ctx.beginPath()
  for (const f of fc.points.features) path(f as unknown as GeoJSONFeature & object)
  ctx.fillStyle = style.pointFill
  ctx.fill()
}
