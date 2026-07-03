// Diagnostic: pin the numeric mismatch between Mercator-space tile
// (z/x/y) — which the non-Mercator selector at
// vector-tile-renderer.ts:2533 uses regardless of actual projection —
// and obliqueMercator's actual visual bounds.
//
// User report 2026-05-18 (memory note project_projection_issues_2026_05_18 #4):
// "oblique mercator 줌레벨 1이상에서 경도 변경시 타일 깨짐 뒤집히는 이슈".
//
// Root cause (documented at vector-tile-renderer.ts:2533): non-Mercator
// tile selector falls back to Mercator forward/inverse. Pseudocyl
// (equirect / natural_earth) shares Mercator's lon-x linear mapping
// so the tile assignment still maps to a contiguous strip. Oblique
// mercator ROTATES the entire sphere so the centerLon/centerLat
// pivot maps to (0, 0) in projected space — Mercator's tile pyramid
// no longer aligns with what oblique renders.
//
// This test does NOT fix the bug — that's a multi-file change
// threading per-projection forward/inverse through visibleTilesSSE.
// It pins the numeric divergence so the future fix can be verified.

import { describe, expect, it } from 'vitest'
import { mercator, obliqueMercator } from '@xgis/engine'

const EARTH_R = 6378137
const HALF_CIRC = Math.PI * EARTH_R

// Compute Mercator-space tile (z/x/y) that contains (lon, lat).
function mercatorTile(lon: number, lat: number, z: number): [number, number, number] {
  const [x, y] = mercator.forward(lon, lat)
  const n = 1 << z
  // x ∈ [-HALF_CIRC, HALF_CIRC]  → normalized [0, 1]
  const nx = (x + HALF_CIRC) / (2 * HALF_CIRC)
  // y is Web Mercator y. Tile-y inverts (north is y=0).
  const ny = 1 - (y + HALF_CIRC) / (2 * HALF_CIRC)
  const tx = Math.floor(nx * n)
  const ty = Math.floor(ny * n)
  return [z, tx, ty]
}

describe('oblique_mercator vs Mercator-tile-pyramid mismatch (user issue #4)', () => {
  it('camera-center under Mercator-tile picks DIFFERENT tile than oblique projection center', () => {
    // Oblique projection centered at Seoul (lon=126.97, lat=37.57).
    const cLon = 126.97
    const cLat = 37.57
    const proj = obliqueMercator(cLon, cLat)

    // Under oblique projection, the center MUST land at (0, 0).
    const [ox, oy] = proj.forward(cLon, cLat)
    expect(Math.abs(ox)).toBeLessThan(1e-6)
    expect(Math.abs(oy)).toBeLessThan(1e-6)

    // But the Mercator-tile selector uses mercator.forward(cLon, cLat),
    // which gives a non-zero (x, y) and a tile far from tile-pyramid
    // origin.
    const [mx, my] = mercator.forward(cLon, cLat)
    expect(Math.abs(mx)).toBeGreaterThan(HALF_CIRC * 0.3) // 126° lon is way off Mercator-zero
    expect(Math.abs(my)).toBeGreaterThan(0)

    // Resulting Mercator tile at z=2 is NOT (z=2, x=2, y=2) — the
    // center tile of the pyramid — but somewhere east + north.
    const [, tx, ty] = mercatorTile(cLon, cLat, 2)
    // z=2 has 4×4 = 16 tiles. Center tiles are x∈[1,2], y∈[1,2].
    // Seoul (126.97, 37.57) → tile (z=2, x=3, y=1).
    expect(tx).toBe(3)
    expect(ty).toBe(1)
    // Oblique selector "thinks" the camera-center tile is (3, 1) at
    // z=2 in the Mercator pyramid, but the actual visible content is
    // the (0, 0)-centered rotated frame. Wrong tiles fetched.
  })

  it('pan changes oblique center: same tile-pyramid coords but DIFFERENT visual region', () => {
    // Pan: change centerLon from 0 → 90 → 180. Each pan re-creates
    // the projection with a new lam0. Same (lon, lat) sample point
    // now maps to a DIFFERENT (x, y) in projected space.
    const sampleLon = 30
    const sampleLat = 20

    const obliqueAt0 = obliqueMercator(0, 0)
    const obliqueAt90 = obliqueMercator(90, 0)
    const obliqueAt180 = obliqueMercator(180, 0)

    const [x0] = obliqueAt0.forward(sampleLon, sampleLat)
    const [x90] = obliqueAt90.forward(sampleLon, sampleLat)
    const [x180] = obliqueAt180.forward(sampleLon, sampleLat)

    // 90° centerLon shift moves the projected x by ~quarter circumference.
    expect(Math.abs(x90 - x0)).toBeGreaterThan(HALF_CIRC * 0.4)
    expect(Math.abs(x180 - x0)).toBeGreaterThan(HALF_CIRC * 0.4)

    // BUT mercator.forward (which the selector uses) is INDEPENDENT
    // of camera center — same sample → same Mercator tile every time.
    const [mxA] = mercator.forward(sampleLon, sampleLat)
    const [mxB] = mercator.forward(sampleLon, sampleLat)
    expect(mxA).toBe(mxB)

    // This is the bug: selector assigns the sample to the same
    // Mercator tile regardless of camera pan, but oblique renders it
    // in three different visual locations. Result: pan past z=1
    // shows stale tiles flipped/displaced.
  })

  it('oblique forward+inverse round-trip preserves position (math is internally consistent)', () => {
    // Sanity: the bug is NOT in obliqueMercator's own math — it's a
    // contract violation at the selector boundary.
    const proj = obliqueMercator(45, 20)
    const samples: Array<[number, number]> = [
      [45, 20],
      [50, 25],
      [40, 15],
      [60, 10],
      [30, 30],
    ]
    for (const [lon, lat] of samples) {
      const [x, y] = proj.forward(lon, lat)
      const [lon2, lat2] = proj.inverse(x, y)
      expect(Math.abs(lon - lon2)).toBeLessThan(0.001)
      expect(Math.abs(lat - lat2)).toBeLessThan(0.001)
    }
  })

  it('mercator-tile inverse is meaningless under oblique frame (decoded lon/lat differs from projected lon/lat)', () => {
    // The selector path: tile (z,x,y) → mercator.inverse → lon/lat
    // → pass to renderer. Under oblique, the renderer then runs
    // oblique.forward on that lon/lat. The result is NOT where the
    // selector "thought" the tile would be.
    const proj = obliqueMercator(90, 30)
    const z = 2
    const tx = 2
    const ty = 2

    // Mercator-decoded lon/lat for the center of this tile.
    const n = 1 << z
    const nx = (tx + 0.5) / n
    const ny = (ty + 0.5) / n
    const mercatorX = nx * 2 * HALF_CIRC - HALF_CIRC
    const mercatorY = (1 - ny) * 2 * HALF_CIRC - HALF_CIRC
    const [tileLon, tileLat] = mercator.inverse(mercatorX, mercatorY)

    // What renderer actually draws at this lon/lat under oblique.
    const [ox, oy] = proj.forward(tileLon, tileLat)

    // The renderer draws this tile at (ox, oy) ≠ (mercatorX, mercatorY).
    // Selector picked the tile believing it would land at
    // (mercatorX, mercatorY) — but oblique places it elsewhere.
    const dx = Math.abs(ox - mercatorX)
    const dy = Math.abs(oy - mercatorY)
    // For oblique centered at (90, 30), the mismatch is huge —
    // sphere rotation by 90° lon + 30° lat ≠ identity.
    expect(dx + dy).toBeGreaterThan(HALF_CIRC * 0.1)
  })
})
