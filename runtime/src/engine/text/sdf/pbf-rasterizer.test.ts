import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MockRasterizer, FONT_KEY_SENTINEL,
} from './glyph-rasterizer'
import { GlyphPbfCache } from './pbf/glyph-pbf-cache'
import { PbfRasterizer, deriveFontstack } from './pbf-rasterizer'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, 'pbf', '__fixtures__', 'open-sans-semibold-0-255.pbf')
const PBF_BYTES = readFileSync(FIXTURE)

function fontKeyOf(style: string, weight: number, family: string): string {
  return `${FONT_KEY_SENTINEL}${style}${FONT_KEY_SENTINEL}${weight}${FONT_KEY_SENTINEL}${family}`
}

describe('deriveFontstack', () => {
  it('reverses standard weight keywords', () => {
    expect(deriveFontstack(fontKeyOf('normal', 600, 'Open Sans'))).toBe('Open Sans Semibold')
    expect(deriveFontstack(fontKeyOf('normal', 400, 'Noto Sans'))).toBe('Noto Sans Regular')
    expect(deriveFontstack(fontKeyOf('normal', 700, 'Roboto'))).toBe('Roboto Bold')
    expect(deriveFontstack(fontKeyOf('italic', 700, 'Roboto'))).toBe('Roboto Bold Italic')
    expect(deriveFontstack(fontKeyOf('normal', 900, 'Heavy Sans'))).toBe('Heavy Sans Black')
  })

  it('picks the first family from a CSS comma list (CJK fallback chain)', () => {
    expect(deriveFontstack(fontKeyOf('normal', 600,
      'Open Sans, "Noto Sans CJK KR", sans-serif'))).toBe('Open Sans Semibold')
  })

  it('falls back to Regular for unknown weights', () => {
    expect(deriveFontstack(fontKeyOf('normal', 123 as never, 'X'))).toBe('X Regular')
  })

  it('handles plain (sentinel-less) fontKeys as weight=400', () => {
    expect(deriveFontstack('Plain Family')).toBe('Plain Family Regular')
  })
})

describe('PbfRasterizer', () => {
  const slotSize = 64, sdfRadius = 8, fontSize = 32

  it('returns PBF SDF on cache hit', async () => {
    const fetchOK = () => Promise.resolve(new Response(PBF_BYTES, { status: 200 }))
    const cache = new GlyphPbfCache({ glyphsUrl: 'https://x/{fontstack}/{range}.pbf', fetch: fetchOK })
    await new Promise<void>(r => cache.ensure('Open Sans Semibold', 0x41, r))

    const fallback = new MockRasterizer()
    const landed: Array<{ fontKey: string; codepoint: number }> = []
    const ras = new PbfRasterizer({
      fallback, providers: [cache], onLanded: (fontKey, codepoint) => landed.push({ fontKey, codepoint }),
    })

    const fontKey = fontKeyOf('normal', 600, 'Open Sans')
    const out = ras.rasterize({
      fontKey, fontSize, codepoint: 0x41, sdfRadius, slotSize,
    })

    // PBF path emits an SDF with metrics scaled from PBF 24-px reference.
    // MockRasterizer would emit a much larger advance (fontSize * 0.6 = 19.2).
    // PBF Open Sans Semibold 'A' advance ≈ 14 → scaled to (14 * 32/24) ≈ 18.7.
    // Close-ish, so check more discriminating: bearingY (PBF top ≈ 17, MockRasterizer
    // returns fontSize * 0.7 = 22.4 — clearly different).
    expect(out.bearingY).toBeLessThan(20)
    expect(landed).toHaveLength(0)  // hit path doesn't invalidate
  })

  it('falls back to Canvas2D/Mock on miss + schedules fetch + fires onLanded', async () => {
    const fetchOK = () => Promise.resolve(new Response(PBF_BYTES, { status: 200 }))
    const cache = new GlyphPbfCache({ glyphsUrl: 'https://x/{fontstack}/{range}.pbf', fetch: fetchOK })
    const fallback = new MockRasterizer()
    const landed: Array<{ fontKey: string; codepoint: number }> = []

    const ras = new PbfRasterizer({
      fallback, providers: [cache], onLanded: (fontKey, codepoint) => landed.push({ fontKey, codepoint }),
    })

    const fontKey = fontKeyOf('normal', 600, 'Open Sans')
    const out = ras.rasterize({
      fontKey, fontSize, codepoint: 0x41, sdfRadius, slotSize,
    })

    // Miss path produces a MockRasterizer-style output (deterministic disc).
    expect(out.bearingY).toBeCloseTo(fontSize * 0.7, 5)
    expect(landed).toHaveLength(0)  // hasn't landed yet

    // Wait for the fetch to settle. The cache resolves on a microtask
    // chain (await response → arrayBuffer → decode).
    await new Promise<void>(r => setTimeout(r, 20))

    expect(landed).toHaveLength(1)
    expect(landed[0]!.fontKey).toBe(fontKey)
    expect(landed[0]!.codepoint).toBe(0x41)

    // Subsequent rasterize() now hits the PBF path.
    const out2 = ras.rasterize({ fontKey, fontSize, codepoint: 0x41, sdfRadius, slotSize })
    expect(out2.bearingY).toBeLessThan(20)
  })

  it('does NOT fire onLanded when the resolved range lacks the codepoint', async () => {
    const fetchOK = () => Promise.resolve(new Response(PBF_BYTES, { status: 200 }))
    const cache = new GlyphPbfCache({ glyphsUrl: 'https://x/{fontstack}/{range}.pbf', fetch: fetchOK })
    const fallback = new MockRasterizer()
    const landed: Array<unknown> = []
    const ras = new PbfRasterizer({
      fallback, providers: [cache], onLanded: () => landed.push(1),
    })

    const fontKey = fontKeyOf('normal', 600, 'Open Sans')
    // Codepoint 0x00 — almost certainly not in the PBF.
    ras.rasterize({ fontKey, fontSize, codepoint: 0x00, sdfRadius, slotSize })
    await new Promise<void>(r => setTimeout(r, 20))

    expect(landed).toHaveLength(0)
  })

  it('stays in fallback when the fetch fails', async () => {
    const fetchFail = () => Promise.resolve(new Response('', { status: 404 }))
    const cache = new GlyphPbfCache({ glyphsUrl: 'https://x/{fontstack}/{range}.pbf', fetch: fetchFail })
    const fallback = new MockRasterizer()
    const landed: Array<unknown> = []
    const ras = new PbfRasterizer({
      fallback, providers: [cache], onLanded: () => landed.push(1),
    })

    const fontKey = fontKeyOf('normal', 600, 'Open Sans')
    const out = ras.rasterize({ fontKey, fontSize, codepoint: 0x41, sdfRadius, slotSize })
    expect(out.bearingY).toBeCloseTo(fontSize * 0.7, 5)  // Mock fallback path

    await new Promise<void>(r => setTimeout(r, 20))
    expect(landed).toHaveLength(0)

    // Subsequent rasterize stays on fallback — no retry, no scheduled fetch.
    const out2 = ras.rasterize({ fontKey, fontSize, codepoint: 0x41, sdfRadius, slotSize })
    expect(out2.bearingY).toBeCloseTo(fontSize * 0.7, 5)
  })
})
