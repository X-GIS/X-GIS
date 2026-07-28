// ═══ SSE selector emit budget — the missing-tile gate (#1374) ═══
//
// Reported symptom: tiles that should be visible are not rendered at all.
//
// Three defects in the emit cap produced exactly that, and none of them was
// observable from outside the selector:
//
//   D1 The cap truncated SILENTLY. `visit()` early-returned and the function
//      returned a plain array, so a short set was indistinguishable from a
//      complete one — missing tiles reached the screen with no diagnostic.
//   D2 The cap counted the fallbackOnly ANCESTORS pushed alongside each emitted
//      tile, so the documented 600-tile budget was really ~458 primaries.
//   D3 The copies were walked in TABLE order — [-2,-1,0,1,2], the camera's own
//      world THIRD — against a shared running total checked at `visit` entry. So
//      the off-screen copies had first claim on the budget and the PRIMARY world
//      could return at its root with nothing emitted: a contiguous band of map
//      missing, not a scattered dropout.
//
// These are budget-arithmetic properties, so they are pinned directly with a
// small cap rather than by constructing a 600-tile camera.

import { describe, it, expect } from 'vitest'
import { visibleTilesSSE } from './tiles-sse'
import { mercator } from '@xgis/geo'
import type { TileSelectionCamera } from './tile-select-types'

/** An MVP that maps camera-relative Mercator metres straight into NDC with a
 *  wide half-extent, so a large tile fan projects on screen and the emit cap is
 *  what limits the walk (not the frustum). Column-major, w = 1: `toScreen` reads
 *  m[0]/m[5] for x/y and m[3]/m[7]/m[15] for w. */
const HALF_EXTENT_M = 50_000
function flatMvp(): Float64Array {
  const m = new Float64Array(16)
  m[0] = 1 / HALF_EXTENT_M
  m[5] = 1 / HALF_EXTENT_M
  m[15] = 1
  return m
}

/** A plain flat-Mercator camera over Paris. Zoom is deep enough that the SSE
 *  walk wants far more tiles than the caps used below, so the cap always bites. */
function camera(overrides: Partial<TileSelectionCamera> = {}): TileSelectionCamera {
  const lon = 2.33194
  const lat = 48.84778
  const R = 6378137
  const centerX = (lon * Math.PI * R) / 180
  const centerY = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
  return {
    zoom: 14,
    centerX,
    centerY,
    bearing: 0,
    pitch: 0,
    projType: 0,
    globeMode: false,
    getRTCMatrix: () => flatMvp(),
    // `far: Infinity` states plainly that this fixture does not exercise the
    // #1427 far-plane cull — its subject is the emit budget, and `flatMvp`
    // gives every point clip w = 1 anyway, so no finite bound would bite.
    getFrameView: () => ({ matrix: flatMvp(), far: Infinity }),
    ...overrides,
  } as unknown as TileSelectionCamera
}

const select = (
  opts: Parameters<typeof visibleTilesSSE>[7] = {},
  cam: TileSelectionCamera = camera(),
): ReturnType<typeof visibleTilesSSE> =>
  visibleTilesSSE(cam, mercator, 14, 1024, 768, 0, 1, {
    // The frustum cull needs a real MVP; without one nothing projects on screen.
    // Disabling the horizon cull keeps the walk wide enough to exercise the cap.
    disableHorizonCull: true,
    ...opts,
  })

const primaries = (tiles: ReturnType<typeof visibleTilesSSE>): number =>
  tiles.filter((t) => !t.fallbackOnly).length

describe('SSE emit budget — truncation is reported, never silent (D1)', () => {
  it('fires onTruncated when the cap bites', () => {
    const seen: [number, number][] = []
    select({ maxEmitted: 4, onTruncated: (n, cap) => seen.push([n, cap]) })
    expect(seen.length).toBe(1)
    expect(seen[0]![1]).toBe(4)
    expect(seen[0]![0]).toBeGreaterThanOrEqual(4)
  })

  it('does NOT fire when the whole visible set fits', () => {
    let fired = 0
    select({ maxEmitted: 100_000, onTruncated: () => fired++ })
    expect(fired).toBe(0)
  })

  it('omitting the callback is side-effect-free — the return shape is unchanged', () => {
    const withCb = select({ maxEmitted: 6, onTruncated: () => {} })
    const withoutCb = select({ maxEmitted: 6 })
    expect(withoutCb.map((t) => `${t.z}/${t.x}/${t.y}`)).toEqual(
      withCb.map((t) => `${t.z}/${t.x}/${t.y}`),
    )
  })
})

describe('SSE emit budget — the cap governs PRIMARY tiles only (D2)', () => {
  it('emits the full primary budget even though ancestors are pushed too', () => {
    const cap = 8
    const tiles = select({ maxEmitted: cap })
    // Pre-fix the ancestors were charged, so primaries stopped well short of cap.
    expect(primaries(tiles)).toBe(cap)
  })

  it('ancestors are still emitted alongside — they are not dropped, just uncharged', () => {
    const tiles = select({ maxEmitted: 8 })
    expect(tiles.length).toBeGreaterThan(primaries(tiles))
    expect(tiles.some((t) => t.fallbackOnly)).toBe(true)
  })

  it('never exceeds the primary cap', () => {
    for (const cap of [1, 2, 5, 13, 40]) {
      expect(primaries(select({ maxEmitted: cap }))).toBeLessThanOrEqual(cap)
    }
  })
})

describe("SSE emit budget — the camera's own world is served first (D3)", () => {
  // Mercator ALWAYS enumerates [-2,-1,0,1,2], so the primary world is third in
  // table order — the position that got starved once the budget ran out.
  const antimeridian = camera({ centerX: Math.PI * 6378137 } as Partial<TileSelectionCamera>)

  it('every world copy present in the output is non-empty', () => {
    const tiles = select({ maxEmitted: 40 }, antimeridian)
    const perCopy = new Map<number, number>()
    for (const t of tiles) {
      if (t.fallbackOnly) continue
      const n = 1 << t.z
      const wc = Math.floor(t.ox / n)
      perCopy.set(wc, (perCopy.get(wc) ?? 0) + 1)
    }
    for (const [, count] of perCopy) expect(count).toBeGreaterThan(0)
  })

  it('the primary world spends the budget FIRST, so it is never the starved one', () => {
    // Nearest-first ordering means an ordinary camera (whose whole view is in
    // copy 0) still gets the entire budget — the off-screen copies take what is
    // left, which is the opposite of the pre-fix order.
    const tiles = select({ maxEmitted: 30 })
    const inPrimary = tiles.filter((t) => {
      if (t.fallbackOnly) return false
      return Math.floor(t.ox / (1 << t.z)) === 0
    })
    expect(inPrimary.length).toBe(30)
  })
})
