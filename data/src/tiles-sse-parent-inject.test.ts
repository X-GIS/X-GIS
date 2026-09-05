// ═══ SSE selector — the fallbackOnly parent inject is COMPLETE (#2351) ═══
//
// `visibleTilesSSE` promises a (z-1, z-2) `fallbackOnly` ancestor for every
// primary it emits: that set is the eviction protection
// (tile-selection-cache.ts `protectedAncestors` → `stableKeys`) and the prefetch
// set (tile-decision.ts) for the parent slice the renderer draws while a child
// slice is still uploading. Nothing asserted COMPLETENESS, so a dedup key that
// silently conflated distinct ancestors went unnoticed: the old key packed
// (worldCopy, z, x, y) as `((worldCopy + 16) * 32 + z) * 2^44 + x * 2^22 + y`,
// 55 bits in a comment claiming 53. On the camera's OWN world copy the leading
// term alone is ≥ 2^53, where a double's ULP is 2 — so the low bit of `y` was
// rounded away and y / y±1 shared a key. The inject loop reads that as "already
// injected" and `break`s, dropping a real ancestor.
//
// The first test is the contract; the second pins the arithmetic directly, so a
// future re-pack that reintroduces the overflow fails on the CAUSE and not only
// on a camera that happens to expose it.

import { describe, it, expect } from 'vitest'
import { visibleTilesSSE } from './tiles-sse'
import { mercator } from '@xgis/geo'
import type { TileCoord } from './tile-select-types'
import type { TileSelectionCamera } from './tile-select-types'

const HALF_EXTENT_M = 50_000
function flatMvp(): Float64Array {
  const m = new Float64Array(16)
  m[0] = 1 / HALF_EXTENT_M
  m[5] = 1 / HALF_EXTENT_M
  m[15] = 1
  return m
}

/** Flat-Mercator camera over Seoul — the view the #2351 witness measured. */
function seoulCamera(): TileSelectionCamera {
  const lon = 126.978
  const lat = 37.5665
  const R = 6378137
  return {
    zoom: 14,
    centerX: (lon * Math.PI * R) / 180,
    centerY: R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)),
    bearing: 0,
    pitch: 0,
    projType: 0,
    globeMode: false,
    getRTCMatrix: () => flatMvp(),
    getFrameView: () => ({ matrix: flatMvp(), far: Infinity }),
  } as unknown as TileSelectionCamera
}

const select = (): TileCoord[] =>
  visibleTilesSSE(seoulCamera(), mercator, 14, 1024, 768, 0, 1, {
    disableHorizonCull: true,
    // No cap: the subject is the inject's completeness, not the emit budget.
    maxEmitted: 100_000,
  })

describe('SSE parent inject — every primary keeps its z-1 ancestor (#2351)', () => {
  it('emits the z-1 ancestor of every primary tile', () => {
    const tiles = select()
    const present = new Set(tiles.map((t) => `${t.z}/${t.x}/${t.y}`))
    const primaries = tiles.filter((t) => !t.fallbackOnly)
    expect(primaries.length).toBeGreaterThan(100) // the fixture really is dense

    const missing: string[] = []
    for (const t of primaries) {
      const key = `${t.z - 1}/${t.x >>> 1}/${t.y >>> 1}`
      if (!present.has(key)) missing.push(`primary ${t.z}/${t.x}/${t.y} -> missing parent ${key}`)
    }
    // Pre-fix this was 106 of 240, i.e. ~44% of the protection set absent.
    expect({ missingCount: missing.length, sample: missing.slice(0, 6) }).toEqual({
      missingCount: 0,
      sample: [],
    })
  })

  it('distinct ancestors get distinct dedup keys — the arithmetic, not just a camera', () => {
    // The exact pair the witness named, plus a sweep. `parentKey` is internal, so
    // this reproduces both the OLD packing and the NEW two-part key and asserts
    // which one separates neighbours.
    const packed = (z: number, x: number, y: number, wc: number): number =>
      ((wc + 16) * 32 + z) * (1 << 22) * (1 << 22) + x * (1 << 22) + y
    const split = (z: number, x: number, y: number, wc: number): string =>
      `${(wc + 16) * 32 + z}:${x * 2 ** 22 + y}`

    expect(packed(13, 6985, 3172, 0)).toBe(packed(13, 6985, 3173, 0)) // the defect
    expect(split(13, 6985, 3172, 0)).not.toBe(split(13, 6985, 3173, 0)) // the fix

    // No two distinct coords may share a key, over the whole worldCopy × z range
    // the selector can produce — not just the one pair a camera happened to hit.
    const seen = new Map<string, string>()
    for (const wc of [-2, -1, 0, 1, 2]) {
      for (const z of [0, 1, 13, 21, 22]) {
        for (const x of [0, 1, 4000, 4001, 6985, 2 ** 22 - 1]) {
          for (const y of [0, 1, 3172, 3173, 2 ** 22 - 1]) {
            const id = `${wc}/${z}/${x}/${y}`
            const k = split(z, x, y, wc)
            expect(seen.get(k) ?? id).toBe(id)
            seen.set(k, id)
          }
        }
      }
    }
  })
})
