import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { Camera } from '../engine/camera'
import { visibleTilesFrustum, firstIndexedAncestor } from '../loader/tiles'
import { mercator } from '../engine/projection'
import { XGVTSource } from '../data/xgvt-source'
import {
  compileGeoJSONToTiles, decomposeFeatures, tileKey, tileKeyUnpack,
} from '@xgis/compiler'
import type { GeoJSONFeatureCollection } from '@xgis/compiler'

// THROUGHPUT CONVERGENCE at high-pitch frustum loads.
//
// Memory (project_tile_pitch_matrix.md) says the ROOT cause of the
// user's "tiles don't load at pitch=84" bug is the per-frame
// compile/sub-tile budget, not selection math — all 273 frustum
// tiles ARE selected correctly (prior tests confirmed), but the
// budget of 4 compiles + 8 sub-tiles per frame cannot absorb them in
// reasonable time.
//
// This test measures the concrete convergence cost: starting from a
// cold source (only z=0 pre-compiled), how many "frames" does it
// take to satisfy every frustum tile's draw-path contract? A frame
// here = one `resetCompileBudget` + one pass through the tile list
// calling compileTileOnDemand/generateSubTile per tile.
//
// Target: converge in ≤ 20 frames (≈ 333 ms at 60 fps). Reaching the
// 60-frame mark (≈ 1 s) means the user perceives sustained lag.

const __dirname = dirname(fileURLToPath(import.meta.url))
const COUNTRIES_PATH = resolve(__dirname, '../../../playground/public/data/countries.geojson')

const W = 1024
const H = 768

const BUG = {
  zoom: 10.29,
  lat: 30.94565,
  lon: 117.95751,
  bearing: 359.5,
  pitch: 84.0,
} as const

function makeBugCam(): Camera {
  const c = new Camera(BUG.lon, BUG.lat, BUG.zoom)
  c.pitch = BUG.pitch
  c.bearing = BUG.bearing
  return c
}

let countries: GeoJSONFeatureCollection | null = null
function loadCountries(): GeoJSONFeatureCollection {
  if (countries) return countries
  countries = JSON.parse(readFileSync(COUNTRIES_PATH, 'utf8')) as GeoJSONFeatureCollection
  return countries
}

/** Build a source whose state mirrors "just finished initial load":
 *  z=0 tile pre-compiled + raw parts ready for on-demand compile at
 *  any deeper zoom. Same setup as tile-real-data-coverage.test.ts. */
function coldSource(): XGVTSource {
  const gj = loadCountries()
  const parts = decomposeFeatures(gj.features)
  const set = compileGeoJSONToTiles(gj, { minZoom: 0, maxZoom: 0 })
  const source = new XGVTSource()
  source.addTileLevel(set.levels[0], set.bounds, set.propertyTable)
  source.setRawParts(parts, 22)
  return source
}

/** Run N "frames": each frame resets budgets + iterates the target
 *  tile set calling compileTileOnDemand. Returns frame count at which
 *  every tile was satisfied, or maxFrames if not converged. */
function simulateConvergence(
  source: XGVTSource,
  tileKeys: number[],
  maxFrames: number,
): { framesToConverge: number; readyPerFrame: number[]; finalReady: number } {
  const readyPerFrame: number[] = []
  for (let frame = 1; frame <= maxFrames; frame++) {
    source.resetCompileBudget()
    for (const key of tileKeys) {
      if (source.getTileData(key)) continue
      source.compileTileOnDemand(key)
    }
    let ready = 0
    for (const key of tileKeys) if (source.getTileData(key)) ready++
    readyPerFrame.push(ready)
    if (ready === tileKeys.length) {
      return { framesToConverge: frame, readyPerFrame, finalReady: ready }
    }
  }
  const finalReady = readyPerFrame[readyPerFrame.length - 1] ?? 0
  return { framesToConverge: -1, readyPerFrame, finalReady }
}

// ═══════════════════════════════════════════════════════════════════
// Phase 1: Baseline — pitch=0 at bug lat/lon/zoom
// ═══════════════════════════════════════════════════════════════════

