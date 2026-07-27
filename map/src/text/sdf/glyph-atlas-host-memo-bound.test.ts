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

/** Drive N distinct label texts through all three memoised entry points.
 *  1024 slots (32×32) hold the whole alphabet used here, so nothing is ever
 *  evicted and `_generation` stays 0 — the memos are exercised on exactly the
 *  steady-state hit path where the growth was measured. */
function floodDistinctTexts(): {
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
  for (let i = 0; i < N; i++) {
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

  it('evicts the oldest entry and keeps the newest (LRU, not a blanket clear)', () => {
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
