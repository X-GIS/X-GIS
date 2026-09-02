// ═══ SSE selector fallbackOnly parent inject — completeness gate (#2351) ═══
//
// #2351: `visibleTilesSSE` deduped its fallbackOnly ancestor injects through a
// single packed key `((worldCopy + 16) * 32 + z) * 2^44 + x * 2^22 + y`. That is
// 54 bits of payload in a double, which holds 53: for every worldCopy ≥ 0 the
// key landed in [2^53, 2^54) where the ULP is 2, so the low bit of `y` rounded
// away and `y` collided with `y ± 1`. The dedup then read the collision as
// "already injected" and `break`s, silently dropping ~44% of the z-1 ancestors
// the selector documents it emits — exactly the eviction protection and prefetch
// set the renderer's parent-walk falls back to during an LOD transition.

import { describe, it, expect } from 'vitest'
import { visibleTilesSSE } from './tiles-sse'
import { mercator } from '@xgis/geo'
import type { TileSelectionCamera } from './tile-select-types'

const HALF_EXTENT_M = 50_000
function flatMvp(): Float64Array {
  const m = new Float64Array(16)
  m[0] = 1 / HALF_EXTENT_M
  m[5] = 1 / HALF_EXTENT_M
  m[15] = 1
  return m
}

/** Flat-Mercator camera over Seoul — worldCopy 0, the camera's own copy. */
function camera(): TileSelectionCamera {
  const lon = 126.978
  const lat = 37.5665
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
    getFrameView: () => ({ matrix: flatMvp(), far: Infinity }),
  } as unknown as TileSelectionCamera
}

describe('visibleTilesSSE — fallbackOnly parent inject contract', () => {
  it('emits the z-1 ancestor of every primary tile', () => {
    const tiles = visibleTilesSSE(camera(), mercator, 14, 1024, 768, 0, 1, {
      disableHorizonCull: true,
      maxEmitted: 100_000,
    })
    // worldCopy 0 only: ox === x there.
    const present = new Set(tiles.filter((t) => t.ox === t.x).map((t) => `${t.z}/${t.x}/${t.y}`))
    const missing: string[] = []
    for (const t of tiles) {
      if (t.fallbackOnly) continue
      if (t.ox !== t.x) continue
      if (t.z === 0) continue
      const pk = `${t.z - 1}/${t.x >>> 1}/${t.y >>> 1}`
      if (!present.has(pk)) missing.push(`primary ${t.z}/${t.x}/${t.y} -> missing parent ${pk}`)
    }
    const primaries = tiles.filter((t) => !t.fallbackOnly).length
    expect(
      { primaries, missingCount: missing.length, sample: missing.slice(0, 6) },
      'every primary tile must have its z-1 ancestor in the selection',
    ).toEqual({ primaries, missingCount: 0, sample: [] })
  })

  it('keeps distinct ancestors distinct for odd y in the camera world copy', () => {
    // The collapsed pair from the #2351 witness: 13/6985/3172 and 13/6985/3173
    // packed to the same key (9235926970535012) under the old 54-bit scheme.
    const tiles = visibleTilesSSE(camera(), mercator, 14, 1024, 768, 0, 1, {
      disableHorizonCull: true,
      maxEmitted: 100_000,
    })
    const ancestors = tiles.filter((t) => t.fallbackOnly && t.z === 13 && t.x === 6985)
    const ys = ancestors.map((t) => t.y).sort((a, b) => a - b)
    expect(ys).toContain(3172)
    expect(ys).toContain(3173)
  })
})
