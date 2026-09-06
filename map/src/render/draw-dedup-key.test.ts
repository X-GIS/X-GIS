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

import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packDrawSubKey } from './draw-dedup-key'
import { renderPathSource } from './render-path-source'

const HERE = dirname(fileURLToPath(import.meta.url))

/** A world-copy offset in the unit the CALL SITES pass: degrees, one copy = 360
 *  (raster-renderer.ts `west + wo * 360`). This helper is convenience for the
 *  sweeps below, NOT the authority on the unit -- it first shipped as
 *  `wc * 360_000` (the `_worldOffScratchKey` unit, which feeds the bundle-cache
 *  key and never this packer), and every test built on it passed while the
 *  packer folded all world copies onto one sub-key. The authority is the
 *  'real caller' block below, which uses the literal. */
const copy = (wc: number): number => wc * 360

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
    const b = { key: 1 + 360 * 1_000_000, wo: 0 }
    expect(a.key + a.wo * 1_000_000).toBe(b.key + b.wo * 1_000_000) // old: SAME key
    expect(pair(a.key, a.wo, -1)).not.toBe(pair(b.key, b.wo, -1)) // new: distinct
  })
})

describe('the world-copy unit is the one the call sites pass -- degrees', () => {
  // These three do not go through `copy()`. A helper can encode the same wrong
  // premise as the code (it did), so the authority here is the literal value
  // `renderTileKeys` hands the packer: `worldOffDeg?.[ki]`, where one world copy
  // is exactly 360. Under the shipped-then-fixed `/ 360_000` step every row
  // below is red: `Math.round(360 / 360000)` is 0, so +/-360 and 0 pack to the
  // SAME sub-key and the second and third world copies of every tile are
  // skipped as duplicates -- `_world-copies-projection-gate` read tilesVisible
  // 4 where the render enumerates 12.
  it('+/-360 and 0 -- the three copies a z1.5 viewport shows -- pack to three sub-keys', () => {
    const subs = [-360, 0, 360].map((deg) => packDrawSubKey(deg, -1))
    expect(new Set(subs).size).toBe(3)
    // and the same with a visible key riding along
    const withVisible = [-360, 0, 360].map((deg) => packDrawSubKey(deg, 4 * 1234567 + 2))
    expect(new Set(withVisible).size).toBe(3)
  })

  it('agrees with the numeric branch it replaced on the real world-copy values', () => {
    // The old `key + worldOff * 1e6` DID separate +/-360 (it never divided by a
    // step, so it had no unit to get wrong). The new encoding must not be
    // coarser than the one it replaced on the inputs production actually sends.
    const key = 21
    const old = (wo: number) => (wo === 0 ? key : key + wo * 1_000_000)
    const oldDistinct = new Set([-360, 0, 360].map(old)).size
    const newDistinct = new Set([-360, 0, 360].map((wo) => pair(key, wo, -1))).size
    expect(oldDistinct).toBe(3)
    expect(newDistinct).toBe(oldDistinct)
  })

  it('a value in the scratch-key unit (x1e3) is LOUD under invariants, not silently folded', () => {
    // 360000 is what `_worldOffScratchKey` would hand over. Under the degree
    // step it is copy index 1000, far past the +/-16 bias, so the invariant
    // check names it. Had the packer stayed on the 360_000 step, this same
    // input would have been a silent, valid copy index 1 -- and the real
    // callers' 360 would have been the silent fold. The warning is the
    // instrument that distinguishes the two units at runtime.
    const g = globalThis as { __XGIS_INVARIANTS?: boolean }
    const prev = g.__XGIS_INVARIANTS
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      g.__XGIS_INVARIANTS = true
      packDrawSubKey(360_000, -1)
      const messages = warn.mock.calls.map((c) => String(c[0]))
      expect(messages.some((m) => /world-copy index 1000 exceeds/.test(m))).toBe(true)
      // and the real unit is quiet
      warn.mockClear()
      packDrawSubKey(360, -1)
      packDrawSubKey(-720, 7)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      g.__XGIS_INVARIANTS = prev
      warn.mockRestore()
    }
  })
})

describe('the dedup path is numeric end to end (#2309)', () => {
  const VTR = renderPathSource()
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
