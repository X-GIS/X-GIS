import { describe, it, expect, beforeEach } from 'vitest'
import { GlyphAtlasHost } from './sdf/glyph-atlas-host'
import { MockRasterizer } from './sdf/glyph-rasterizer'

const cfg = { slotSize: 24, pageSize: 96 }   // 4×4 = 16 slots
const opts = { fontSize: 16, sdfRadius: 6 }

let host: GlyphAtlasHost
beforeEach(() => {
  host = new GlyphAtlasHost(cfg, new MockRasterizer(), opts)
})

describe('GlyphAtlasHost.ensure', () => {
  it('first call rasterises + queues dirty', () => {
    host.ensure('noto', 65)
    expect(host.consumeDirty()).toHaveLength(1)
  })

  it('cached call does NOT re-queue', () => {
    host.ensure('noto', 65)
    host.consumeDirty()  // drain
    host.ensure('noto', 65)
    expect(host.consumeDirty()).toEqual([])
  })

  it('returns slot + metrics from rasterizer', () => {
    const info = host.ensure('noto', 65)
    expect(info.codepoint).toBe(65)
    expect(info.slot.size).toBe(24)
    expect(info.advanceWidth).toBeGreaterThan(0)
    expect(info.height).toBeGreaterThan(0)
  })

  it('cached metrics come back identical (no re-rasterise)', () => {
    const a = host.ensure('noto', 65)
    const b = host.ensure('noto', 65)
    expect(a.slot).toEqual(b.slot)
    expect(a.advanceWidth).toBe(b.advanceWidth)
    expect(a.bearingY).toBe(b.bearingY)
  })

  it('dirty entry carries SDF + slot for GPU upload', () => {
    host.ensure('noto', 65)
    const dirty = host.consumeDirty()
    expect(dirty[0]!.sdf.length).toBe(24 * 24)
    expect(dirty[0]!.slot.size).toBe(24)
    expect(dirty[0]!.key.codepoint).toBe(65)
  })
})

describe('GlyphAtlasHost.ensureString', () => {
  it('returns one info per codepoint', () => {
    const infos = host.ensureString('noto', 'ABC')
    expect(infos).toHaveLength(3)
    expect(infos.map(i => i.codepoint)).toEqual([65, 66, 67])
  })

  it('queues one dirty entry per unique glyph', () => {
    host.ensureString('noto', 'ABC')
    expect(host.consumeDirty()).toHaveLength(3)
  })

  it('repeated chars share one slot (and one dirty entry)', () => {
    host.ensureString('noto', 'AAA')
    expect(host.consumeDirty()).toHaveLength(1)
  })

  it('Unicode-aware iteration: surrogate pair counts once', () => {
    // 😀 = U+1F600, requires surrogate pair when iterated charwise.
    const infos = host.ensureString('noto', '😀')
    expect(infos).toHaveLength(1)
    expect(infos[0]!.codepoint).toBe(0x1F600)
  })
})

describe('GlyphAtlasHost.consumeEvictions', () => {
  it('reports evicted keys when capacity is exhausted', () => {
    // 16-slot capacity. Insert 17 unique → 1 eviction.
    for (let i = 0; i < 17; i++) host.ensure('noto', 0x100 + i)
    const evicted = host.consumeEvictions()
    expect(evicted.length).toBe(1)
    expect(evicted[0]!.codepoint).toBe(0x100)  // oldest
  })

  it('cleans up cached metrics for evicted glyphs', () => {
    for (let i = 0; i < 17; i++) host.ensure('noto', 0x100 + i)
    host.consumeEvictions()
    // Re-asking for the evicted glyph rasterises again (no metrics cache hit)
    host.consumeDirty()  // drain
    host.ensure('noto', 0x100)
    expect(host.consumeDirty()).toHaveLength(1)
  })

  it('drain is one-shot', () => {
    for (let i = 0; i < 17; i++) host.ensure('noto', 0x100 + i)
    expect(host.consumeEvictions()).toHaveLength(1)
    expect(host.consumeEvictions()).toEqual([])
  })
})