describe('Throughput convergence: baseline (pitch=0)', () => {
  it('at pitch=0 zoom=10.29, convergence is fast (few frames)', () => {
    const cam = new Camera(BUG.lon, BUG.lat, BUG.zoom)
    cam.pitch = 0
    const tiles = visibleTilesFrustum(cam, mercator, Math.round(BUG.zoom), W, H)
    const tileKeys = tiles.map(t => tileKey(t.z, t.x, t.y))

    const source = coldSource()
    const { framesToConverge, finalReady } = simulateConvergence(source, tileKeys, 30)
    console.log(
      `[throughput pitch=0] ${tileKeys.length} tiles → converged in ${framesToConverge} frames ` +
      `(final ready=${finalReady})`,
    )
    // Baseline expectation: low-tile-count flat-camera viewport
    // should finish in well under 20 frames.
    expect(framesToConverge).toBeGreaterThan(0)
    expect(framesToConverge).toBeLessThanOrEqual(20)
  })
})

// ═══════════════════════════════════════════════════════════════════
// Phase 2: Bug URL — pitch=84
// ═══════════════════════════════════════════════════════════════════

describe('Throughput convergence: bug URL (pitch=84)', () => {
  it('at the exact bug URL, convergence frame count is recorded', () => {
    const cam = makeBugCam()
    const tiles = visibleTilesFrustum(cam, mercator, Math.round(BUG.zoom), W, H)
    const tileKeys = tiles.map(t => tileKey(t.z, t.x, t.y))

    const source = coldSource()
    const { framesToConverge, readyPerFrame, finalReady } = simulateConvergence(source, tileKeys, 100)
    console.log(
      `[throughput pitch=84 bug URL] ${tileKeys.length} tiles → ` +
      (framesToConverge > 0
        ? `converged in ${framesToConverge} frames`
        : `NOT CONVERGED after 100 frames (${finalReady}/${tileKeys.length} ready)`),
    )
    console.log(
      `[throughput pitch=84 bug URL] per-frame ready: ${readyPerFrame.slice(0, 10).join(', ')}` +
      (readyPerFrame.length > 10 ? `, ... (${readyPerFrame.length} frames total)` : ''),
    )
    expect(framesToConverge, 'never converged in 100 frames').toBeGreaterThan(0)
  })

  it('convergence happens in ≤ 60 frames (≈ 1 s @ 60 fps)', () => {
    const cam = makeBugCam()
    const tiles = visibleTilesFrustum(cam, mercator, Math.round(BUG.zoom), W, H)
    const tileKeys = tiles.map(t => tileKey(t.z, t.x, t.y))

    const source = coldSource()
    const { framesToConverge } = simulateConvergence(source, tileKeys, 60)
    // 60 frames = 1 second at 60 fps. If convergence takes longer,
    // the user perceives sustained "tiles still loading" during
    // camera motion — which is the reported symptom.
    expect(
      framesToConverge,
      `convergence took more than 60 frames — user-perceived "no tiles loading"`,
    ).toBeGreaterThan(0)
    expect(framesToConverge).toBeLessThanOrEqual(60)
  })

  it('fast convergence target: ≤ 20 frames (333 ms @ 60 fps)', () => {
    // Raw-parts convergence at the bug URL. Initially (count-based
    // budget) this took ~60 frames. The time-based hybrid budget
    // brought it to ~57, and the polygon-fill/stroke outline fix
    // (using clipped rings = smaller input to augmentRingWithArc)
    // dropped it further to ~19 frames. That's below the fast-
    // target threshold, so the test now asserts it as a standing
    // invariant. A regression past 20 frames signals either the
    // compile budget was lowered or the outline pipeline got
    // heavier.
    const cam = makeBugCam()
    const tiles = visibleTilesFrustum(cam, mercator, Math.round(BUG.zoom), W, H)
    const tileKeys = tiles.map(t => tileKey(t.z, t.x, t.y))

    const source = coldSource()
    const { framesToConverge } = simulateConvergence(source, tileKeys, 30)
    expect(framesToConverge, 'fast-target: needs ≤ 20 frames').toBeGreaterThan(0)
    expect(framesToConverge).toBeLessThanOrEqual(20)
  })
})

