// ═══ #1580 leg D — eviction forgot to clean `stale` ═══
//
// The eviction branch in `ensure()` deletes the evicted key's `metrics` and
// `infoCache` entries but never `stale`. A glyph marked stale via
// `invalidate()`/`invalidateAll()` and then LRU-evicted before its next
// `ensure()` strands a permanent `Set` entry — pure growth (a re-ensure of an
// evicted key already has `created: true`, so the stale check is redundant
// for it), but growth all the same, forever, for a `Set` documented as
// bounded by the atlas's own capacity.

import { describe, it, expect } from 'vitest'
import { GlyphAtlasHost } from '@xgis/map'
import { type GlyphRasterizer, type GlyphRasterRequest, type GlyphRasterResult } from '@xgis/map'
import { computeSDF } from '@xgis/map'

// 2x2 slots = capacity 4 — small enough to force eviction with a handful of
// glyphs, mirroring glyph-atlas-host-invalidate.test.ts's fixture style.
const cfg = { slotSize: 24, pageSize: 48 }
const opts = { fontSize: 16, sdfRadius: 6 }

class StubRasterizer implements GlyphRasterizer {
  rasterize(req: GlyphRasterRequest): GlyphRasterResult {
    const alpha = new Uint8Array(req.slotSize * req.slotSize)
    const sdf = computeSDF(alpha, req.slotSize, req.slotSize, req.sdfRadius)
    return {
      fontKey: req.fontKey,
      codepoint: req.codepoint,
      sdfRadius: req.sdfRadius,
      sdf,
      advanceWidth: 10,
      bearingX: 0,
      bearingY: 10,
      width: 10,
      height: 10,
      rasterFontSize: req.fontSize,
    }
  }
}

interface HostPrivates {
  metrics: Map<number, unknown>
  stale: Set<number>
}
const privatesOf = (h: GlyphAtlasHost): HostPrivates => h as unknown as HostPrivates

describe('#1580 leg D — GlyphAtlasHost eviction sweeps `stale` too', () => {
  it('LRU-evicting a stale-marked glyph must not strand it in `stale` forever', () => {
    const host = new GlyphAtlasHost(cfg, new StubRasterizer(), opts)
    const priv = privatesOf(host)

    // Fill the 4-slot atlas.
    for (let cp = 0; cp < 4; cp++) host.ensure('noto', cp)
    // Mark every resident glyph stale.
    host.invalidateAll()
    expect(priv.stale.size, 'premise: invalidateAll marked all 4').toBe(4)

    // Ensure 4 DIFFERENT glyphs — every original is LRU-evicted (the atlas
    // has no free slots left) before it ever gets a chance to re-rasterise
    // and clear its own stale flag.
    for (let cp = 100; cp < 104; cp++) host.ensure('noto', cp)

    expect(priv.metrics.size, 'metrics sits at capacity, as before the fix').toBe(4)
    // None of the 4 NEW glyphs were ever marked stale, and every ORIGINAL
    // (stale-marked) glyph was evicted — so a correct sweep leaves `stale`
    // empty. Before the fix this stayed at 4 forever (the eviction branch
    // never touched it).
    expect(
      priv.stale.size,
      'stale must be swept on eviction, not stranded at the pre-eviction count',
    ).toBe(0)
  })

  it('CONTROL — a glyph that re-rasterises before eviction clears its own stale flag normally', () => {
    const host = new GlyphAtlasHost(cfg, new StubRasterizer(), opts)
    const priv = privatesOf(host)

    host.ensure('noto', 1)
    host.invalidate('noto', 1)
    expect(priv.stale.size).toBe(1)
    host.ensure('noto', 1) // re-rasterises in place — no eviction involved
    expect(priv.stale.size, 'the pre-existing self-clear path must still work').toBe(0)
  })
})
