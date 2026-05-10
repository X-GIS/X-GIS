// Pure-function unit tests for the anticipatory-prefetch decisions
// driven by VectorTileRenderer.pumpPrefetch:
//
//   - projectPanPrefetchTarget — Google Earth-style pan-direction
//     speculation. Returns null in every case the existing Tier 1/2
//     idle prefetch would handle better, returns a projected camera
//     state otherwise.
//   - collectSiblingPrefetchKeys — NASA-AMMOS 3D Tiles Renderer
//     loadSiblings. Quad-sibling expansion with strict filtering
//     and a hard cap so mobile fetch budgets aren't blown.
//
// Both fns are pure — no GPU, no catalog, no fetch — so they're
// covered exhaustively here. The integration with VTR + catalog
// lives in `vtr-pump-prefetch.test.ts`.
import { describe, expect, it } from 'vitest'
import { tileKey, tileKeyParent, tileKeyChildren } from '@xgis/compiler'
import {
  projectPanPrefetchTarget, collectSiblingPrefetchKeys,
  type CameraSnapshot,
} from './tile-decision'

const baseSnap = (cx: number, cy: number, zoom: number, t: number): CameraSnapshot =>
  ({ cx, cy, zoom, t })

describe('projectPanPrefetchTarget — Google Earth pan-direction speculation', () => {
  it('returns null when prev is null (first frame, no velocity yet)', () => {
    const cur = baseSnap(0, 0, 14, 1000)
    expect(projectPanPrefetchTarget(null, cur, 0)).toBeNull()
  })

  it('returns null when zoom is in transition (Tier 2 owns this case)', () => {
    const prev = baseSnap(0, 0, 14, 1000)
    // 0.06 difference > 0.05 threshold
    const cur = baseSnap(1000, 0, 14.06, 1016)
    expect(projectPanPrefetchTarget(prev, cur, 0)).toBeNull()
  })

  it('returns null when pitch exceeds maxPitchDeg', () => {
    const prev = baseSnap(0, 0, 14, 1000)
    const cur = baseSnap(1000, 0, 14, 1016)
    // pitch 60 > default 45
    expect(projectPanPrefetchTarget(prev, cur, 60)).toBeNull()
  })

  it('returns null when dt is non-positive or above the upper bound', () => {
    const prev = baseSnap(0, 0, 14, 1000)
    // dt = 0 (same timestamp)
    expect(projectPanPrefetchTarget(prev, baseSnap(1000, 0, 14, 1000), 0)).toBeNull()
    // dt = -5 (clock went backwards)
    expect(projectPanPrefetchTarget(prev, baseSnap(1000, 0, 14, 995), 0)).toBeNull()
    // dt = 250 (paused tab / debugger break)
    expect(projectPanPrefetchTarget(prev, baseSnap(1000, 0, 14, 1250), 0)).toBeNull()
  })

  it('returns null when speed is below the m²/ms² threshold', () => {
    const prev = baseSnap(0, 0, 14, 1000)
    // ~5 m/frame at 16 ms = 0.3125 m/ms → speedSq ~0.1, well under default 3.5
    const cur = baseSnap(5, 0, 14, 1016)
    expect(projectPanPrefetchTarget(prev, cur, 0)).toBeNull()
  })

  it('projects the camera lookAheadMs forward at the current velocity', () => {
    const prev = baseSnap(0, 0, 14, 1000)
    // 200 m / 16 ms = 12.5 m/ms — well over threshold
    const cur = baseSnap(200, 100, 14, 1016)
    const future = projectPanPrefetchTarget(prev, cur, 0, { lookAheadMs: 50 })
    expect(future).not.toBeNull()
    // dx = 200, vxPerMs = 12.5; 50 ms ahead of cur.cx=200 → 200 + 12.5*50 = 825
    expect(future!.cx).toBeCloseTo(825, 6)
    // dy = 100, vyPerMs = 6.25; 100 + 6.25*50 = 412.5
    expect(future!.cy).toBeCloseTo(412.5, 6)
    expect(future!.zoom).toBe(14)
    expect(future!.t).toBe(1016 + 50)
  })

  it('respects custom lookAheadMs', () => {
    const prev = baseSnap(0, 0, 14, 0)
    const cur = baseSnap(200, 0, 14, 16)
    const f100 = projectPanPrefetchTarget(prev, cur, 0, { lookAheadMs: 100 })
    expect(f100!.cx).toBeCloseTo(200 + 12.5 * 100, 6)
    const f25 = projectPanPrefetchTarget(prev, cur, 0, { lookAheadMs: 25 })
    expect(f25!.cx).toBeCloseTo(200 + 12.5 * 25, 6)
  })
})

