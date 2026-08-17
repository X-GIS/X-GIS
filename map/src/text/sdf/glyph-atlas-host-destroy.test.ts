import { describe, it, expect } from 'vitest'
import { GlyphAtlasHost } from './glyph-atlas-host'
import type { GlyphRasterizer, GlyphRasterRequest, GlyphRasterResult } from './glyph-rasterizer'

// #1404 — GlyphAtlasHost had no destroy()/dispose(): teardown relied on the
// unenforced invariant that no reference to the host escapes the TextStage
// subtree (see TextStage.destroy(), text-stage.ts). This pins the fields
// destroy() must release and that a fresh (never-before-cached) glyph still
// ensures correctly afterward — destroy() drops the caches, not the host's
// ability to do new work. On origin/main this fails by construction: there
// is no `destroy` method, so `host.destroy()` throws `TypeError: host.destroy
// is not a function`.

/** Constant-metric stub. This test asserts cache membership, not SDF bytes. */
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

/** TypeScript `private` is not a runtime barrier — read the retained fields
 *  directly, same pattern as glyph-atlas-host-memo-bound.test.ts. */
interface HostPrivates {
  metrics: Map<number, unknown>
  infoCache: Map<number, unknown>
  stringInfoCache: Map<string, unknown>
  preloadedAtGen: Map<string, number>
  hasAllGlyphsAtGen: Map<string, number>
  dirty: unknown[]
  evictions: unknown[]
  stale: Set<number>
  fontKeyId: Map<string, number>
}
const privatesOf = (h: GlyphAtlasHost): HostPrivates => h as unknown as HostPrivates

describe('GlyphAtlasHost.destroy() (#1404)', () => {
  it('empties every retained cache and still ensures a fresh glyph correctly afterward', () => {
    // 2x2 slots (pageSize/slotSize = 2) so a 5th distinct codepoint forces an
    // eviction — exercises `evictions` and repeated churn on `metrics` /
    // `infoCache`, not just the append-only path.
    const host = new GlyphAtlasHost({ slotSize: 8, pageSize: 16 }, new StubRasterizer(), {
      fontSize: 24,
      sdfRadius: 4,
    })
    const p = privatesOf(host)

    host.ensureString(FONT, 'ABCDE') // 5 distinct codepoints > 4 slots -> an eviction
    host.preloadString(FONT, 'ABCDE') // re-walks all 5 -> further churn
    expect(host.hasAllGlyphs(FONT, 'BCDE')).toBe(true) // the 4 currently-resident glyphs
    host.invalidate(FONT, 'B'.codePointAt(0)!) // stale entry, deliberately never re-ensured

    // Premise: every field destroy() is responsible for actually holds
    // something pre-destroy. Without this, "destroy() empties them" could
    // pass vacuously against maps that were already empty.
    expect(p.metrics.size, 'premise: metrics populated').toBeGreaterThan(0)
    expect(p.infoCache.size, 'premise: infoCache populated').toBeGreaterThan(0)
    expect(p.stringInfoCache.size, 'premise: stringInfoCache populated').toBeGreaterThan(0)
    expect(p.preloadedAtGen.size, 'premise: preloadedAtGen populated').toBeGreaterThan(0)
    expect(p.hasAllGlyphsAtGen.size, 'premise: hasAllGlyphsAtGen populated').toBeGreaterThan(0)
    expect(p.dirty.length, 'premise: dirty populated').toBeGreaterThan(0)
    expect(p.evictions.length, 'premise: evictions populated').toBeGreaterThan(0)
    expect(p.stale.size, 'premise: stale populated').toBeGreaterThan(0)
    expect(p.fontKeyId.size, 'premise: fontKeyId populated').toBeGreaterThan(0)

    host.destroy()

    expect(p.metrics.size).toBe(0)
    expect(p.infoCache.size).toBe(0)
    expect(p.stringInfoCache.size).toBe(0)
    expect(p.preloadedAtGen.size).toBe(0)
    expect(p.hasAllGlyphsAtGen.size).toBe(0)
    expect(p.dirty.length).toBe(0)
    expect(p.evictions.length).toBe(0)
    expect(p.stale.size).toBe(0)
    expect(p.fontKeyId.size).toBe(0)
    // The public drain methods stay well-defined (empty), not just the
    // private backing fields.
    expect(host.consumeDirty()).toEqual([])
    expect(host.consumeEvictions()).toEqual([])

    // A brand-new glyph (never cached pre-destroy) still ensures correctly —
    // destroy() is terminal for glyphs it had already cached (like the
    // sibling TextRenderer.destroy() / GlyphAtlasGPU.destroy(), it does not
    // guarantee re-use of pre-destroy state), but the host itself keeps
    // working for fresh admissions.
    const info = host.ensure(FONT, 'Z'.codePointAt(0)!)
    expect(info.width).toBe(16)
    expect(p.metrics.size).toBe(1)
  })
})
