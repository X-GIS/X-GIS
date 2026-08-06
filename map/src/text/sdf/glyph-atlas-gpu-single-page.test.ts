// ═══ #1580 leg C — GlyphAtlasGPU owns the single-page contract explicitly ═══
//
// `AtlasState.allocatePage()` is reachable only once (see atlas-state.ts's
// header) — `host.state.pageCount` can therefore never exceed 1.
// `GlyphAtlasGPU` used to loop/defend against that as if it were a live
// growth case (`while (pages.length < host.state.pageCount) addPage()`, plus
// a "host outpaced us" fallback inside the upload loop) — dead generality
// for a page count that can never appear. Replaced with a single texture and
// an explicit assertion, so any future violation of the AtlasState invariant
// fails loudly here instead of silently degrading.

import { describe, it, expect } from 'vitest'
import { GlyphAtlasHost } from './glyph-atlas-host'
import { GlyphAtlasGPU } from './glyph-atlas-gpu'
import { MockRasterizer } from './glyph-rasterizer'

// 2x2 slots = capacity 4 — small enough to force LRU eviction+reuse (which
// must NOT be mistaken for page growth) with a handful of glyphs.
const cfg = { slotSize: 24, pageSize: 48 }
const opts = { fontSize: 16, sdfRadius: 6 }

function makeStubRhi() {
  const counters = { createTexture: 0, createView: 0, writeTexture: 0, destroyTexture: 0 }
  const rhi = {
    createSampler: () => ({ __sampler: true }),
    createTexture: () => {
      counters.createTexture++
      return { __tex: counters.createTexture }
    },
    createView: () => {
      counters.createView++
      return { __view: counters.createView }
    },
    writeTexture: () => {
      counters.writeTexture++
    },
    destroyTexture: () => {
      counters.destroyTexture++
    },
  }
  return { rhi, counters }
}

describe('#1580 leg C — GlyphAtlasGPU is single-page by contract', () => {
  it('allocates the page texture exactly once, across many evictions', () => {
    const host = new GlyphAtlasHost(cfg, new MockRasterizer(), opts)
    const { rhi, counters } = makeStubRhi()
    const gpu = new GlyphAtlasGPU(rhi as never, host, { pageSize: cfg.pageSize })

    // Fill the 4-slot atlas, flush, then keep ensuring NEW glyphs — every
    // ensure() past the 4th evicts an old slot and reuses it. This must
    // never grow pageCount past 1 or call createTexture more than once.
    for (let cp = 0; cp < 40; cp++) {
      host.ensure('noto', cp)
      gpu.flush()
    }

    expect(gpu.pageCount, 'pageCount must stay 1 — capacity is a ceiling, not a working set').toBe(
      1,
    )
    expect(counters.createTexture, 'the page texture is allocated exactly once').toBe(1)
    expect(counters.writeTexture, 'every ensure()+flush() still uploads its glyph').toBe(40)
  })

  it('CONTROL — getPage/pageView throw on any index other than 0, proving the assertion is live', () => {
    const host = new GlyphAtlasHost(cfg, new MockRasterizer(), opts)
    const { rhi } = makeStubRhi()
    const gpu = new GlyphAtlasGPU(rhi as never, host, { pageSize: cfg.pageSize })
    host.ensure('noto', 1)
    gpu.flush()

    expect(gpu.getPage(0)).toBeDefined()
    expect(() => gpu.getPage(1)).toThrow(/single-page/)
    expect(() => gpu.pageView(1)).toThrow(/single-page/)
  })
})
