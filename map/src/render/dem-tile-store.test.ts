// `DemTileStore.resolve` — the DEM pyramid lookup, D5 INC-1 (#2525).
//
// WHY THIS TEST CARRIES THE WEIGHT. The draw-path half of #2525 is a pure move
// (the `findCachedParent` closure in `hillshade-renderer.ts` now delegates here),
// and a pure move has the vacuity #2268 named: every render gate passes if the
// move is correct AND if it is a no-op. So correctness is asserted at the store,
// where the contract lives, and the render gates only confirm the draw path did
// not change bytes.
//
// The sub-rect arithmetic gets an arm at k = 2 with a NON-ZERO corner on purpose:
// `u0 = v0 = 0` is satisfied by a lookup that ignores the corner entirely, so the
// exact-tile arm alone would pass on a broken implementation.

import { describe, it, expect } from 'vitest'
import type { RhiDevice } from '@xgis/engine'
import { DemTileStore, type CachedDemTile } from './dem-tile-store'

/** `resolve` reads residency only — no device, no draper, no texels — so the
 *  constructor's collaborators are inert here. The cache is private; seeding it
 *  through the cast is the established idiom for "this test is about the
 *  lookup, not about how a tile became resident". */
function storeWith(...residentKeys: string[]): DemTileStore {
  const store = new DemTileStore(null as unknown as RhiDevice, () => undefined)
  const cache = (store as unknown as { tileCache: Map<string, CachedDemTile> }).tileCache
  for (const k of residentKeys)
    cache.set(k, { texture: {} as never, bytes: 0, lastUsedFrame: 0, firstShownMs: -1 })
  return store
}

describe('#2525 — DemTileStore.resolve', () => {
  it('exact tile resident → levelsUp 0 and the identity sub-rect', () => {
    const r = storeWith('5/13/6').resolve(5, 13, 6)
    expect(r).toMatchObject({ z: 5, x: 13, y: 6, levelsUp: 0 })
    expect(r!.sub).toEqual({ scale: 1, u0: 0, v0: 0 })
  })

  it('ancestor two levels up → z−2, x>>2, y>>2 and the child’s NON-ZERO corner', () => {
    // (5, 13, 6) sits inside (3, 3, 1). Within that ancestor it is column
    // 13 & 3 = 1 and row 6 & 3 = 2, each a quarter wide — so the corner is
    // (0.25, 0.5), and a lookup that dropped the mask would return (0, 0).
    const r = storeWith('3/3/1').resolve(5, 13, 6)
    expect(r).toMatchObject({ z: 3, x: 3, y: 1, levelsUp: 2 })
    expect(r!.sub).toEqual({ scale: 0.25, u0: 0.25, v0: 0.5 })
  })

  it('prefers the NEAREST resident ancestor when several are', () => {
    const r = storeWith('2/0/0', '4/3/1').resolve(5, 6, 3)
    expect(r).toMatchObject({ z: 4, x: 3, y: 1, levelsUp: 1 })
  })

  it('honours maxLevelsUp: refused just past the bound, found with the default', () => {
    const store = storeWith('0/0/0')
    // The draw loop’s bound: 4 levels is not enough to reach z0 from z5.
    expect(store.resolve(5, 13, 6, 4)).toBeUndefined()
    // A sampler’s default: any resident ancestor counts, however far up.
    expect(store.resolve(5, 13, 6)).toMatchObject({ z: 0, levelsUp: 5 })
  })

  it('nothing resident → undefined, and never a request', () => {
    const store = storeWith()
    expect(store.resolve(7, 1, 1)).toBeUndefined()
    expect(store.size, 'resolve must not admit anything').toBe(0)
  })

  it('a negative z (the draw loop asking for z0’s parent) is undefined, not a throw', () => {
    // hillshade-renderer starts its ancestors-only walk at the PARENT, so at z0
    // it asks for z −1. The old closure `break`-ed on parentZ < 0; this must too.
    expect(storeWith('0/0/0').resolve(-1, 0, 0, 3)).toBeUndefined()
  })
})
