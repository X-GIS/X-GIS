import { describe, expect, it } from 'vitest'
import { firstIndexedAncestor } from '../data/tile-select'
import { tileKey, tileKeyParent } from '@xgis/compiler'

// CPU regression for the FLICKER bug at extreme over-zoom —
// `dashed_borders#19.80/21.55/108.05/75/64.2` over `ne_110m_ocean`
// (maxLevel ≈ 5). VTR's parent-prefetch loop used to cap at 2 levels
// up from the visible tile, which meant:
//
//   z=20 visible tile → walk hits z=19 (not indexed), z=18 (not
//   indexed), then STOPS. The actual indexed parent at z=5 is never
//   requested, so the next 60+ frames can't find a fallback and the
//   render stays empty, producing the sustained "[FLICKER] ocean: 122
//   tiles without fallback (z=20 gpuCache=X)" warnings from the bug
//   report.
//
// `firstIndexedAncestor` now walks up to 22 levels (DSFUN zoom ceiling)
// and terminates on the first `hasEntry` hit. These tests enforce:
//
//   1. The walk finds deep ancestors (13+ levels up).
//   2. The walk returns the NEAREST indexed ancestor (not a random
//      indexed key further up).
//   3. The walk caps out at z=0 and returns -1 when no ancestor is
//      indexed (prevents infinite loops on misconfigured sources).

describe('firstIndexedAncestor', () => {
  it('walks up 13 levels to reach an indexed ancestor at z=7', () => {
    // z=20 tile with its z=7 ancestor indexed (the reported bug state
    // — ne_110m_ocean source has maxLevel ≈ 5-7, camera at z=20).
    const leaf = tileKey(20, 500000, 500000)
    let walk = leaf
    for (let i = 0; i < 13; i++) walk = tileKeyParent(walk)
    const indexedParentZ7 = walk

    const hasEntry = (k: number) => k === indexedParentZ7
    const found = firstIndexedAncestor(leaf, hasEntry)
    expect(found).toBe(indexedParentZ7)
  })

  it('returns the NEAREST indexed ancestor when multiple are indexed', () => {
    // Both z=5 AND z=0 ancestors are in the index. The walk must
    // return z=5 (nearer) — if it returned z=0 we'd lose the higher-
    // resolution fallback and render blurrier tiles than necessary.
    const leaf = tileKey(20, 500000, 500000)
    const z0Root = 0  // tileKey(0, 0, 0) === 0 per Morton encoding
    let walk = leaf
    for (let i = 0; i < 15; i++) walk = tileKeyParent(walk)
    const z5 = walk

    const indexed = new Set([z0Root, z5])
    const hasEntry = (k: number) => indexed.has(k)
    const found = firstIndexedAncestor(leaf, hasEntry)
    expect(found).toBe(z5)
  })

  it('returns -1 when no ancestor up to z=0 is indexed', () => {
    const leaf = tileKey(10, 100, 100)
    const found = firstIndexedAncestor(leaf, () => false)
    expect(found).toBe(-1)
  })

  it('covers every visible tile via a single parent when pred says parentCount=1', () => {
    // Direct reproduction of the predictor's parentCount=1 finding:
    // at z=20 pitch 64° over maxLevel=7, every visible tile walks up
    // to the SAME ancestor. A single hasEntry check on that ancestor
    // unblocks 300+ descendants — which is exactly what the fallback
    // fix leverages to avoid FLICKER. (The old 2-level walk never
    // found this ancestor, so no fallback was prefetched and every
    // descendant's draw was missed.)
    const DEPTH = 13
    const parentX = 900_000 >> DEPTH
    const parentY = 400_000 >> DEPTH
    const indexedParent = tileKey(7, parentX, parentY)

    let allResolve = true
    for (let dx = 0; dx < 4; dx++) {
      for (let dy = 0; dy < 4; dy++) {
        const leaf = tileKey(20, (parentX << DEPTH) + dx, (parentY << DEPTH) + dy)
        const found = firstIndexedAncestor(leaf, (k) => k === indexedParent)
        if (found !== indexedParent) { allResolve = false; break }
      }
      if (!allResolve) break
    }
    expect(allResolve).toBe(true)
  })
})
