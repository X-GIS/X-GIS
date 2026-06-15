// Regression spec for BUG T4 — a polygon hole SILENTLY DROPPED by the
// post-clip hole-distribution loop in `compileSingleTile` (and the
// pyramid `tileLevel`) whenever the outer ring back-tracks on a tile
// boundary and gets split into multiple sub-outers.
//
// Pathology: after `splitBoundaryBacktracks` fragments the clipped outer
// into `effectiveOuters`, holes were assigned by testing ONLY `hole[0]`
// with `pointInRing` + `break` and NO `else`. A hole whose FIRST vertex
// lands in a concavity BETWEEN sub-outers (or in a region the split cut
// away) matched no sub-outer and was silently omitted — the fill then
// painted over the cutout.
//
// Canonical witness (the refuter's): Natural Earth South Korea at z=7
// tile (108,49). Its clipped outer back-tracks on the east tile edge and
// `splitBoundaryBacktracks` yields TWO sub-outers separated by a Y-gap
// (a southern blob y<=4414946 m and a northern blob y>=4476354 m in tile
// Mercator metres). A hole placed with its BODY inside the southern
// sub-outer but its FIRST vertex spiking up into that gap is exterior to
// BOTH sub-outers → the old code dropped it.
//
// The fix (`assignHoleBucket`) falls back from hole[0] → centroid → any
// hole vertex → largest sub-outer, so every surviving hole lands in
// exactly one bucket.
//
// PROVED fail-before (pre-fix): solid==donut==12 indices (hole erased)
// and the emitted polygon carries only the 2 sub-outer rings (no hole).
// Post-fix: donut=30 > solid=12 AND the hole ring is present (3 rings).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { decomposeFeatures, compileSingleTile } from '../tiler/vector-tiler'
import type { GeoJSONFeature } from '../tiler/geojson-types'

const HERE = dirname(fileURLToPath(import.meta.url))
const NE_110M = join(HERE, '..', '..', '..', 'playground', 'public', 'data', 'ne_110m_countries.geojson')

interface FeatureCol {
  features: Array<{
    properties: { NAME?: string; name?: string }
    geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: number[][][] | number[][][][] }
  }>
}

function loadSouthKorea(): number[][] {
  const fc = JSON.parse(readFileSync(NE_110M, 'utf8')) as FeatureCol
  for (const f of fc.features) {
    const n = f.properties.NAME ?? f.properties.name ?? ''
    if (n === 'South Korea' && f.geometry.type === 'Polygon') {
      return (f.geometry.coordinates as number[][][])[0]!
    }
  }
  throw new Error('South Korea polygon not found in ne_110m fixture')
}

// Web-Mercator-metre → lon/lat inverse. Lets us specify the witness hole
// in the SAME tile-Mercator frame the splitter works in, so its geometry
// (body inside the southern sub-outer, hole[0] in the inter-sub-outer
// gap) is exact and self-documenting.
const R = 6378137
function mmToLonLat(mx: number, my: number): [number, number] {
  return [
    (mx / R) * (180 / Math.PI),
    (2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) * (180 / Math.PI),
  ]
}

// Hole (tile-Mercator metres): body squarely inside the SOUTHERN
// sub-outer (y∈[4383205,4414946]), with hole[0] spiking UP to y=4440000
// — inside the Y-gap between the two sub-outers and therefore exterior to
// BOTH. This is the exact shape that the single-vertex test dropped.
const HOLE_MM: ReadonlyArray<readonly [number, number]> = [
  [14060000, 4440000], // hole[0] — spike tip in the inter-sub-outer gap
  [14052000, 4396000],
  [14078000, 4392000],
  [14080000, 4410000],
  [14055000, 4410000],
  [14060000, 4440000],
]

function holeLonLat(): number[][] {
  return HOLE_MM.map(([mx, my]) => mmToLonLat(mx, my))
}

describe('BUG T4 — boundary-split hole distribution never drops a hole', () => {
  it('Korea z7 (108,49): a hole whose hole[0] is exterior to all sub-outers survives the split', () => {
    const south = loadSouthKorea()
    const hole = holeLonLat()

    const donut: GeoJSONFeature = {
      type: 'Feature', properties: {},
      geometry: { type: 'Polygon', coordinates: [south, hole] },
    }
    const solid: GeoJSONFeature = {
      type: 'Feature', properties: {},
      geometry: { type: 'Polygon', coordinates: [south] },
    }

    const donutTile = compileSingleTile(decomposeFeatures([donut]), 7, 108, 49, 7)
    const solidTile = compileSingleTile(decomposeFeatures([solid]), 7, 108, 49, 7)
    expect(donutTile).not.toBeNull()
    expect(solidTile).not.toBeNull()

    const solidIndices = solidTile!.indices.length
    const donutIndices = donutTile!.indices.length

    // Sanity: this tile really does exercise the multi-sub-outer split
    // (the South Korea outer back-tracks on the east edge at z7 108,49).
    // The solid polygon tessellates to the canonical 12 indices (4
    // triangles across the two split sub-outers).
    expect(solidIndices).toBe(12)

    // FAIL-BEFORE: pre-fix the hole was dropped → the donut triangulated
    // identically to the solid (12 === 12). Post-fix the retained hole is
    // earcut-carved into the southern sub-outer, producing MORE indices.
    expect(donutIndices).toBeGreaterThan(solidIndices)

    // And the emitted polygon ring set must INCLUDE the hole ring. Solid
    // emits 2 rings (the two sub-outers); the donut must emit 3 (two
    // sub-outers + the surviving hole). Pre-fix it emitted only 2.
    const solidRingCount = (solidTile!.polygons ?? []).reduce((a, p) => a + p.rings.length, 0)
    const donutRingCount = (donutTile!.polygons ?? []).reduce((a, p) => a + p.rings.length, 0)
    expect(solidRingCount).toBe(2)
    expect(donutRingCount).toBe(solidRingCount + 1)
  })
})
