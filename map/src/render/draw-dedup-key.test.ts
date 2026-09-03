// #2309 — the draw dedup key must distinguish exactly what the old `number |
// string` encoding distinguished, and it must do so at every zoom.
//
// What it replaced:
//
//     visibleKey >= 0 ? `${key}:${worldOff}:${visibleKey}`
//                     : worldOff === 0 ? key : key + worldOff * 1000000
//
// The dedup identity is the TRIPLE (tileKey, worldOff, visibleKey). Folding two
// distinct triples onto one key means a tile is silently skipped — the Korea
// fill-drop failure (2026-05-10) that put `visibleKey` in the key at all. These
// tests hold the new encoding to injectivity over that triple, and pin the two
// arithmetic premises the pack rests on.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packDrawSubKey } from './draw-dedup-key'

const HERE = dirname(fileURLToPath(import.meta.url))

/** A world-copy offset in `_worldOffScratchKey` units: `worldOffDeg * 1e3`,
 *  and a whole copy is 360 degrees. */
const copy = (wc: number): number => wc * 360_000

/** The (outer, inner) pair the stats map is keyed by, as the call sites build it. */
const pair = (key: number, worldOff: number, visibleKey: number): string =>
  `${key}|${packDrawSubKey(worldOff, visibleKey)}`

describe('packDrawSubKey — injective over (worldOff, visibleKey) (#2309)', () => {
  it('distinguishes the four visible children of ONE parent — the Korea case', () => {
    // The exact shape the old string encoding existed for: in fallback dispatch
    // the same parent draws once per visible child, each with its own
    // clip_bounds. A key that folded them dropped 3 of 4 (2026-05-10).
    const parent = 1234567
    const children = [4 * parent, 4 * parent + 1, 4 * parent + 2, 4 * parent + 3]
    const subs = children.map((c) => packDrawSubKey(0, c))
    expect(new Set(subs).size).toBe(4)
  })

  it('distinguishes world copies of the same (tile, visible) pair', () => {
    const subs = [-2, -1, 0, 1, 2].map((wc) => packDrawSubKey(copy(wc), 99))
    expect(new Set(subs).size).toBe(5)
  })

  it('separates "no visible key" from a real visible key of 0', () => {
    // Tile keys start at 1 (`4^0 + 0`), so 0 is free as the "none" sentinel —
    // but the encoding must not rely on that being unreachable.
    expect(packDrawSubKey(0, -1)).not.toBe(packDrawSubKey(0, 0))
  })

  it('is injective across the whole realistic domain, not a sample', () => {
    // Every combination of the three components, checked pairwise through the
    // (outer, inner) pair the map actually uses.
    // The DEEP visible keys are load-bearing, not decoration: a stride too
    // small to hold `4^23` lets a visible key overflow into the copy field, and
    // copies then collide. A sweep that stops at z14 keys (~4e8) passes a
    // stride of 2**29 — verified by cutting it, which is how this row got here.
    const keys = [1, 5, 21, 1365, 395_633_048, 4 ** 11 + 7, 4 ** 23 - 1]
    const copies = [-2, -1, 0, 1, 2]
    const visibles = [-1, 1, 4, 17, 395_633_047, 395_633_048, 4 ** 23 - 2, 4 ** 23 - 1]
    const seen = new Map<string, string>()
    for (const k of keys) {
      for (const wc of copies) {
        for (const v of visibles) {
          const p = pair(k, copy(wc), v)
          const id = `${k}/${wc}/${v}`
          const prior = seen.get(p)
          expect(prior, `${id} collides with ${prior}`).toBeUndefined()
          seen.set(p, id)
        }
      }
    }
    expect(seen.size).toBe(keys.length * copies.length * visibles.length)
  })

  it('stays inside MAX_SAFE at the deepest zoom the selector allows', () => {
    // `maxSubTileZ = 22`, so a tile key is under `4^23`. The pack must not
    // silently lose precision there — a fit that holds at z14 and breaks at z20
    // would be the latent trap the two-level design exists to avoid.
    const maxTileKey = 4 ** 23
    for (const wc of [-16, 0, 16]) {
      const sub = packDrawSubKey(copy(wc), maxTileKey)
      expect(Number.isSafeInteger(sub), `wc=${wc} sub=${sub}`).toBe(true)
    }
    // And the deepest keys still separate under the largest copy index.
    expect(packDrawSubKey(copy(16), maxTileKey)).not.toBe(packDrawSubKey(copy(16), maxTileKey - 1))
  })

  it('the visible-key field CONTAINS the deepest key — the property, not a sample', () => {
    // The invariant a too-small stride breaks: the largest visible key at copy
    // `c` must stay strictly below where copy `c+1` starts. Assert that
    // directly. A sweep cannot stand in for it — two keys collide only when
    // their difference is an exact multiple of the stride, so any finite sample
    // passes a wrong stride by luck. Verified by cutting the stride to 2**29:
    // the sweep stayed green and this row goes red.
    const maxTileKey = 4 ** 23
    for (const c of [-16, -1, 0, 1, 15]) {
      expect(
        packDrawSubKey(copy(c), maxTileKey),
        `copy ${c}'s deepest key must not reach copy ${c + 1}`,
      ).toBeLessThan(packDrawSubKey(copy(c + 1), -1))
    }
  })

  it('is strictly finer than the numeric branch it replaces', () => {
    // The old `key + worldOff * 1e6` was not injective by construction: two
    // tiles whose keys differ by `worldOff * 1e6` collapsed. (Unreachable in
    // practice — a whole world copy is 3.6e11, far past any one slice's key
    // spread — but the new encoding does not need that argument at all.)
    const a = { key: 1, wo: copy(1) }
    const b = { key: 1 + 360_000 * 1_000_000, wo: 0 }
    expect(a.key + a.wo * 1_000_000).toBe(b.key + b.wo * 1_000_000) // old: SAME key
    expect(pair(a.key, a.wo, -1)).not.toBe(pair(b.key, b.wo, -1)) // new: distinct
  })
})

describe('the dedup path is numeric end to end (#2309)', () => {
  const VTR = readFileSync(join(HERE, 'vector-tile-renderer.ts'), 'utf8')
  const STATS = readFileSync(join(HERE, 'frame-draw-stats.ts'), 'utf8')

  it('no draw key is built as a template literal', () => {
    expect(VTR).not.toMatch(/`\$\{key\}:\$\{worldOff\}:\$\{visibleKey\}`/)
    // Non-vacuity: the two call sites that used to build one still exist and
    // now go through the packer.
    expect([...VTR.matchAll(/packDrawSubKey\(/g)].length).toBe(2)
  })

  it('the stats map is two-level and numeric on both levels', () => {
    // Scoped to the DECLARATION, not the file: the docstring above it recounts
    // the `number | string` it replaced, and a whole-file scan cannot tell a
    // live type from a comment about history — it would pass or fail for the
    // wrong reason either way.
    const at = STATS.indexOf('private renderedDraws = new Map<')
    expect(at, 'the declaration must exist').toBeGreaterThan(-1)
    const decl = STATS.slice(at, STATS.indexOf('>()', at))
    expect(decl).toMatch(/new Map<\s*number,\s*Map<number,/)
    expect(decl, 'the polymorphic union must be gone from the TYPE').not.toContain(
      'number | string',
    )
    // Non-vacuity: the verbs still exist and take the pair.
    expect(STATS).toMatch(/hasDrawn\(key: number, sub: number\)/)
    expect(STATS).toMatch(/markDrawn\(\s*key: number,\s*sub: number,/)
  })
})
