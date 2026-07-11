import { describe, expect, it } from 'vitest'
import { planBakeEvictions } from './vector-drape-cache'

// #599 I3 — the globe vector-drape baked-fill cache eviction policy. Pure, so it
// runs without the RasterDraper / WebGPU stack. Entries are `{ lastCall }` (the
// LRU clock VectorDrapeRenderer stamps each time a bake is draped); the values
// here are cache KEYS (`${sliceLayer}:${tileKey}`) — the renderer maps each
// returned key to `rhi.destroyTexture` + `this.baked.delete`.
const baked = (entries: Array<[string, number]>): Map<string, { lastCall: number }> =>
  new Map(entries.map(([k, lastCall]) => [k, { lastCall }]))

describe('planBakeEvictions — baked-fill LRU cap (mirrors raster evictTiles)', () => {
  it('evicts nothing at or under the cap', () => {
    const cache = baked([
      ['l:1', 1],
      ['l:2', 2],
      ['l:3', 3],
    ])
    expect(planBakeEvictions(cache, new Set(), 3)).toEqual([])
    expect(planBakeEvictions(cache, new Set(), 10)).toEqual([])
  })

  it('drops the least-recently-draped non-visible keys down to the cap', () => {
    // 5 cached, cap 3 → evict 2. lastCall asc = l:1(1), l:2(2) are the oldest.
    const cache = baked([
      ['l:5', 5],
      ['l:1', 1],
      ['l:4', 4],
      ['l:2', 2],
      ['l:3', 3],
    ])
    const evicted = planBakeEvictions(cache, new Set(), 3)
    expect(evicted).toEqual(['l:1', 'l:2'])
  })

  it('never evicts a currently-visible bake (skip-set), even the oldest', () => {
    // Oldest is l:1 but it is visible → the next-oldest non-visible (l:2, l:3) go.
    const cache = baked([
      ['l:1', 1],
      ['l:2', 2],
      ['l:3', 3],
      ['l:4', 4],
    ])
    const evicted = planBakeEvictions(cache, new Set(['l:1']), 2)
    expect(evicted).toEqual(['l:2', 'l:3'])
    expect(evicted).not.toContain('l:1')
  })

  it('two consecutive visible-sets: only tiles that left view get evicted', () => {
    // Frame A draped keys 1..4; frame B moved so only 3,4 stay visible. With cap 2
    // and B's visible-set as skip, the departed 1,2 are the eviction targets.
    const cache = baked([
      ['l:1', 10],
      ['l:2', 11],
      ['l:3', 12],
      ['l:4', 13],
    ])
    const visibleB = new Set(['l:3', 'l:4'])
    expect(planBakeEvictions(cache, visibleB, 2)).toEqual(['l:1', 'l:2'])
  })

  it('static globe: all cached tiles visible → zero eviction even over cap', () => {
    // A held-still globe re-drapes the SAME keys every frame; they are all in the
    // skip-set, so nothing is evicted (and renderGlobeFills finds them all cached
    // → 0 rebakes). This is the I2 zero-rebake-on-static guarantee at the cache
    // policy level.
    const cache = baked([
      ['l:1', 1],
      ['l:2', 2],
      ['l:3', 3],
    ])
    const allVisible = new Set(['l:1', 'l:2', 'l:3'])
    expect(planBakeEvictions(cache, allVisible, 1)).toEqual([])
  })
})
