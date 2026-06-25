// Issue #608 — point-label vertical placement parity with MapLibre.
//
// MapLibre centers the line-height box on the anchor and places each glyph's
// BASELINE per `SHAPING_DEFAULT_OFFSET`; the INK then hangs relative to that
// baseline by the glyph's own metrics (ascent ≫ descent for Latin), so the ink
// centroid is a GLYPH-METRIC-DEPENDENT offset from the anchor — NOT pinned onto
// it. X-GIS's old centre-anchor code (iter-344/345) instead recentred the ink
// BAND onto the anchor (`centreShift = -shapingBaselineOff + (maxAsc-maxDesc)/2`),
// pinning the ink centroid to ~0 for EVERY label regardless of glyph metrics —
// the #608 bug (Houston z12 ink ~19px too HIGH vs MapLibre).
//
// The fix cancels the redundant SHAPING baseline term (X-GIS `bearingY` is
// already a true baseline ascent, so the renderer's `baseline - bearingY*sc`
// needs no extra origin shift) for ALL vAlign, letting the metric-dependent
// hang flow through.
//
// This test drives the REAL TextStage.prepare() with a rasterizer that returns
// DISTINCT per-glyph metrics for caps vs lowercase, and inspects the produced
// glyphOffsets via the renderer's ink geometry (text-renderer.ts:290:
// ink_top = anchorY + lineY - bearingY*scale; ink spans height*scale). It is
// DISCRIMINATING: the metric-INDEPENDENT old behaviour pins the centroid to ~0
// and makes all-caps == mixed-case; the fix makes the centroid metric-dependent
// (non-zero) and all-caps ≠ mixed-case.

import { describe, it, expect } from 'vitest'
import { TextStage } from './text-stage'
import { computeSDF } from './sdf/distance-transform'
import type { GlyphRasterizer, GlyphRasterRequest, GlyphRasterResult } from './sdf/glyph-rasterizer'
import type { LabelDef, TextValue } from '@xgis/compiler'
import type { TextDraw } from './text-renderer'

// WebGPU bitflag globals the GPU classes touch at construction.
const G = globalThis as Record<string, unknown>
G.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 }
G.GPUBufferUsage ??= { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 }
G.GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 }
G.GPUColorWrite ??= { RED: 1, GREEN: 2, BLUE: 4, ALPHA: 8, ALL: 15 }

function stubDevice(): GPUDevice {
  const stub: unknown = new Proxy(function () { return stub }, {
    get(_t, p) {
      if (p === 'size') return 1 << 22
      if (p === 'width' || p === 'height') return 4096
      if (p === 'limits') return { maxTextureDimension2D: 8192 }
      if (p === Symbol.toPrimitive) return () => 0
      return stub
    },
    apply() { return stub },
  })
  return stub as GPUDevice
}

// Rasterizer with realistic, DISTINCT Latin metrics: uppercase letters reach the
// cap line (taller ascent, no descender); lowercase x-height letters are shorter;
// descender letters (g/p/y) extend below the baseline. Mirrors how real PBF
// glyph metrics vary — the property the #608 fix must honour.
class LatinMetricsRasterizer implements GlyphRasterizer {
  rasterize(req: GlyphRasterRequest): GlyphRasterResult {
    const { fontKey, codepoint, sdfRadius, slotSize, fontSize } = req
    const ch = String.fromCharCode(codepoint)
    // bearingY = ascent above baseline (px @ 24 ref); height = full ink height.
    let bearingY = 0.74 * fontSize // default cap-ish
    let height = 0.74 * fontSize
    if (/[a-z]/.test(ch)) {
      if ('gjpqy'.includes(ch)) { bearingY = 0.52 * fontSize; height = 0.72 * fontSize } // x-height + descender
      else { bearingY = 0.52 * fontSize; height = 0.52 * fontSize } // x-height, no descender
    }
    // Minimal non-empty SDF so the glyph isn't culled as blank.
    const alpha = new Uint8Array(slotSize * slotSize)
    const cx = slotSize / 2, cy = slotSize / 2, r = slotSize / 5
    for (let y = 0; y < slotSize; y++)
      for (let x = 0; x < slotSize; x++)
        if (Math.hypot(x - cx, y - cy) < r) alpha[y * slotSize + x] = 255
    return {
      fontKey, codepoint, sdfRadius,
      sdf: computeSDF(alpha, slotSize, slotSize, sdfRadius),
      advanceWidth: fontSize * 0.6, bearingX: 0,
      bearingY, width: fontSize * 0.55, height, rasterFontSize: fontSize,
    }
  }
}