describe('collectSiblingPrefetchKeys — AMMOS 3D Tiles Renderer loadSiblings', () => {
  it('returns empty for empty visible set', () => {
    expect(collectSiblingPrefetchKeys([], () => false, () => true)).toEqual([])
  })

  it('returns empty when maxKeys is 0', () => {
    const visible = [tileKey(2, 0, 0)]
    expect(collectSiblingPrefetchKeys(visible, () => false, () => true, 0)).toEqual([])
  })

  it('filters self, already-visible, already-cached, and out-of-archive keys', () => {
    // Visible quad has 2 of its 4 children present; one of the other
    // 2 is already cached, the other is out of archive — neither
    // should be returned.
    const parent = tileKey(1, 0, 0)
    const [c0, c1, c2, c3] = tileKeyChildren(parent)
    const visible = [c0, c1]
    const cached = new Set<number>([c2])
    const inArchive = (k: number): boolean => k !== c3
    const got = collectSiblingPrefetchKeys(
      visible,
      (k) => cached.has(k),
      inArchive,
    )
    // c0/c1 are visible (skip self via != k AND visibleSet),
    // c2 is cached, c3 is out-of-archive → empty
    expect(got).toEqual([])
  })

  it('returns a sibling when it is uncached AND in-archive AND off-screen', () => {
    const parent = tileKey(1, 0, 0)
    const [c0, c1, c2, c3] = tileKeyChildren(parent)
    const visible = [c0]
    const got = collectSiblingPrefetchKeys(visible, () => false, () => true)
    // c0 is the visible one; c1/c2/c3 are off-screen siblings
    expect(new Set(got)).toEqual(new Set([c1, c2, c3]))
  })

  it('dedupes siblings shared across visible tiles', () => {
    // Two visible tiles in the same quad — they share the same set
    // of siblings, but the result should list each once.
    const parent = tileKey(1, 0, 0)
    const [c0, c1, c2, c3] = tileKeyChildren(parent)
    const visible = [c0, c1]
    const got = collectSiblingPrefetchKeys(visible, () => false, () => true)
    expect(got).toHaveLength(2)
    expect(new Set(got)).toEqual(new Set([c2, c3]))
  })

  it('caps output at maxKeys', () => {
    // Stage 8 visible tiles at z=3 in 8 distinct parent quads (x in
    // {0,2,4,6} × y in {0,2}). Each contributes 3 siblings → 24
    // potential, capped at 10.
    const visible: number[] = []
    for (const y of [0, 2]) {
      for (const x of [0, 2, 4, 6]) {
        visible.push(tileKey(3, x, y))
      }
    }
    const got = collectSiblingPrefetchKeys(visible, () => false, () => true, 10)
    expect(got.length).toBe(10)
  })

  it('skips when parent is out of zoom range (z=0 root)', () => {
    // The z=0 root tile (key=1) has tileKeyParent → < 1, so siblings
    // can't be derived. Should silently drop.
    const root = tileKey(0, 0, 0)
    expect(tileKeyParent(root)).toBeLessThan(1)
    const got = collectSiblingPrefetchKeys([root], () => false, () => true)
    expect(got).toEqual([])
  })
})
