// Regression spec for the South Korea z=7 fan-cut triangulation bug
// reported 2026-05-13. clipPolygonToRect (Sutherland-Hodgman) emits a
// single ring even when the input polygon enters/exits the clip rect
// multiple times — the boundary "stitches" back-track over each
// other, producing a self-intersecting ring earcut renders as
// overlapping triangles. ne_110m_countries South Korea on tile
// (108,49,7) is the canonical fixture: 8-vertex output with v1→v2
// (north on east edge) overlapping v5→v6 (south on east edge) →
// earcut emits 4 triangles with 256.73 % triangle-area coverage.
//
// `splitBoundaryBacktracks` in clip.ts detects opposing-direction
// segments on the same rect edge and splits the ring into clean
// sub-rings. This spec verifies:
//   - tile (108,49,7): repair takes 256.73 % → 100 % coverage
//   - all other Korea-z=7 tiles are pass-through (already 100 %)
//   - North Korea multipolygon parts also clip cleanly
//
// IMPORTANT: the source ne_110m South Korea polygon itself has
// ZERO self-crossings (it's a clean CW ring). The pathology is
// entirely on the clipper output side, which is why a fix on
// post-clip rings is the right place to intervene.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import earcut from 'earcut'
import { clipPolygonToRect, splitBoundaryBacktracks } from '../tiler/clip'
import { lonLatToMercF64 } from '../tiler/vector-tiler'
import { precisionForZoomMM } from '../tiler/encoding'

const HERE = dirname(fileURLToPath(import.meta.url))
const NE_110M = join(HERE, '..', '..', '..', 'playground', 'public', 'data', 'ne_110m_countries.geojson')

interface FeatureCol {
  features: Array<{
    properties: { NAME?: string; name?: string }
    geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: number[][][] | number[][][][] }
  }>
}

function loadKorea(): { south: number[][]; north: number[][][] } {
  const fc = JSON.parse(readFileSync(NE_110M, 'utf8')) as FeatureCol
  let south: number[][] | null = null
  let north: number[][][] | null = null
  for (const f of fc.features) {
    const n = f.properties.NAME ?? f.properties.name ?? ''
    if (n === 'South Korea' && f.geometry.type === 'Polygon') {
      south = (f.geometry.coordinates as number[][][])[0]!
    }
    if (n === 'North Korea' && f.geometry.type === 'MultiPolygon') {
      north = (f.geometry.coordinates as number[][][][]).map(p => p[0]!)
    }
  }
  return { south: south!, north: north! }
}

function ringArea(ring: number[][]): number {
  let s = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    s += (ring[j]![0] - ring[i]![0]) * (ring[j]![1] + ring[i]![1])
  }
  return s / 2
}

function tileBoundsMM(z: number, x: number, y: number): { w: number; s: number; e: number; n: number } {
  const N = 2 ** z
  const tileLon = (xi: number): number => (xi / N) * 360 - 180
  const tileLat = (yi: number): number => {
    const ny = Math.PI * (1 - 2 * yi / N)
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(ny) - Math.exp(-ny)))
  }
  const [w, s] = lonLatToMercF64(tileLon(x), tileLat(y + 1))
  const [e, n2] = lonLatToMercF64(tileLon(x + 1), tileLat(y))
  return { w, s, e, n: n2 }
}

function projectToMM(ring: number[][]): number[][] {
  return ring.map(([lon, lat]) => {
    const [mx, my] = lonLatToMercF64(lon!, lat!)
    return [mx, my]
  })
}

function earcutAreaCoverage(rings: number[][][]): number {
  const flat: number[] = []
  const holes: number[] = []
  for (let r = 0; r < rings.length; r++) {
    if (r > 0) holes.push(flat.length / 2)
    for (const c of rings[r]!) flat.push(c[0]!, c[1]!)
  }
  const idx = earcut(flat, holes.length > 0 ? holes : undefined)
  let triAreaSum = 0
  for (let t = 0; t < idx.length; t += 3) {
    const i0 = idx[t]! * 2, i1 = idx[t + 1]! * 2, i2 = idx[t + 2]! * 2
    const ax = flat[i0]!, ay = flat[i0 + 1]!
    const bx = flat[i1]!, by = flat[i1 + 1]!
    const cx = flat[i2]!, cy = flat[i2 + 1]!
    triAreaSum += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) * 0.5
  }
  const ringAreaSum = rings.reduce((s, r) => s + Math.abs(ringArea(r)), 0)
  return ringAreaSum > 0 ? triAreaSum / ringAreaSum : 0
}

