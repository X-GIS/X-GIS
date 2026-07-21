// #1245 — internal-junction continuity across the antimeridian wrap copy.
//
// The #1221 fixture (LineString crossing the antimeridian) is split by the
// geojson-vt wrap into east-copy tiles that render the continuation past +180.
// At z5 the descending run [185,68]→[195,64] crosses the y7/y8 tile boundary
// (lat 66.513). The two tiles that abut there (z5/0/7 south edge, z5/0/8 north
// edge) each carry an INDEPENDENTLY MVT-quantised copy of that run, so their
// boundary-crossing vertices interpolate from differently-rounded bracketing
// vertices and DO NOT coincide — ~1.5 px apart along the seam. Because the
// renderer pre-clips each piece to its exact tile rect with no runtime scissor,
// both terminate as butt ends ON the boundary and the sub-pixel mismatch shows
// as the hairline break the owner reported.
//
// This drives the REAL decode→compile→segment chain (the layer the bug lives
// on) and asserts the two abutting boundary endpoints form a CONTINUOUS stroke:
// each boundary-continuation endpoint must extend OUTWARD past its tile edge
// (the #1245 bridge) rather than butt-terminate exactly on it. Pre-fix the
// endpoints sit on the boundary (bridge == 0) → the assertion fails for the
// right reason (a butt-joint at a non-coincident junction). Post-fix each is
// pushed one tile-pixel past the edge so the abutting pieces overlap.
import { describe, it, expect } from 'vitest'
import { geojsonvt, encodeMVT, decomposeFeatures, compileSingleTile } from '@xgis/compiler'
import { decodeMvtTile } from './mvt-decoder'
import { buildLineSegments, LINE_SEGMENT_STRIDE_F32 as S } from './line-segment-build'

const SEG_R = 6378137
const D2R = Math.PI / 180
const LAT_LIMIT = 85.051129
const clampLat = (v: number) => Math.max(-LAT_LIMIT, Math.min(LAT_LIMIT, v))
const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (clampLat(lat) * D2R) / 2)) * SEG_R

function tileBounds(z: number, x: number, y: number) {
  const n = 2 ** z
  return {
    west: (x / n) * 360 - 180,
    east: ((x + 1) / n) * 360 - 180,
    north: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI,
    south: (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI,
  }
}

interface Endpoint {
  /** tile-local Mercator metres */
  myLocal: number
  mxLocal: number
  /** signed distance PAST the tile's own boundary edge (>0 = extends outward) */
  overshootM: number
  tileHeightMerc: number
  /** RAW boundary crossing (pre-extension compiled vertex), tile-local mx.
   *  Fix-independent — used to prove the two tiles' crossings don't coincide. */
  rawCrossMxLocal: number
  tileWestMerc: number
}

/**
 * Build the real segment buffer for one tile and return, for the chain end that
 * sits on the shared y-boundary at `boundaryLat`, how far it extends past that
 * edge. `edge` picks which of the tile's own edges the boundary is (north edge
 * for the lower tile, south edge for the upper tile).
 */
function boundaryEndpoint(
  z: number,
  x: number,
  y: number,
  edge: 'north' | 'south',
): Endpoint | null {
  const idx = geojsonvt(FIXTURE as never, {})
  const t = idx.getTile(z, x, y)
  if (!t || t.features.length === 0) return null
  const bytes = encodeMVT([{ name: 'route', tile: t }])
  const feats = decodeMvtTile(bytes, z, x, y, {})
  const parts = decomposeFeatures(feats as never)
  const ct = compileSingleTile(parts, z, x, y, 5)
  if (!ct || ct.lineIndices.length === 0) return null

  const tb = tileBounds(z, x, y)
  const tileWestMerc = tb.west * D2R * SEG_R
  const tileEastMerc = tb.east * D2R * SEG_R
  const tileSMerc = mercY(tb.south)
  const tileNMerc = mercY(tb.north)
  const tileWidthMerc = tileEastMerc - tileWestMerc
  const tileHeightMerc = tileNMerc - tileSMerc

  const lv = ct.lineVertices
  const li = ct.lineIndices
  let maxIdx = 0
  for (const v of li) if (v > maxIdx) maxIdx = v
  const stride: 6 | 10 = lv.length / (maxIdx + 1) >= 10 ? 10 : 6

  // RAW crossing: the compiled (pre-buildLineSegments) vertex nearest the
  // shared edge. Independent of the #1245 extension, so it captures the true
  // per-tile quantised crossing longitude.
  const edgeLocalRaw = edge === 'north' ? tileHeightMerc : 0
  let rawCrossMxLocal = NaN
  let rawBest = Infinity
  for (let vi = 0; vi <= maxIdx; vi++) {
    const my = lv[vi * stride + 1] + lv[vi * stride + 3]
    const d = Math.abs(my - edgeLocalRaw)
    if (d < rawBest) {
      rawBest = d
      rawCrossMxLocal = lv[vi * stride] + lv[vi * stride + 2]
    }
  }

  const seg = buildLineSegments(lv, li, stride, tileWidthMerc, tileHeightMerc)
  const nseg = seg.length / S

  // The boundary edge in tile-local metres: north edge = tileHeightMerc, south
  // edge = 0. Find the endpoint (p0 or p1 of any segment) closest to it.
  const edgeLocal = edge === 'north' ? tileHeightMerc : 0
  let best: Endpoint | null = null
  let bestDist = Infinity
  for (let i = 0; i < nseg; i++) {
    const o = i * S
    const ends: [number, number][] = [
      [seg[o] + seg[o + 4], seg[o + 1] + seg[o + 5]], // p0 (mx, my)
      [seg[o + 2] + seg[o + 6], seg[o + 3] + seg[o + 7]], // p1
    ]
    for (const [mx, my] of ends) {
      const dist = Math.abs(my - edgeLocal)
      if (dist < bestDist) {
        bestDist = dist
        // overshoot: how far PAST the edge, outward from the tile interior.
        const overshootM = edge === 'north' ? my - tileHeightMerc : -my
        best = {
          myLocal: my,
          mxLocal: mx,
          overshootM,
          tileHeightMerc,
          rawCrossMxLocal,
          tileWestMerc,
        }
      }
    }
  }
  return best
}

const FIXTURE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: [
          [165, 60],
          [175, 66],
          [185, 68],
          [195, 64],
        ],
      },
    },
  ],
}