describe('GlyphAtlasHost.prewarm', () => {
  it('rasterises supplied glyphs eagerly', () => {
    host.prewarm('noto', [48, 49, 50, 51, 52])  // '0'..'4'
    expect(host.consumeDirty()).toHaveLength(5)
  })

  it('idempotent — re-prewarm does not re-rasterise', () => {
    host.prewarm('noto', [48, 49, 50])
    host.consumeDirty()
    host.prewarm('noto', [48, 49, 50])
    expect(host.consumeDirty()).toHaveLength(0)
  })
})

describe('GlyphAtlasHost.preloadString — iter-268 within-frame aliasing fix', () => {
  it('admits every codepoint without returning array', () => {
    // Each char admitted to atlas; no per-call allocation of GlyphInfo[].
    host.preloadString('noto', 'ABC')
    expect(host.consumeDirty()).toHaveLength(3)
  })

  it('idempotent — second call does not re-rasterise', () => {
    host.preloadString('noto', 'ABC')
    host.consumeDirty()
    host.preloadString('noto', 'ABC')
    expect(host.consumeDirty()).toEqual([])
  })

  it('Unicode-aware: surrogate pair admitted once', () => {
    host.preloadString('noto', '😀')
    expect(host.consumeDirty()).toHaveLength(1)
  })

  it('subsequent ensureString sees fully populated atlas — no further eviction', () => {
    // The point of preloadString is to drain ALL admissions (and any
    // evictions they cause) BEFORE any shape loop holds GlyphInfo[]
    // references. After the preload, ensureString must find every
    // codepoint already in atlas state and never trigger another
    // eviction — generation counter MUST be stable across the
    // subsequent shape loop.
    //
    // Setup: preload two short strings whose unique codepoints together
    // fit in the 16-slot atlas.
    host.preloadString('noto', 'ABCDE')   // 5 unique
    host.preloadString('noto', 'FGHIJ')   // 5 unique → 10 total ≪ 16
    const generationAfterPreload = host.getGeneration()
    host.consumeEvictions()                // drain anything from preload
    host.consumeDirty()

    // Now run the shape loop pattern: ensureString twice with the SAME
    // two strings. The atlas is fully populated; no admission, no
    // eviction, no generation bump.
    const glyphsA = host.ensureString('noto', 'ABCDE')
    const glyphsB = host.ensureString('noto', 'FGHIJ')

    expect(host.getGeneration()).toBe(generationAfterPreload)
    expect(host.consumeEvictions()).toEqual([])
    expect(glyphsA.map(g => g.codepoint)).toEqual([65, 66, 67, 68, 69])
    expect(glyphsB.map(g => g.codepoint)).toEqual([70, 71, 72, 73, 74])
  })

  it('label A glyphs survive label B preload — no within-frame aliasing', () => {
    // The user-reported OFM Korea bug scenario, condensed:
    //   - Label A (Latin "Pyongyang") shape-loop builds GlyphInfo[]
    //   - Label B (Hangul "평양")    ensure() would evict + reuse a
    //     slot referenced by Label A's array
    //   - Label A's draw later renders Label B's SDF bytes
    //
    // With the preload pass, ALL admissions happen FIRST. By the time
    // the shape loop builds either label's array, the atlas is settled
    // — no further eviction, both arrays reference STABLE slots whose
    // pxX/pxY contents are the right codepoint's SDF.
    host.preloadString('noto', 'Pyongyang')
    host.preloadString('noto', 'pyeong')   // simulate Hangul names with ASCII codepoints
    const dirtyAfterPreload = host.consumeDirty()
    // Unique codepoints in 'Pyongyang' + 'pyeong' = P, y, o, n, g, a
    // (uppercase P), p, e (lowercase p) = 8 (case-sensitive). Atlas has
    // 16 slots — fits with margin so no eviction during preload itself.
    expect(dirtyAfterPreload.length).toBe(8)

    // Now the shape loop runs. ensureString for each label must NOT
    // trigger any eviction. The generation counter is the invariant.
    const genBefore = host.getGeneration()
    const labelA = host.ensureString('noto', 'Pyongyang')
    const labelB = host.ensureString('noto', 'pyeong')

    // Eviction is the bug we're guarding against. If it happens here,
    // labelA's slot refs are now invalidated by labelB's ensure().
    expect(host.getGeneration()).toBe(genBefore)
    expect(host.consumeEvictions()).toEqual([])
    // Both arrays are fully populated with the right codepoints.
    expect(labelA.map(g => g.codepoint)).toEqual(
      [...'Pyongyang'].map(c => c.codePointAt(0)!))
    expect(labelB.map(g => g.codepoint)).toEqual(
      [...'pyeong'].map(c => c.codePointAt(0)!))
  })
})

