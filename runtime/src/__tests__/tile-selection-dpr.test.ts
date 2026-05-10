import { describe, expect, it } from 'vitest'
import { Camera } from '../engine/projection/camera'
import { visibleTilesFrustum, visibleTilesFrustumSampled } from '../data/tile-select'
import { mercator } from '../engine/projection/projection'

// Verifies that DPR is a rasterisation-density concept ONLY — same
// logical viewport (CSS pixels) at DPR=1 vs DPR=3 must select the
// SAME tile set. Anything else is a leaky "load more on retina" sink
// that contradicts how the tile pyramid is anchored (256 CSS px per
// tile, independent of devicePixelRatio).
//
// Each scenario passes:
//   * canvasWidth/Height as device pixels (cssW × dpr) — matches what
//     map.ts feeds in (canvas.width / canvas.height after resizeCanvas).
//   * dpr to the selector so its perceptual knobs (subdivide threshold,
//     budget cap) divide back to CSS-pixel equivalents.

const CSS_W = 430
const CSS_H = 429

function makeCam(zoom: number, pitch: number, bearing: number, lon = -73.95, lat = 40.8): Camera {
  const c = new Camera(lon, lat, zoom)
  c.pitch = pitch
  c.bearing = bearing
  return c
}

function tileKey(t: { z: number; x: number; y: number; ox: number }): string {
  return `${t.z}/${t.x}/${t.y}@${t.ox}`
}

function diff(a: Set<string>, b: Set<string>): { onlyA: string[]; onlyB: string[]; common: number } {
  const onlyA: string[] = []
  const onlyB: string[] = []
  let common = 0
  for (const k of a) (b.has(k) ? common++ : onlyA.push(k))
  for (const k of b) if (!a.has(k)) onlyB.push(k)
  return { onlyA, onlyB, common }
}

describe('tile selection DPR invariance', () => {
  it('visibleTilesFrustum: DPR=1 and DPR=3 produce identical tile set at pitch=43', () => {
    const cam = makeCam(11.5, 43, 29)
    const z = Math.round(cam.zoom)
    const tiles1 = visibleTilesFrustum(cam, mercator, z, CSS_W * 1, CSS_H * 1, 0, 1)
    const tiles3 = visibleTilesFrustum(cam, mercator, z, CSS_W * 3, CSS_H * 3, 0, 3)
    const set1 = new Set(tiles1.map(tileKey))
    const set3 = new Set(tiles3.map(tileKey))
    const d = diff(set1, set3)
    if (d.onlyA.length || d.onlyB.length) {
      // eslint-disable-next-line no-console
      console.log('DFS divergence', {
        dpr1Total: tiles1.length, dpr3Total: tiles3.length,
        common: d.common, onlyDpr1: d.onlyA.slice(0, 10), onlyDpr3: d.onlyB.slice(0, 10),
      })
    }
    expect(set1).toEqual(set3)
  })

  it('visibleTilesFrustumSampled: DPR=1 and DPR=3 produce identical tile set at pitch=0', () => {
    const cam = makeCam(14.95, 0, 26)
    const z = Math.round(cam.zoom)
    const tiles1 = visibleTilesFrustumSampled(cam, mercator, z, CSS_W * 1, CSS_H * 1, 0, 1)
    const tiles3 = visibleTilesFrustumSampled(cam, mercator, z, CSS_W * 3, CSS_H * 3, 0, 3)
    const set1 = new Set(tiles1.map(tileKey))
    const set3 = new Set(tiles3.map(tileKey))
    const d = diff(set1, set3)
    if (d.onlyA.length || d.onlyB.length) {
      // eslint-disable-next-line no-console
      console.log('Sampled divergence', {
        dpr1Total: tiles1.length, dpr3Total: tiles3.length,
        common: d.common, onlyDpr1: d.onlyA.slice(0, 10), onlyDpr3: d.onlyB.slice(0, 10),
      })
    }
    expect(set1).toEqual(set3)
  })

  it('visibleTilesFrustum: DPR sweep at pitch=60 (DFS path) — invariant', () => {
    const cam = makeCam(10, 60, 45)
    const z = Math.round(cam.zoom)
    const dprs = [1, 1.5, 2, 3]
    const sets = dprs.map(d => new Set(
      visibleTilesFrustum(cam, mercator, z, CSS_W * d, CSS_H * d, 0, d).map(tileKey),
    ))
    for (let i = 1; i < sets.length; i++) {
      const d = diff(sets[0], sets[i])
      if (d.onlyA.length || d.onlyB.length) {
        // eslint-disable-next-line no-console
        console.log(`DPR ${dprs[0]} vs ${dprs[i]}`, {
          left: sets[0].size, right: sets[i].size,
          onlyLeft: d.onlyA.slice(0, 6), onlyRight: d.onlyB.slice(0, 6),
        })
      }
      expect(sets[i]).toEqual(sets[0])
    }
  })

  it('tile counts at the user-reported scenario are reasonable', () => {
    // Manhattan z=14.95 pitch=0 bearing=26 — user reported 23 unique
    // tile positions per layer (300 total across 13 xgis layers).
    // At pitch=0 the sampled selector runs.
    const cam = makeCam(14.95, 0, 26)
    const tiles = visibleTilesFrustumSampled(cam, mercator, 15, CSS_W * 3, CSS_H * 3, 0, 3)
    // eslint-disable-next-line no-console
    console.log(`sampled @ z=15 pitch=0 NYC: ${tiles.length} tiles`,
      tiles.slice(0, 5).map(tileKey))
    // Document the actual count so over-coverage shows up in diffs.
    expect(tiles.length).toBeGreaterThan(0)
  })

  it('DPR sweep at HEAVY scene (Manhattan z=11.5 pitch=43): same tile count', () => {
    // The original "4fps" report scenario. After all DPR fixes the
    // tile selector should produce identical sets at DPR=1 / 2 / 3.
    const cam = makeCam(11.5, 43, 29, -73.99, 40.78)
    const z = Math.round(cam.zoom)
    const counts = [1, 2, 3].map(d => {
      const tiles = visibleTilesFrustum(cam, mercator, z, CSS_W * d, CSS_H * d, 0, d)
      return { dpr: d, count: tiles.length }
    })
    // eslint-disable-next-line no-console
    console.log('Manhattan z=11.5 pitch=43 — tile counts:', counts)
    // All DPRs must agree.
    expect(counts[1].count).toBe(counts[0].count)
    expect(counts[2].count).toBe(counts[0].count)
  })

  it('DPR sweep at flat top-down z=15 scenarios: same tile count', () => {
    const scenarios = [
      { zoom: 14.95, bearing: 26, label: 'NYC z=14.95 b=26' },
      { zoom: 16.5, bearing: 0, label: 'NYC z=16.5 b=0' },
      { zoom: 12, bearing: 90, label: 'NYC z=12 b=90' },
    ]
    for (const s of scenarios) {
      const cam = makeCam(s.zoom, 0, s.bearing)
      const z = Math.round(cam.zoom)
      const counts = [1, 2, 3].map(d => {
        const tiles = visibleTilesFrustumSampled(cam, mercator, z, CSS_W * d, CSS_H * d, 0, d)
        return { dpr: d, count: tiles.length }
      })
      // eslint-disable-next-line no-console
      console.log(`${s.label} — sampled tile counts:`, counts)
      expect(counts[1].count).toBe(counts[0].count)
      expect(counts[2].count).toBe(counts[0].count)
    }
  })
})
