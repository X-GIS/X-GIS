import { describe, it, expect } from 'vitest'
import { GlyphAtlasHost, GLYPH_STRING_MEMO_MAX } from './glyph-atlas-host'
import type { GlyphRasterizer, GlyphRasterRequest, GlyphRasterResult } from './glyph-rasterizer'

// Regression #1368 — the three string-keyed memos in GlyphAtlasHost
// (stringInfoCache / preloadedAtGen / hasAllGlyphsAtGen) are keyed by LABEL
// TEXT and had no removal path at all: one entry per distinct label text ever
// shaped, held for the life of the map (~1.2 KB per distinct text across the
// three; 20 k texts ≈ +23 MB). The generation guard makes a stale entry MISS,
// but a miss only overwrites its own key — it never drops the other stale
// keys, so the maps only ever grow.

/** Constant-metric stub. This test asserts map sizes, not SDF bytes. */
class StubRasterizer implements GlyphRasterizer {
  rasterize(req: GlyphRasterRequest): GlyphRasterResult {
    return {
      fontKey: req.fontKey,
      codepoint: req.codepoint,
      sdfRadius: req.sdfRadius,
      sdf: new Uint8Array(req.slotSize * req.slotSize),
      advanceWidth: 10,
      bearingX: 0,
      bearingY: 18,
      width: 16,
      height: 16,
      pbf: false,
      rasterFontSize: req.fontSize,
    }
  }
}

const FONT = 'test-font'
/** Well past the cap, so an unbounded map ends at N and a bounded one at the cap. */
const N = GLYPH_STRING_MEMO_MAX + 2000

/** TypeScript `private` is not a runtime barrier — read the memos directly. */
interface HostMemos {
  stringInfoCache: Map<string, unknown>
  preloadedAtGen: Map<string, number>
  hasAllGlyphsAtGen: Map<string, number>
  infoCache: Map<number, unknown>
}
const memosOf = (h: GlyphAtlasHost): HostMemos => h as unknown as HostMemos

/** Drive `count` distinct label texts through all three memoised entry points.
 *  1024 slots (32×32) hold the whole alphabet used here, so nothing is ever
 *  evicted and `_generation` stays 0 — the memos are exercised on exactly the
 *  steady-state hit path where the growth was measured. */
function floodDistinctTexts(count = N): {
  host: GlyphAtlasHost
  codepoints: Set<number>
  allResident: boolean
} {
  const host = new GlyphAtlasHost({ slotSize: 8, pageSize: 256 }, new StubRasterizer(), {
    fontSize: 24,
    sdfRadius: 4,
  })
  const codepoints = new Set<number>()
  let allResident = true
  for (let i = 0; i < count; i++) {
    const text = `label-${i}`
    for (const ch of text) codepoints.add(ch.codePointAt(0)!)
    host.preloadString(FONT, text)
    if (!host.hasAllGlyphs(FONT, text)) allResident = false
    host.ensureString(FONT, text)
  }
  return { host, codepoints, allResident }
}

/** The memo key is `fontKey|cjkBucket|text`, so an exact text match is a suffix match. */
const holdsText = (m: Map<string, unknown>, text: string): boolean =>
  [...m.keys()].some((k) => k.endsWith('|' + text))