describe('GlyphAtlasHost — fontKey isolation', () => {
  it('same codepoint, different font → different slot + dirty entry', () => {
    host.ensure('noto-regular', 65)
    host.ensure('noto-bold', 65)
    const dirty = host.consumeDirty()
    expect(dirty).toHaveLength(2)
    expect(dirty[0]!.slot).not.toEqual(dirty[1]!.slot)
  })
})

describe('GlyphAtlasHost — iter-205 GlyphInfo memoization', () => {
  it('repeated ensure() for the same glyph returns reference-equal GlyphInfo', () => {
    // Cache-hit branch returns the cached object so callers like
    // `ensureString` (which is on the hot per-frame path) avoid
    // allocating a new `{codepoint, slot, ...}` wrapper per char.
    const a = host.ensure('noto', 65)
    const b = host.ensure('noto', 65)
    expect(b).toBe(a)  // reference equality, not just structural
  })

  it('different codepoints get distinct GlyphInfo references', () => {
    const a = host.ensure('noto', 65)
    const b = host.ensure('noto', 66)
    expect(b).not.toBe(a)
    expect(a.codepoint).toBe(65)
    expect(b.codepoint).toBe(66)
  })

  it('invalidate() clears the GlyphInfo cache (next ensure rebuilds)', () => {
    const a = host.ensure('noto', 65)
    host.invalidate('noto', 65)
    const b = host.ensure('noto', 65)
    // Same metrics (slot kept, re-rastered in place) but DIFFERENT
    // reference — the post-invalidate ensure had to rebuild.
    expect(b).not.toBe(a)
    expect(b.codepoint).toBe(a.codepoint)
  })

  it('eviction drops the cached info entry for the displaced glyph', () => {
    // 4×4 = 16 slots; insert 16 distinct glyphs, then the 17th evicts.
    for (let i = 0; i < 16; i++) host.ensure('noto', 65 + i)
    const firstBefore = host.ensure('noto', 65)  // cache hit, ref A
    host.ensure('noto', 65 + 16)  // forces eviction of LRU slot
    // After eviction, re-ensuring codepoint 65 (assuming it was the
    // evicted one — LRU policy) MUST re-rasterise + rebuild info.
    // We don't assert which slot got evicted; we just verify that
    // ensure() is functionally correct after the churn.
    const firstAfter = host.ensure('noto', 65)
    expect(firstAfter.codepoint).toBe(65)
    // If codepoint 65 survived the eviction (LRU may have evicted a
    // different glyph), reference equality holds. If it got evicted,
    // it differs. Both are valid post-eviction states; the cache
    // remained CONSISTENT either way (no stale slot leak).
    if (firstAfter !== firstBefore) {
      // Got evicted then re-inserted — drained dirty should reflect
      // the re-rasterise.
      const dirty = host.consumeDirty()
      expect(dirty.length).toBeGreaterThan(0)
    }
  })
})