// ═══════════════════════════════════════════════════════════════════
// Phase 3: Pitch sweep — does convergence time monotonically worsen?
// ═══════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════
// Phase 4: XGVT sub-tile path — where time budget pays off
// ═══════════════════════════════════════════════════════════════════
//
// The tests above use setRawParts + compileTileOnDemand, where each
// compile is heavy (5–20 ms). The user's actual bug flows through the
// XGVT sub-tile path: generateSubTile clips a parent's vertex buffer
// into a sub-tile region in microseconds at high zoom. This path was
// gated at 8 sub-tiles/frame pre-fix (10–100× the actual work cost)
// and is what the 6-ms time budget was designed to unblock.

describe('Throughput convergence: XGVT sub-tile path (the user-bug path)', () => {
  // Use ne_110m_land.geojson — the equivalent of ne_110m_land.xgvt
  // that physical_map_50m actually loads. It's ~15 KB with coarse
  // coastlines; each z=3→z=10 sub-tile clip is µs-scale, exactly the
  // workload profile the time-budget design targets. (Using
  // countries.geojson here would put each clip at ms-scale and mask
  // the time-budget improvement behind per-call cost.)
  const LAND_GEOJSON = resolve(__dirname, '../../../playground/public/data/ne_110m_land.geojson')
  let landCache: GeoJSONFeatureCollection | null = null
  function loadLand(): GeoJSONFeatureCollection {
    if (landCache) return landCache
    landCache = JSON.parse(readFileSync(LAND_GEOJSON, 'utf8')) as GeoJSONFeatureCollection
    return landCache
  }

  /** Build a source whose z=3 level is fully pre-compiled (mirroring a
   *  loaded XGVT ancestor), then leaf-key sub-tiles can be generated
   *  on demand from those z=3 parents. */
  function subTileSource(): XGVTSource {
    const gj = loadLand()
    const set = compileGeoJSONToTiles(gj, { minZoom: 0, maxZoom: 3 })
    const source = new XGVTSource()
    for (const level of set.levels) {
      source.addTileLevel(level, set.bounds, set.propertyTable)
    }
    return source
  }

  /** Filter frustum tiles to only those whose leaf key needs sub-tile
   *  clipping AND whose ancestor is actually in the index. A frustum
   *  tile whose parent-chain bottoms out with no match corresponds to
   *  ocean / no-data regions — the renderer simply skips those in
   *  production, and we should too in this test (otherwise the
   *  convergence loop waits forever for tiles that never had data). */
  function reachableSubTileKeys(source: XGVTSource, tiles: ReturnType<typeof visibleTilesFrustum>): number[] {
    const idx = source.getIndex()
    if (!idx) return []
    const out: number[] = []
    for (const t of tiles) {
      const key = tileKey(t.z, t.x, t.y)
      if (idx.entryByHash.has(key)) continue // direct hit: no sub-tile needed
      const anc = firstIndexedAncestor(key, k => idx.entryByHash.has(k))
      if (anc === -1) continue // no ancestor: ocean, skip
      out.push(key)
    }
    return out
  }

  /** Frame-loop simulation for the sub-tile path: reset budget, walk
   *  each target tile, find its ancestor, call generateSubTile. */
  function simulateSubTileConvergence(
    source: XGVTSource,
    leafKeys: number[],
    maxFrames: number,
  ): { frames: number; finalReady: number } {
    const idx = source.getIndex()
    if (!idx) return { frames: -1, finalReady: 0 }
    for (let frame = 1; frame <= maxFrames; frame++) {
      source.resetCompileBudget()
      for (const key of leafKeys) {
        if (source.getTileData(key)) continue
        const ancestor = firstIndexedAncestor(key, k => idx.entryByHash.has(k))
        if (ancestor === -1) continue
        source.generateSubTile(key, ancestor)
      }
      let ready = 0
      for (const key of leafKeys) if (source.getTileData(key)) ready++
      if (ready === leafKeys.length) return { frames: frame, finalReady: ready }
    }
    let finalReady = 0
    for (const key of leafKeys) if (source.getTileData(key)) finalReady++
    return { frames: -1, finalReady }
  }

  it('bug URL: reachable sub-tiles converge in ≤ 10 frames (was ~35 with 8/frame cap)', () => {
    const cam = makeBugCam()
    const tiles = visibleTilesFrustum(cam, mercator, Math.round(BUG.zoom), W, H)
    const source = subTileSource()
    const leafKeys = reachableSubTileKeys(source, tiles)

    const { frames, finalReady } = simulateSubTileConvergence(source, leafKeys, 30)
    console.log(
      `[sub-tile pitch=84] ${leafKeys.length} reachable leaves → ` +
      (frames > 0 ? `converged in ${frames} frames` : `NOT converged (${finalReady} ready)`),
    )
    // With the hybrid time budget (6 ms wall-clock after an 8-call
    // floor), microsecond-scale high-zoom sub-tile clips complete
    // many more per frame than the old 8-cap allowed. Target ≤ 10
    // frames (167 ms @ 60 fps).
    expect(frames, 'sub-tile convergence not reached within 30 frames').toBeGreaterThan(0)
    expect(frames).toBeLessThanOrEqual(10)
  })

  it('pitch sweep: every pitch converges in ≤ 10 sub-tile frames', { timeout: 30_000 }, () => {
    const rows: Array<{ pitch: number; leaves: number; frames: number }> = []
    for (const pitch of [0, 40, 60, 70, 80, 84, 85]) {
      const cam = new Camera(BUG.lon, BUG.lat, BUG.zoom)
      cam.pitch = pitch
      cam.bearing = BUG.bearing
      const tiles = visibleTilesFrustum(cam, mercator, Math.round(BUG.zoom), W, H)

      const source = subTileSource()
      const leafKeys = reachableSubTileKeys(source, tiles)

      const { frames } = simulateSubTileConvergence(source, leafKeys, 30)
      rows.push({ pitch, leaves: leafKeys.length, frames })
    }
    console.log('[sub-tile pitch sweep]')
    for (const r of rows) {
      console.log(
        `  pitch=${r.pitch.toString().padStart(3)} → ` +
        `${r.leaves.toString().padStart(4)} leaves, ` +
        `${r.frames > 0 ? r.frames.toString().padStart(2) + ' frames' : 'NOT CONVERGED'}`,
      )
    }
    for (const r of rows) {
      expect(r.frames, `pitch=${r.pitch}: did not converge in 30 frames (${r.leaves} leaves)`)
        .toBeGreaterThan(0)
      expect(r.frames, `pitch=${r.pitch}: sub-tile convergence too slow`).toBeLessThanOrEqual(10)
    }
  })
})