function litValue(s: string): TextValue {
  return { kind: 'expr', expr: { ast: { kind: 'StringLiteral', value: s } as never } }
}
function defOf(size: number, anchor: string): LabelDef {
  return { text: litValue(''), size, maxWidth: 100, font: ['Noto Sans Bold'], anchor } as LabelDef
}

/** Drive real prepare(); return the ink-block centroid relative to the anchor
 *  (screen-down +, computed via the renderer's quad geometry). */
function inkCentroidRel(text: string, size: number, anchor: string): number {
  const stage = new TextStage(stubDevice(), 'bgra8unorm', { rasterizer: new LatinMetricsRasterizer() })
  const captured: TextDraw[][] = []
  ;(stage as unknown as { renderer: { setDraws(d: TextDraw[]): void } }).renderer.setDraws =
    (d: TextDraw[]) => { captured.push(d) }
  stage.setCameraZoom(12)
  stage.beginFrame()
  stage.addLabel(litValue(text), {}, 400, 300, defOf(size, anchor))
  stage.prepare()
  const draws = captured[0]!
  const d = draws.find(dd => dd.glyphs.some(g => g.codepoint !== 10 && g.codepoint !== 32))
  expect(d, `draw for "${text}" missing`).toBeDefined()
  const off = d!.glyphOffsets!
  let minTop = Infinity, maxBot = -Infinity
  for (let i = 0; i < d!.glyphs.length; i++) {
    const g = d!.glyphs[i]!
    if (g.codepoint === 10 || g.codepoint === 32) continue
    const sc = d!.fontSize / (g.rasterFontSize ?? d!.rasterFontSize)
    const lineY = off[i * 2 + 1]!
    const inkTop = lineY - g.bearingY * sc // relative to anchor (drawY == anchorY here)
    const inkBot = inkTop + g.height * sc
    minTop = Math.min(minTop, inkTop)
    maxBot = Math.max(maxBot, inkBot)
  }
  return (minTop + maxBot) / 2
}

describe('#608 — point-label ink hangs metric-dependently from the anchor (MapLibre parity)', () => {
  it('center-anchored ink centroid is NOT pinned onto the anchor', () => {
    // The old (ink-band-recentre) code forced this to ~0 for every label; the
    // fix lets Latin ink hang ABOVE the anchor (ascent ≫ descent), so the
    // centroid is meaningfully non-zero.
    const c = inkCentroidRel('Houston', 16, 'center')
    expect(Math.abs(c)).toBeGreaterThan(1.5) // not centered on the anchor
  })

  it('DISCRIMINATING: all-caps vs all-lowercase centroids DIFFER (metric-dependent, not constant)', () => {
    // The whole point of #608: the hang depends on per-glyph metrics
    // (-bearingY + height/2). An all-CAPS word reaches the cap line (tall
    // ascent); an all-lowercase x-height word is shorter — so their ink blocks
    // sit at different heights relative to the anchor. The old metric-independent
    // ink-recentre pinned BOTH centroids to ~0 (equal) — this assertion fails there;
    // the fix makes them differ.
    const caps = inkCentroidRel('HOUSTON', 16, 'center')
    const lower = inkCentroidRel('xnwmuosv', 16, 'center') // lowercase, no descenders
    expect(Math.abs(caps - lower)).toBeGreaterThan(0.8)
  })

  it('bottom-anchored ink sits ABOVE the anchor (text on the point), not floating ~1em too high', () => {
    // Bottom anchor: text rises from the point. The fix lowers it by the
    // (previously double-counted) SHAPING term — still above the anchor but no
    // longer ~1em too high. We assert it is above (negative) AND not absurdly
    // high (centroid within ~1.2 line-heights above the anchor at this size).
    const c = inkCentroidRel('Houston', 18, 'bottom')
    expect(c).toBeLessThan(0) // above the anchor
    expect(c).toBeGreaterThan(-1.2 * 18) // not floating a full line-height+ above
  })

  it('top-anchored ink sits BELOW the anchor (text hangs under the point)', () => {
    const c = inkCentroidRel('Houston', 18, 'top')
    expect(c).toBeGreaterThan(0) // below the anchor
  })

  it('the SHAPING baseline term is cancelled (center ink scales with text size, no constant pin)', () => {
    // If the ink were pinned to the anchor (old bug), doubling the size would
    // keep the centroid ~0. With the fix, the metric-dependent hang scales with
    // size, so the centroid magnitude grows roughly proportionally.
    const c16 = inkCentroidRel('Houston', 16, 'center')
    const c32 = inkCentroidRel('Houston', 32, 'center')
    expect(Math.abs(c32)).toBeGreaterThan(Math.abs(c16) * 1.5)
  })
})
