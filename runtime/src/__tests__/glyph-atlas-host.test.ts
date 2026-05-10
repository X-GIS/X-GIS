import { describe, it, expect, beforeEach } from 'vitest'
import { GlyphAtlasHost } from '../engine/text/sdf/glyph-atlas-host'
import { MockRasterizer } from '../engine/text/sdf/glyph-rasterizer'

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

describe('GlyphAtlasHost — fontKey isolation', () => {
  it('same codepoint, different font → different slot + dirty entry', () => {
    host.ensure('noto-regular', 65)
    host.ensure('noto-bold', 65)
    const dirty = host.consumeDirty()
    expect(dirty).toHaveLength(2)
    expect(dirty[0]!.slot).not.toEqual(dirty[1]!.slot)
  })
})