describe('GlyphAtlasHost: the string-keyed memos are bounded (#1368)', () => {
  it('keeps all three memos at or below the cap across N distinct label texts', () => {
    const { host, allResident } = floodDistinctTexts()
    const m = memosOf(host)

    // Guard the premise: without a bound each map would hold N entries.
    expect(N).toBeGreaterThan(GLYPH_STRING_MEMO_MAX)
    expect(
      host.getGeneration(),
      'atlas must not evict here — memos exercised on the hit path',
    ).toBe(0)

    expect(m.stringInfoCache.size).toBeLessThanOrEqual(GLYPH_STRING_MEMO_MAX)
    expect(m.preloadedAtGen.size).toBeLessThanOrEqual(GLYPH_STRING_MEMO_MAX)
    expect(m.hasAllGlyphsAtGen.size).toBeLessThanOrEqual(GLYPH_STRING_MEMO_MAX)

    // Bounding must not have broken what the memos are for.
    expect(allResident, 'hasAllGlyphs must stay correct under the cap').toBe(true)
    expect(host.ensureString(FONT, `label-${N - 1}`).length).toBe(`label-${N - 1}`.length)
  })

  it('evicts the oldest entry and keeps the newest (bounded eviction, not a blanket clear)', () => {
    const { host } = floodDistinctTexts()
    const m = memosOf(host)
    const newest = `label-${N - 1}`

    for (const [name, map] of [
      ['stringInfoCache', m.stringInfoCache],
      ['preloadedAtGen', m.preloadedAtGen],
      ['hasAllGlyphsAtGen', m.hasAllGlyphsAtGen],
    ] as const) {
      expect(holdsText(map, 'label-0'), `${name} must have evicted the oldest text`).toBe(false)
      expect(holdsText(map, newest), `${name} must still hold the newest text`).toBe(true)
      expect(map.size, `${name} must fill to the cap, not be cleared`).toBe(GLYPH_STRING_MEMO_MAX)
    }
  })

  // The flood above CANNOT tell LRU from FIFO: with every text distinct,
  // insertion order IS use order, so both policies evict the same keys. Only
  // a RE-USED text discriminates them.
  it('refreshes recency on a memo hit, so a re-used text outlives newer ones (LRU, not FIFO)', () => {
    const REUSED = 'label-0'
    const FRESH = 500

    // Fill to exactly the cap: all three memos hold label-0..label-(cap-1),
    // nothing evicted yet, and label-0 is the head (= next to go).
    const { host } = floodDistinctTexts(GLYPH_STRING_MEMO_MAX)
    const m = memosOf(host)
    const maps = [
      ['stringInfoCache', m.stringInfoCache],
      ['preloadedAtGen', m.preloadedAtGen],
      ['hasAllGlyphsAtGen', m.hasAllGlyphsAtGen],
    ] as const
    for (const [name, map] of maps) {
      expect(map.size, `${name} premise: filled to exactly the cap`).toBe(GLYPH_STRING_MEMO_MAX)
      expect(holdsText(map, REUSED), `${name} premise: the oldest text is still held`).toBe(true)
    }

    // Re-use the oldest text. All three of these are memo HITS (generation is
    // still 0), so they exercise the hit path — the only place recency can be
    // refreshed.
    host.preloadString(FONT, REUSED)
    expect(host.hasAllGlyphs(FONT, REUSED)).toBe(true)
    host.ensureString(FONT, REUSED)
    expect(host.getGeneration(), 'the re-use must not evict — it is a pure hit').toBe(0)

    // Admit FRESH new texts. Each one evicts the current head; FRESH is well
    // under the cap, so only the head region turns over.
    for (let i = 0; i < FRESH; i++) {
      const text = `fresh-${i}`
      host.preloadString(FONT, text)
      host.hasAllGlyphs(FONT, text)
      host.ensureString(FONT, text)
    }
    // Premise guard: the whole experiment ran at one generation, so every
    // eviction observed below is the memo cap's doing, not the atlas's.
    expect(host.getGeneration(), 'the atlas must not evict during the experiment').toBe(0)

    for (const [name, map] of maps) {
      // Under FIFO the re-used text is still at the head and dies on the very
      // first fresh admission. Under LRU the hit moved it to the tail.
      expect(
        holdsText(map, REUSED),
        `${name} must keep the RE-USED text (FIFO would drop it)`,
      ).toBe(true)
      // Control: its never-re-used neighbour, admitted immediately after it,
      // did get evicted — proving eviction really ran.
      expect(
        holdsText(map, `label-${FRESH}`),
        `${name} must have evicted the un-re-used neighbour`,
      ).toBe(false)
      expect(map.size, `${name} must still sit at the cap`).toBe(GLYPH_STRING_MEMO_MAX)
    }
  })

  // The test above pins `getGeneration() === 0` at both ends, so it only ever
  // exercises the memo HIT path. That is not the steady state: `_generation`
  // bumps on every atlas slot eviction, on `invalidate()` and on
  // `invalidateAll()`, so in production the memos spend almost all their life
  // at generation > 0 — where every entry is stale and the hit-branch touch is
  // UNREACHABLE. Re-validation goes down the MISS path instead, and there
  // `Map.prototype.set` on a still-present key updates in place WITHOUT moving
  // it to the tail (ECMA-262), so recency is never refreshed and the policy
  // degenerates to FIFO-by-first-sight.
  it('refreshes recency on a STALE re-walk too, so the LRU survives a generation bump', () => {
    // NOT `label-0`. label-0 is the HEAD, and the cap guard evicts the head —
    // so an unfixed build would delete-then-re-append it by accident and this
    // test would pass vacuously. Any non-head index exposes the real policy.
    const REUSED = 'label-5'
    const FRESH = 500

    const { host } = floodDistinctTexts(GLYPH_STRING_MEMO_MAX)
    const m = memosOf(host)
    const maps = [
      ['stringInfoCache', m.stringInfoCache],
      ['preloadedAtGen', m.preloadedAtGen],
      ['hasAllGlyphsAtGen', m.hasAllGlyphsAtGen],
    ] as const
    for (const [name, map] of maps) {
      expect(map.size, `${name} premise: filled to exactly the cap`).toBe(GLYPH_STRING_MEMO_MAX)
      expect(holdsText(map, REUSED), `${name} premise: the re-used text is held`).toBe(true)
    }
    expect(host.getGeneration(), 'premise: the flood ran at generation 0').toBe(0)

    // Bump the generation. `invalidateAll` marks every glyph stale and clears
    // infoCache but LEAVES `metrics` populated, so `hasAllGlyphs` still answers
    // true — the memos go stale without changing what they memoise.
    host.invalidateAll()
    expect(host.getGeneration(), 'invalidateAll must bump the generation').toBe(1)

    // Re-validate through all three entry points. Every one is now a MISS.
    host.preloadString(FONT, REUSED)
    expect(host.hasAllGlyphs(FONT, REUSED)).toBe(true)
    host.ensureString(FONT, REUSED)

    // A stale re-walk must not SHRINK the memo. Unfixed, the cap guard evicts
    // the head and then `set` updates the still-present key in place, admitting
    // nothing — one live entry lost per stale re-walk.
    for (const [name, map] of maps) {
      expect(map.size, `${name} must not lose an entry to a stale re-walk`).toBe(
        GLYPH_STRING_MEMO_MAX,
      )
    }

    for (let i = 0; i < FRESH; i++) {
      const text = `fresh-${i}`
      host.preloadString(FONT, text)
      host.hasAllGlyphs(FONT, text)
      host.ensureString(FONT, text)
    }
    // No atlas eviction during the experiment, so every eviction below is the
    // memo cap's doing and the generation never moved again.
    expect(host.getGeneration(), 'the atlas must not evict during the experiment').toBe(1)

    for (const [name, map] of maps) {
      expect(
        holdsText(map, REUSED),
        `${name} must keep the re-used text across a generation bump (FIFO would drop it)`,
      ).toBe(true)
      // Control: a never-re-used neighbour admitted after it DID get evicted.
      expect(
        holdsText(map, `label-${FRESH}`),
        `${name} must have evicted the un-re-used neighbour`,
      ).toBe(false)
      expect(map.size, `${name} must still sit at the cap`).toBe(GLYPH_STRING_MEMO_MAX)
    }
  })

  it('leaves the numerically-keyed sibling infoCache behaving as before', () => {
    const { host, codepoints } = floodDistinctTexts()
    const m = memosOf(host)

    // infoCache is pinned by the atlas slot count, not by label-text diversity:
    // N distinct texts over a small alphabet leave exactly that alphabet cached.
    expect(m.infoCache.size).toBe(codepoints.size)
    expect(m.infoCache.size).toBeLessThanOrEqual(host.state.capacity)

    // iter-205 memoisation invariant: two ensures return the same reference.
    const a = host.ensure(FONT, 0x41)
    const b = host.ensure(FONT, 0x41)
    expect(b).toBe(a)
  })
})
