// Regression spec for #1079 — a feature whose clipped outer ring back-tracks
// on a tile boundary and is split into N DISJOINT sub-outers must be emitted
// as N SEPARATE RingPolygons in `tile.polygons`, one per piece, NOT flattened
// into a single entry holding all N outers + their holes.
//
// Why it matters (the extrusion bug): the runtime consumer
// generateWallMeshExtrudedECEF (map/src/core/polygon-mesh.ts) treats each
// RingPolygon's rings[0] as THE outer and rings[1..] as holes. When the tiler
// flattened N sub-outers into one entry `rings = [outerA, holeA, outerB, ...]`,
// the consumer earcut-punched pieces #2..N out of piece #1's roof — n pieces
// rendered only n-1 roofs, deterministic at every zoom. The fix emits one
// RingPolygon per piece so each sub-outer roofs independently.
//
// Canonical witness (same as korea-z7-hole-distribution.test.ts): Natural
// Earth South Korea + a hole at z=7 tile (108,49). The hole makes earcut on
// the single S-H ring overlap (needsBacktrackRepair fires), so
// splitBoundaryBacktracks fragments the outer into TWO sub-outers and the hole
// is bucketed into the southern one — the exact else-branch #1079 fixes.
//
// FAIL-BEFORE: tile.polygons.length === 1 (single flattened entry, rings=3).
// PASS-AFTER: tile.polygons.length === 2 — {rings:2} (sub-outer + hole) and
// {rings:1} (bare sub-outer); total rings still 3 (nothing lost/duplicated).
//
// Both producer sites are exercised: compileSingleTile (→ polygon-tiler.ts
// tilePolygonPart, the runtime single-tile path) and compileGeoJSONToTiles
// (→ vector-tiler.ts processZoomLevelShared, the build-time pyramid path).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { decomposeFeatures, compileSingleTile, compileGeoJSONToTiles } from '../tiler/vector-tiler'
import type { GeoJSONFeature } from '../tiler/geojson-types'

const HERE = dirname(fileURLToPath(import.meta.url))
const NE_110M = join(
  HERE,
  '..',
  '..',
  '..',
  'playground',
  'public',
  'data',
  'ne_110m_countries.geojson',
)

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

// Web-Mercator-metre → lon/lat inverse, so the witness hole is specified in
// the same tile-Mercator frame the splitter works in (identical to the
// korea-z7-hole-distribution witness).
const R = 6378137
function mmToLonLat(mx: number, my: number): [number, number] {
  return [
    (mx / R) * (180 / Math.PI),
    (2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) * (180 / Math.PI),
  ]
}

// Hole body inside the SOUTHERN sub-outer, hole[0] spiking into the gap
// between the two sub-outers — the shape that makes the donut path split.
const HOLE_MM: ReadonlyArray<readonly [number, number]> = [
  [14060000, 4440000],
  [14052000, 4396000],
  [14078000, 4392000],
  [14080000, 4410000],
  [14055000, 4410000],
  [14060000, 4440000],
]

function makeDonut(): GeoJSONFeature {
  const south = loadSouthKorea()
  const hole = HOLE_MM.map(([mx, my]) => mmToLonLat(mx, my))
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [south, hole] },
  }
}

// Shared assertions on the emitted `polygons` of a tile that split into two
// disjoint pieces (one carrying the bucketed hole, one bare).
function expectTwoSeparatePieces(
  polygons: ReadonlyArray<{ rings: number[][][]; featId: number }> | undefined,
): void {
  expect(polygons, 'tile.polygons present').toBeDefined()
  const polys = polygons!

  // Core #1079 invariant: two SEPARATE entries, not one flattened entry.
  expect(polys.length).toBe(2)

  // The single source feature is index 0; BOTH pieces must carry that featId
  // so the runtime's featId-keyed heights/bases Map resolves them (see below).
  expect(polys.every((p) => p.featId === 0)).toBe(true)

  // Geometry preserved, nothing lost or duplicated: the split produced 2
  // sub-outers and the hole survived, distributed to exactly ONE piece.
  const ringCounts = polys.map((p) => p.rings.length).sort()
  expect(ringCounts).toEqual([1, 2]) // one bare sub-outer + one sub-outer-with-hole
  const totalRings = polys.reduce((a, p) => a + p.rings.length, 0)
  expect(totalRings).toBe(3) // 2 sub-outers + 1 hole

  // "Matching parallel heights": heights/bases are keyed by featId (a Map,
  // NOT an array index-parallel to `polygons`), so both emitted pieces —
  // sharing featId 0 — resolve the SAME per-feature height. This is why the
  // fix needs no per-piece height duplication.
  const heights = new Map<number, number>([[0, 42]])
  for (const p of polys) expect(heights.get(p.featId)).toBe(42)
}

describe('#1079 — clip-split feature emits one RingPolygon PER disjoint piece', () => {
  it('compileSingleTile (polygon-tiler.ts) — Korea z7 (108,49) donut splits into 2 entries', () => {
    const tile = compileSingleTile(decomposeFeatures([makeDonut()]), 7, 108, 49, 7)
    expect(tile).not.toBeNull()
    expectTwoSeparatePieces(tile!.polygons)
  })

  it('compileGeoJSONToTiles (vector-tiler.ts pyramid) — Korea z7 (108,49) donut splits into 2 entries', () => {
    const set = compileGeoJSONToTiles(
      { type: 'FeatureCollection', features: [makeDonut()] },
      { minZoom: 7, maxZoom: 7 },
    )
    const level = set.levels.find((l) => l.zoom === 7)
    expect(level, 'z7 level present').toBeDefined()
    let tile108x49: { rings: number[][][]; featId: number }[] | undefined
    for (const t of level!.tiles.values()) {
      if (t.x === 108 && t.y === 49 && t.polygons) tile108x49 = t.polygons
    }
    expectTwoSeparatePieces(tile108x49)
  })
})