const KOREA_Z7_TILES = [
  { x: 107, y: 49 }, { x: 108, y: 49 }, { x: 109, y: 49 },
  { x: 107, y: 50 }, { x: 108, y: 50 }, { x: 109, y: 50 },
] as const

describe('clip back-track repair — Korea z=7 regression', () => {
  it('without repair: tile (108,49,7) has 256 % triangle overlap on South Korea', () => {
    const { south } = loadKorea()
    const ringMM = projectToMM(south)
    const tb = tileBoundsMM(7, 108, 49)
    const clipped = clipPolygonToRect([ringMM], tb.w, tb.s, tb.e, tb.n, precisionForZoomMM(7))
    expect(clipped.length).toBeGreaterThan(0)
    const coverage = earcutAreaCoverage(clipped)
    // Pin the bug as a hard upper-bound check — any future clipper
    // change that fixes the underlying issue (so this test would
    // fall to 100 %) should land its own assertion.
    expect(coverage).toBeGreaterThan(2)
  })

  it('with repair: tile (108,49,7) renders with 100 % triangle coverage', () => {
    const { south } = loadKorea()
    const ringMM = projectToMM(south)
    const tb = tileBoundsMM(7, 108, 49)
    const clipped = clipPolygonToRect([ringMM], tb.w, tb.s, tb.e, tb.n, precisionForZoomMM(7))
    const repaired = clipped.flatMap(r => splitBoundaryBacktracks(r, tb.w, tb.s, tb.e, tb.n))
    // Earcut each repaired sub-ring separately (they represent
    // disconnected interior components — same dispatch the production
    // path uses in compileSingleTile.tessellatePolygonToArrays).
    let triArea = 0, ringArea_ = 0
    for (const sub of repaired) {
      triArea += earcutAreaCoverage([sub]) * Math.abs(ringArea(sub))
      ringArea_ += Math.abs(ringArea(sub))
    }
    const coverage = ringArea_ > 0 ? triArea / ringArea_ : 0
    expect(repaired.length).toBeGreaterThanOrEqual(2)  // split happened
    expect(coverage).toBeCloseTo(1.0, 2)
  })

  it('repair is a no-op for tiles that already produce clean clip output', () => {
    const { south } = loadKorea()
    const ringMM = projectToMM(south)
    const cleanTiles = [{ x: 109, y: 49 }, { x: 108, y: 50 }, { x: 109, y: 50 }]
    for (const tk of cleanTiles) {
      const tb = tileBoundsMM(7, tk.x, tk.y)
      const clipped = clipPolygonToRect([ringMM], tb.w, tb.s, tb.e, tb.n, precisionForZoomMM(7))
      if (clipped.length === 0) continue
      const repaired = clipped.flatMap(r => splitBoundaryBacktracks(r, tb.w, tb.s, tb.e, tb.n))
      expect(repaired.length, `tile (${tk.x},${tk.y},7) should not split`).toBe(clipped.length)
    }
  })

  it('North Korea multipolygon clips cleanly across all Korea-z=7 tiles', () => {
    const { north } = loadKorea()
    for (let pi = 0; pi < north.length; pi++) {
      const ringMM = projectToMM(north[pi]!)
      for (const tk of KOREA_Z7_TILES) {
        const tb = tileBoundsMM(7, tk.x, tk.y)
        const clipped = clipPolygonToRect([ringMM], tb.w, tb.s, tb.e, tb.n, precisionForZoomMM(7))
        if (clipped.length === 0) continue
        const repaired = clipped.flatMap(r => splitBoundaryBacktracks(r, tb.w, tb.s, tb.e, tb.n))
        for (const sub of repaired) {
          const coverage = earcutAreaCoverage([sub])
          expect(coverage,
            `NK polygon ${pi} tile (${tk.x},${tk.y},7) sub-ring coverage`,
          ).toBeCloseTo(1.0, 1)
        }
      }
    }
  })
})
