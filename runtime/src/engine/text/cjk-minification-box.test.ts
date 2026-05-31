// Mechanism gate for the dense-CJK "solid box" bug at small display size, and
// the evidence that the fix must be local-ideograph (render at display size),
// NOT a better atlas sampler/mipmaps.
//
// SYMPTOM (headed, ortho z0): dense Han glyphs (e.g. 国) render as solid dark
// rectangles at z0 display size (~9px) while latin/Hangul survive and z4
// (~17px) is crisp. ROOT (confirmed in code): glyphs are baked once at
// rasterFontSize=24 (text-stage.ts) into an SDF atlas that has NO mipmaps
// (glyph-atlas-gpu.ts: linear/linear sampler, no mipmapFilter; createTexture
// has no mipLevelCount), and the text shader samples it bilinearly
// (shaders/text.ts:65). Displaying that 24px glyph at 9px is a 0.375×
// minification of a fixed-resolution glyph.
//
// This CPU model is NOT a pixel-faithful reproduction — the true symptom needs
// the real 2D glyph + font hinting + GPU sampling (the headed ortho z0
// screenshot is the faithful reproduction). What it DOES show deterministically
// is the two facts that decide the fix:
//   (1) minifying a fixed-size dense glyph INFLATES its displayed ink fraction
//       above the glyph's native ink (worst at the smallest size), and
//   (2) area-correct filtering (what mipmaps would buy) does NOT rescue it —
//       so the fix cannot be "add mips / a better sampler"; the glyph must be
//       rasterized AT the display size with hinting (local-ideograph, the
//       MapLibre approach). See .omc/plans/local-ideograph-cjk-2026-05-31.md.

import { describe, it, expect } from 'vitest'

const ATLAS = 24 // rasterFontSize / SDF atlas glyph cell (text-stage.ts)
const RADIUS = 8 // TinySDF radius
const EDGE = 0.75 // shaders/text.ts:68
const SLOPE = 1 / RADIUS // SDF units per atlas pixel of distance

const soft = (fontSizePx: number): number => Math.max(2.52 / Math.max(fontSizePx, 1), 1 / 255)

function fillA(sdf: number, fontSizePx: number): number {
  const s = soft(fontSizePx)
  const lo = EDGE - s, hi = EDGE + s
  const t = Math.min(1, Math.max(0, (sdf - lo) / (hi - lo)))
  return t * t * (3 - 2 * t)
}

// 1D slice through a DENSE Han glyph (e.g. 国): frame | gap | inner | gap | frame.
function buildDenseGlyphSdf(): Float32Array {
  const strokes: Array<[number, number]> = [[1, 3], [7, 9], [11, 13], [15, 17], [21, 23]]
  const row = new Float32Array(ATLAS)
  for (let x = 0; x < ATLAS; x++) {
    let best = -Infinity
    for (const [a, b] of strokes) {
      const inside = x >= a && x <= b
      const d = inside ? Math.min(x - a, b - x) + 0.5 : -Math.min(Math.abs(x - a), Math.abs(x - b))
      if (d > best) best = d
    }
    row[x] = Math.min(1, Math.max(0, EDGE + best * SLOPE))
  }
  return row
}

function bilinearNoMip(row: Float32Array, atlasX: number): number {
  const x0 = Math.floor(atlasX), f = atlasX - x0
  const a = row[Math.min(row.length - 1, Math.max(0, x0))]!
  const b = row[Math.min(row.length - 1, Math.max(0, x0 + 1))]!
  return a * (1 - f) + b * f
}

function areaAverage(row: Float32Array, centerAtlasX: number, footprint: number): number {
  const lo = centerAtlasX - footprint / 2, hi = centerAtlasX + footprint / 2
  const n = Math.max(2, Math.ceil(footprint) * 4)
  let sum = 0
  for (let i = 0; i < n; i++) sum += bilinearNoMip(row, lo + ((i + 0.5) / n) * (hi - lo))
  return sum / n
}

function fillFraction(displaySize: number, sampler: (row: Float32Array, cx: number, fp: number) => number): number {
  const row = buildDenseGlyphSdf()
  const stride = ATLAS / displaySize
  let filled = 0
  for (let i = 0; i < displaySize; i++) {
    const cx = (i + 0.5) * stride
    if (fillA(sampler(row, cx, stride), displaySize) > 0.5) filled++
  }
  return filled / displaySize
}

const pointFill = (d: number): number => fillFraction(d, (row, cx) => bilinearNoMip(row, cx))
const areaFill = (d: number): number => fillFraction(d, (row, cx, fp) => areaAverage(row, cx, fp))
const nativeFill = pointFill(ATLAS) // 1:1, no minification — the glyph's true ink

describe('dense CJK minification box-out → fix must be local-ideograph', () => {
  it('minifying the fixed-size glyph to z0 (~9px) INFLATES its ink above native', () => {
    // The box-out direction: the displayed glyph reads as MORE ink than it is.
    expect(pointFill(9)).toBeGreaterThan(nativeFill + 0.05)
  })

  it('the box-out is worst at the smallest display size (z0 worse than z4)', () => {
    expect(pointFill(9)).toBeGreaterThan(pointFill(17))
  })

  it('area-correct filtering (what mipmaps buy) does NOT rescue it → mips are not the fix', () => {
    // Within noise of the point-sample: better filtering of a fixed-size glyph
    // can't recover detail the source resolution never had at this size. The
    // glyph must be rasterized AT the display size (local-ideograph) instead.
    expect(Math.abs(areaFill(9) - pointFill(9))).toBeLessThan(0.1)
  })
})