describe('Throughput convergence: pitch sweep', () => {
  // 30s timeout: 9 pitches × up to 200 frames × ~10-20ms per frame
  // with cold-source setup = ~18s worst case.
  it('records convergence frames across pitch 0→85', { timeout: 30_000 }, () => {
    const rows: Array<{ pitch: number; tiles: number; frames: number }> = []
    for (const pitch of [0, 20, 40, 60, 70, 75, 80, 84, 85]) {
      const cam = new Camera(BUG.lon, BUG.lat, BUG.zoom)
      cam.pitch = pitch
      cam.bearing = BUG.bearing
      const tiles = visibleTilesFrustum(cam, mercator, Math.round(BUG.zoom), W, H)
      const tileKeys = tiles.map(t => tileKey(t.z, t.x, t.y))

      const source = coldSource()
      const { framesToConverge } = simulateConvergence(source, tileKeys, 200)
      rows.push({ pitch, tiles: tileKeys.length, frames: framesToConverge })
    }
    console.log('[throughput pitch sweep]')
    for (const r of rows) {
      console.log(
        `  pitch=${r.pitch.toString().padStart(3)} → ` +
        `${r.tiles.toString().padStart(4)} tiles, ` +
        `${r.frames > 0 ? r.frames.toString().padStart(3) + ' frames' : 'NOT CONVERGED'}`,
      )
    }
    // Monotonicity assertion: every pitch must at least converge.
    for (const r of rows) {
      expect(r.frames, `pitch=${r.pitch}: did not converge in 200 frames`).toBeGreaterThan(0)
    }
  })
})
