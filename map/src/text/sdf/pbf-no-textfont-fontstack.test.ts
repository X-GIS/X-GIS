// ═══ #2259 — a label with NO `text-font` must not ask for a CJK-chain fontstack ═══
//
// `composeFontKey` returns `STAGE_DEFAULTS.defaultFont` verbatim when `def.font`
// is empty (text-stage-helpers.ts:388-392), and that default IS
// `CJK_FALLBACK_CHAIN` (text-stage-helpers.ts:679) — a CSS-only family list the
// engine appends so Canvas2D can reach OS Han/Hangul glyphs.
//
// `CJK_CHAIN_MARKERS[0]` is the chain's FIRST entry, so for such a label
// `splitUserFamilies` slices at index 0 and returns []. `deriveFontstack` then
// takes its `??` arm and re-derives a fontstack from the very chain the marker
// exists to strip, producing "Noto Sans CJK KR Regular" — a name no PBF glyph
// server ships. The request 404s, a dev server answers with an HTML error page,
// and the reader dies on `PbfReader: unknown wire type 4`.
//
// Fail-before: delete the `splitUserFamilies(...).length === 0` early return in
// PbfRasterizer.rasterize and the first test below reds, naming the fontstack
// that was asked for.

import { describe, it, expect } from 'vitest'
import { MockRasterizer, FONT_KEY_SENTINEL } from './glyph-rasterizer'
import { PbfRasterizer, deriveFontstack, splitUserFamilies } from './pbf-rasterizer'
import { CJK_FALLBACK_CHAIN } from '../text-stage-helpers'
import type { GlyphProvider } from './pbf/glyph-provider'
import type { GlyphRasterRequest, GlyphRasterResult } from './glyph-rasterizer'

function fontKeyOf(family: string): string {
  return `${FONT_KEY_SENTINEL}normal${FONT_KEY_SENTINEL}400${FONT_KEY_SENTINEL}${family}`
}

const REQ = { fontSize: 32, codepoint: 0x41, sdfRadius: 8, slotSize: 64 } as const

/** Records every fontstack the rasterizer probes for. */
function spyProvider(seen: string[]): GlyphProvider {
  return {
    get(fontstack: string) {
      seen.push(fontstack)
      return undefined
    },
  }
}

/** A fallback that reports which of the two rasterizers was reached. */
function tagged(tag: string, out: string[]): MockRasterizer {
  const m = new MockRasterizer()
  const real = m.rasterize.bind(m)
  m.rasterize = (req: GlyphRasterRequest): GlyphRasterResult => {
    out.push(tag)
    return real(req)
  }
  return m
}

describe('#2259 — the CJK fallback chain is not a fontstack', () => {
  it('the premise: an empty text-font leaves NO user families', () => {
    // If this ever stops holding, the defect below is gone for a different
    // reason and the guard is dead code — say so loudly rather than passing.
    expect(splitUserFamilies(CJK_FALLBACK_CHAIN)).toEqual([])
    // …and this is what the old code then asked the glyph server for.
    expect(deriveFontstack(fontKeyOf(CJK_FALLBACK_CHAIN))).toBe('Noto Sans CJK KR Regular')
  })

  it('no provider is ever asked for a chain-derived fontstack', () => {
    const seen: string[] = []
    const ras = new PbfRasterizer({
      fallback: new MockRasterizer(),
      providers: [spyProvider(seen)],
      onLanded: () => {},
    })

    ras.rasterize({ fontKey: fontKeyOf(CJK_FALLBACK_CHAIN), ...REQ })

    expect(
      seen,
      `a glyph provider was asked for ${JSON.stringify(seen)} — the CJK fallback chain is a CSS family list, not a fontstack any PBF server ships, so this request is a guaranteed 404`,
    ).toEqual([])
  })

  it('and the frame is served by fullFallback — the same steady state, reached sooner', () => {
    const reached: string[] = []
    const ras = new PbfRasterizer({
      fallback: tagged('metrics-only', reached),
      fullFallback: tagged('fullFallback', reached),
      providers: [spyProvider([])],
      onLanded: () => {},
    })

    ras.rasterize({ fontKey: fontKeyOf(CJK_FALLBACK_CHAIN), ...REQ })

    // NOT `fallback` (the cheap metrics-only path used while a PBF is still in
    // flight): nothing is in flight, so the full drawing path is correct — and
    // it is exactly where `noGlyphIsComing` lands after the doomed round trip.
    expect(reached).toEqual(['fullFallback'])
  })

  it('CONTROL — an authored text-font still routes to the PBF server', () => {
    // Without this the guard could swallow every label and all three tests
    // above would still pass.
    const seen: string[] = []
    const ras = new PbfRasterizer({
      fallback: new MockRasterizer(),
      providers: [spyProvider(seen)],
      onLanded: () => {},
    })

    ras.rasterize({ fontKey: fontKeyOf(`"Open Sans",${CJK_FALLBACK_CHAIN}`), ...REQ })

    expect(seen, 'an authored family must still reach the providers').toEqual(['Open Sans Regular'])
  })
})