describe('#1245 antimeridian wrap-copy internal junction', () => {
  // The two tiles abutting at the z5 y7/y8 boundary (lat 66.513) on the
  // wrapped descending run. z5/0/7 owns the piece above the boundary (its
  // SOUTH edge is the seam); z5/0/8 owns the piece below (its NORTH edge is
  // the seam).
  const upper = boundaryEndpoint(5, 0, 7, 'south')
  const lower = boundaryEndpoint(5, 0, 8, 'north')

  it('both tiles reach the shared y7/y8 boundary', () => {
    expect(upper).not.toBeNull()
    expect(lower).not.toBeNull()
  })

  it('the two crossings are NOT coincident (proves it is a real butt-joint, not already continuous)', () => {
    // Absolute Mercator-x of each crossing. If these coincided there would be
    // no gap and no fix needed; the ~1.5 px offset is exactly the hairline.
    // RAW crossings (pre-extension) in absolute Mercator-x. If these coincided
    // there would be no gap and no fix needed; the offset is the hairline.
    const upAbsMx = upper!.rawCrossMxLocal + upper!.tileWestMerc
    const loAbsMx = lower!.rawCrossMxLocal + lower!.tileWestMerc
    const offsetM = Math.abs(upAbsMx - loAbsMx)
    // z5 tile side ≈ 1.25e6 m ≈ 256 px ⇒ 1 px ≈ 4900 m. The offset is ~1.5 px.
    expect(offsetM).toBeGreaterThan(1000)
  })

  it('each boundary-continuation endpoint extends OUTWARD past its tile edge (bridge)', () => {
    // FAIL-FIRST: pre-fix both endpoints sit ON the boundary (overshoot ≈ 0),
    // so the abutting pieces only touch as non-coincident butt ends → gap.
    // Post-fix each is pushed ~1 tile-pixel past its edge so the pieces overlap.
    const tilePx = lower!.tileHeightMerc / 256
    expect(upper!.overshootM).toBeGreaterThan(tilePx * 0.25)
    expect(lower!.overshootM).toBeGreaterThan(tilePx * 0.25)
  })
})
