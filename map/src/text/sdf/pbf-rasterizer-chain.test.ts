// Chain-of-responsibility composition test — proves the order matters,
// later providers can be appended dynamically, and a sync-only inline
// provider correctly shadows the HTTP path without firing fetches.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MockRasterizer, FONT_KEY_SENTINEL } from './glyph-rasterizer'
import { GlyphPbfCache } from './pbf/glyph-pbf-cache'
import { InlineGlyphProvider } from './pbf/inline-glyph-provider'
import { PbfRasterizer } from './pbf-rasterizer'
import type { GlyphProvider } from './pbf/glyph-provider'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, 'pbf', '__fixtures__', 'open-sans-semibold-0-255.pbf')
const PBF_BYTES = new Uint8Array(readFileSync(FIXTURE))

function fontKeyOf(weight: number, family: string): string {
  return `${FONT_KEY_SENTINEL}normal${FONT_KEY_SENTINEL}${weight}${FONT_KEY_SENTINEL}${family}`
}

const slotSize = 64, sdfRadius = 8, fontSize = 32

describe('PbfRasterizer chain composition', () => {
  it('inline provider shadows HTTP — fetch never fires when inline hits', async () => {
    let fetchCalls = 0
    const inline = new InlineGlyphProvider({ 'Open Sans Semibold': { 0: PBF_BYTES } })
    const cache = new GlyphPbfCache({
      glyphsUrl: 'https://x/{fontstack}/{range}.pbf',
      fetch: () => { fetchCalls += 1; return Promise.resolve(new Response('', { status: 200 })) },
    })
    const ras = new PbfRasterizer({
      fallback: new MockRasterizer(),
      providers: [inline, cache],
      onLanded: () => {},
    })

    ras.rasterize({ fontKey: fontKeyOf(600, 'Open Sans'), fontSize, codepoint: 0x41, sdfRadius, slotSize })

    // Inline had the glyph → no need to fetch.
    expect(fetchCalls).toBe(0)
  })

  it('falls through to HTTP when inline misses', async () => {
    let fetchCalls = 0
    const inline = new InlineGlyphProvider({})  // empty
    const cache = new GlyphPbfCache({
      glyphsUrl: 'https://x/{fontstack}/{range}.pbf',
      fetch: () => { fetchCalls += 1; return Promise.resolve(new Response(PBF_BYTES, { status: 200 })) },
    })
    const ras = new PbfRasterizer({
      fallback: new MockRasterizer(),
      providers: [inline, cache],
      onLanded: () => {},
    })

    ras.rasterize({ fontKey: fontKeyOf(600, 'Open Sans'), fontSize, codepoint: 0x41, sdfRadius, slotSize })
    await new Promise<void>(r => setTimeout(r, 20))

    expect(fetchCalls).toBe(1)
  })

  it('addProvider extends the chain dynamically — new provider visible on next rasterize', () => {
    const ras = new PbfRasterizer({
      fallback: new MockRasterizer(),
      providers: [],
      onLanded: () => {},
    })
    const fontKey = fontKeyOf(600, 'Open Sans')

    // First rasterize with empty chain → fallback (MockRasterizer).
    const out1 = ras.rasterize({ fontKey, fontSize, codepoint: 0x41, sdfRadius, slotSize })
    expect(out1.bearingY).toBeCloseTo(fontSize * 0.7, 5)  // Mock fingerprint

    // Add inline provider; next rasterize hits it.
    ras.addProvider(new InlineGlyphProvider({ 'Open Sans Semibold': { 0: PBF_BYTES } }))
    const out2 = ras.rasterize({ fontKey, fontSize, codepoint: 0x41, sdfRadius, slotSize })
    expect(out2.bearingY).toBeLessThan(20)  // PBF fingerprint
  })

  it('multiple async providers — first to land triggers onLanded', async () => {
    // Two HTTP-backed caches racing. Whoever resolves first wins.
    let landed = 0
    const slowCache = new GlyphPbfCache({
      glyphsUrl: 'https://slow/{fontstack}/{range}.pbf',
      fetch: () => new Promise<Response>(r => setTimeout(
        () => r(new Response(PBF_BYTES, { status: 200 })), 50)),
    })
    const fastCache = new GlyphPbfCache({
      glyphsUrl: 'https://fast/{fontstack}/{range}.pbf',
      fetch: () => Promise.resolve(new Response(PBF_BYTES, { status: 200 })),
    })
    const ras = new PbfRasterizer({
      fallback: new MockRasterizer(),
      providers: [slowCache, fastCache],
      onLanded: () => { landed += 1 },
    })

    ras.rasterize({ fontKey: fontKeyOf(600, 'Open Sans'), fontSize, codepoint: 0x41, sdfRadius, slotSize })

    // Wait long enough for the fast one but not the slow one.
    await new Promise<void>(r => setTimeout(r, 10))
    expect(landed).toBeGreaterThanOrEqual(1)  // fast resolved

    // Slow one resolves later — that callback ALSO fires onLanded
    // (its own ensure() callback completes), but get() still returns
    // the same glyph. The atlas just does one extra redundant
    // re-rasterise pass; correctness is preserved.
    await new Promise<void>(r => setTimeout(r, 70))
    expect(landed).toBe(2)
  })

  it('sync provider with no `ensure` is skipped during async scheduling', async () => {
    // Inline alone (no HTTP) and no hit → no ensure to call, fall back
    // forever. Verifies the rasterizer doesn't crash on a chain made
    // exclusively of sync-only providers.
    const inline: GlyphProvider = {
      get: () => undefined,
      // no ensure()
    }
    const ras = new PbfRasterizer({
      fallback: new MockRasterizer(),
      providers: [inline],
      onLanded: () => { throw new Error('should not be called') },
    })

    const out = ras.rasterize({ fontKey: fontKeyOf(600, 'X'), fontSize, codepoint: 0x41, sdfRadius, slotSize })
    expect(out).toBeDefined()  // fallback served it
  })
})
