import { describe, it, expect } from 'vitest'
import { GlyphAtlasHost } from '@xgis/map'
import type { GlyphRasterizer, GlyphRasterRequest, GlyphRasterResult } from '@xgis/map'

// Regression — low-zoom CJK labels dropping every glyph whose PBF range landed
// AFTER the label was first shaped (only the early-landed high-frequency 市
// rendered; 仙台/新潟/横浜/大阪 vanished). ROOT: GlyphAtlasHost.invalidate() (the
// PBF land-upgrade path) marked the slot stale but did NOT bump _generation, so
// the generation-keyed STRING caches (stringInfoCache / preloadedAtGen /
// hasAllGlyphsAtGen, iter-233/#10) short-circuited BEFORE ensure() was reached —
// the stale zero-SDF fallback survived every subsequent frame, forever.
//
// glyph-resource-landed-forward.test.ts proved the onLanded BELL rings, but not
// that the glyph actually upgrades on the next shape — the gap this closes.

/** Rasterizer that returns a zero-SDF "fallback" until `real` is flipped, then a
 *  "real" glyph. Counts rasterize calls per codepoint so the test can assert the
 *  glyph is (or isn't) re-rasterised after invalidate(). */
class FlipRasterizer implements GlyphRasterizer {
  real = false
  readonly calls = new Map<number, number>()
  rasterize(req: GlyphRasterRequest): GlyphRasterResult {
    this.calls.set(req.codepoint, (this.calls.get(req.codepoint) ?? 0) + 1)
    return {
      fontKey: req.fontKey,
      codepoint: req.codepoint,
      sdfRadius: req.sdfRadius,
      sdf: new Uint8Array(req.slotSize * req.slotSize),
      advanceWidth: this.real ? 20 : 10,
      bearingX: 0,
      bearingY: this.real ? 18 : 0,
      width: this.real ? 16 : 0,
      height: this.real ? 16 : 0,
      pbf: this.real,
      rasterFontSize: req.fontSize,
    }
  }
}

const FONT = 'test-font'
const A = 0x41
const B = 0x42

describe('GlyphAtlasHost: a late-landed glyph upgrades on the next ensureString', () => {
  it('invalidate() bumps generation so ensureString re-rasterises the PBF-upgraded glyph', () => {
    const ras = new FlipRasterizer()
    const host = new GlyphAtlasHost({ slotSize: 64, pageSize: 256 }, ras, { fontSize: 24, sdfRadius: 8 })

    // First shape — PBF range not landed yet → zero-SDF fallback.
    const first = host.ensureString(FONT, 'A')
    expect(first[0].pbf).toBe(false)
    expect(ras.calls.get(A)).toBe(1)

    // Same generation → string-cache hit, no re-raster (the perf memo working).
    host.ensureString(FONT, 'A')
    expect(ras.calls.get(A)).toBe(1)

    // The PBF range lands: real SDF now available, cache invalidates the slot.
    ras.real = true
    const genBefore = host.getGeneration()
    host.invalidate(FONT, A)
    expect(host.getGeneration(), 'invalidate must bump generation so the string caches miss').toBe(genBefore + 1)

    // The next ensureString MUST re-rasterise (upgrade), not serve the stale
    // fallback array. This is the bug: without the generation bump the string
    // cache short-circuits and the glyph never upgrades.
    const upgraded = host.ensureString(FONT, 'A')
    expect(ras.calls.get(A), 'glyph must be re-rasterised after invalidate()').toBe(2)
    expect(upgraded[0].pbf, 'late-landed glyph must upgrade to the real SDF').toBe(true)
    expect(upgraded[0].advanceWidth).toBe(20)
  })

  it('invalidateAll() upgrades every fallback glyph when a provider is added at runtime', () => {
    // The synchronous twin of the async-land bug: XGISMap.addGlyphProvider adds a
    // source AFTER labels were shaped with the fallback. invalidateAll() must bump
    // generation + mark all stale so every glyph re-rasterises through the new chain.
    const ras = new FlipRasterizer()
    const host = new GlyphAtlasHost({ slotSize: 64, pageSize: 256 }, ras, { fontSize: 24, sdfRadius: 8 })

    const first = host.ensureString(FONT, 'AB')
    expect(first.every((g) => !g.pbf)).toBe(true)
    expect(ras.calls.get(A)).toBe(1)
    expect(ras.calls.get(B)).toBe(1)

    // A runtime-added provider now supplies the real glyphs.
    ras.real = true
    const gen = host.getGeneration()
    host.invalidateAll()
    expect(host.getGeneration(), 'invalidateAll must bump generation').toBe(gen + 1)

    const upgraded = host.ensureString(FONT, 'AB')
    expect(upgraded.every((g) => g.pbf), 'every fallback glyph must upgrade after invalidateAll').toBe(true)
    expect(ras.calls.get(A)).toBe(2)
    expect(ras.calls.get(B)).toBe(2)
  })
})
