// CJK vertical writing — the COLUMN, the CACHE KEY and the BBOX (#2144, D7 P2).
//
// WHAT THE OTHER TWO "vertical" FILES OWN, so this is not a third authority on
// the word:
//   * `text-vertical.test.ts` — the multi-LINE box of a HORIZONTAL label
//     (`mlVerticalLayout`: per-line baselines, blockTop/blockBottom against
//     MapLibre's `shapeLines` + `align()`). Nothing to do with writing mode.
//   * `text-vertical-anchor-parity.test.ts` — #608, where a horizontal label's
//     ink hangs relative to its anchor (metric-DEPENDENT), and the shield
//     exception. Also the y of a horizontal label.
// This file owns `text-writing-mode: ["vertical"]`: the column direction, its
// pitch, the per-glyph orientation, and the cache key that keeps a column from
// being served a row's layout.
//
// THE TWO ASSERTION FAMILIES ARE DELIBERATELY DISJOINT (CLAUDE.md §12, "the
// assertion that failed either way"): the ORIENTATION tests read only
// `glyphRotations` and the COLUMN tests read only `glyphOffsets`, so severing
// one write can only redden the family that names it.

import { describe, it, expect } from 'vitest'
import {
  fillVerticalColumn,
  glyphVerticalizes,
  allowsVerticalWritingMode,
  verticalWritingActive,
  layoutCacheKey,
  TextStage,
  computeSDF,
} from '@xgis/map'
import { deriveLabelBbox } from './text-stage-helpers'
import { WebGpuDevice } from '@xgis/rhi-webgpu'
import type { GlyphRasterizer, GlyphRasterRequest, GlyphRasterResult, TextDraw } from '@xgis/map'
import type { LabelDef, TextValue } from '@xgis/compiler'

const SIZE = 24
const HANGUL = '서울특별시'
const HAN = '東京都'

// ── Pure column composition ────────────────────────────────────────────────

/** `n` glyphs of the given codepoints with the given display advances. */
function column(
  text: string,
  advances: number[],
  opts: { sizePx?: number; letterSpacingPx?: number; vAlign?: 0 | 0.5 | 1 } = {},
): { offsets: Float32Array; rotations: Float32Array; blockTop: number; blockBottom: number } {
  const cps = [...text].map((c) => ({ codepoint: c.codePointAt(0)! }))
  // POISON both outputs: a Float32Array is zero-filled, so "never written" and
  // "written 0" are indistinguishable — which would make every upright-glyph
  // assertion pass against a severed write (CLAUDE.md §12, the decoy rule).
  const offsets = new Float32Array(cps.length * 2).fill(NaN)
  const rotations = new Float32Array(cps.length).fill(NaN)
  const col = fillVerticalColumn(
    cps,
    advances,
    opts.sizePx ?? SIZE,
    opts.letterSpacingPx ?? 0,
    opts.vAlign ?? 0.5,
    offsets,
    rotations,
  )
  return { offsets, rotations, ...col }
}

describe('#2144 — the column (glyphOffsets): order and pitch', () => {
  it(`COLUMN: "${HANGUL}" runs DOWN in +y, one glyph per row, in source order`, () => {
    const { offsets } = column(HANGUL, [24, 24, 24, 24, 24])
    const ys = [...HANGUL].map((_, i) => offsets[i * 2 + 1]!)
    for (let i = 1; i < ys.length; i++) {
      expect(
        ys[i]! - ys[i - 1]!,
        `COLUMN order broken: "${HANGUL}" glyph ${i} ('${[...HANGUL][i]}') is at y=${ys[i]} ` +
          `but glyph ${i - 1} is at y=${ys[i - 1]} — a vertical label must advance DOWNWARD ` +
          `in source order (offsets y-monotonic). Full column y: [${ys.join(', ')}]`,
      ).toBeGreaterThan(0)
    }
  })

  it(`COLUMN: "${HANGUL}" pitch is exactly the EM, not the per-glyph advance`, () => {
    // The advances DIFFER per glyph here on purpose: MapLibre substitutes a
    // constant ONE_EM for a verticalized glyph (shaping.ts:386) precisely
    // because there is no vertical advance in the format. A pitch that tracked
    // `advances` would come out 20/24/28/24 instead of a constant 24.
    const { offsets } = column(HANGUL, [20, 24, 28, 24, 22])
    const ys = [...HANGUL].map((_, i) => offsets[i * 2 + 1]!)
    for (let i = 1; i < ys.length; i++) {
      expect(
        ys[i]! - ys[i - 1]!,
        `COLUMN pitch is not the em: step ${i - 1}→${i} is ${ys[i]! - ys[i - 1]!} px, expected ` +
          `${SIZE} (= sizePx + letterSpacingPx). The pitch must come from the EM BOX, never ` +
          `from metrics.advance (design §5). Full column y: [${ys.join(', ')}]`,
      ).toBeCloseTo(SIZE, 6)
    }
  })

  it('COLUMN: letter-spacing adds to the em pitch, once between adjacent cells', () => {
    const { offsets, blockTop, blockBottom } = column(HAN, [24, 24, 24], {
      letterSpacingPx: 3,
    })
    expect(offsets[3]! - offsets[1]!).toBeCloseTo(27, 6)
    expect(offsets[5]! - offsets[3]!).toBeCloseTo(27, 6)
    // 3 cells + 2 gaps, centred on the anchor.
    expect(blockBottom - blockTop).toBeCloseTo(3 * 24 + 2 * 3, 6)
    expect(blockTop + blockBottom).toBeCloseTo(0, 6)
  })

  it('COLUMN: vAlign places the block top / centre / bottom on the anchor', () => {
    expect(column(HAN, [24, 24, 24], { vAlign: 0 }).blockTop).toBeCloseTo(0, 6)
    expect(column(HAN, [24, 24, 24], { vAlign: 0.5 }).blockTop).toBeCloseTo(-36, 6)
    expect(column(HAN, [24, 24, 24], { vAlign: 1 }).blockBottom).toBeCloseTo(0, 6)
  })
})

describe('#2144 — the orientation (glyphRotations): the §1.2(a) truth table', () => {
  it('ORIENTATION: every CJK glyph of the column is UPRIGHT (rotation 0)', () => {
    const { rotations } = column(HANGUL, [24, 24, 24, 24, 24])
    for (let i = 0; i < rotations.length; i++) {
      expect(
        rotations[i]!,
        `ORIENTATION wrong for "${HANGUL}" glyph ${i} ('${[...HANGUL][i]}'): rotation ` +
          `${rotations[i]} rad, expected 0 (upright). A verticalized glyph must be drawn ` +
          `UPRIGHT in its cell — that is the whole point of the per-glyph rotation array ` +
          `(design §1.2c). Full rotations: [${[...rotations].join(', ')}]`,
      ).toBeCloseTo(0, 9)
    }
  })

  it('ORIENTATION: Latin in a mixed column is UPRIGHT too — MapLibre parity, not a bug', () => {
    // §1.2(a): in the POINT path everything verticalizes except whitespace and
    // complex-shaping scripts, so Latin renders upright one-per-cell rather
    // than rotated sideways (which is what CSS text-orientation:mixed would do).
    const { rotations } = column('東A京', [24, 13, 24])
    expect(
      [...rotations],
      `ORIENTATION wrong in the mixed column "東A京": got [${[...rotations].join(', ')}], ` +
        `expected all-zero. Latin verticalizes in the point path (design §6).`,
    ).toEqual([0, 0, 0])
  })

  it('ORIENTATION: whitespace and Arabic stay horizontal (+π/2 in the column frame)', () => {
    const { rotations } = column('東 ا', [24, 8, 12])
    expect(rotations[0]!).toBeCloseTo(0, 9)
    expect(
      rotations[1]!,
      `ORIENTATION: whitespace must NOT verticalize (§1.2a), so it carries the label turn ` +
        `MapLibre would have applied: +π/2. Got ${rotations[1]}.`,
    ).toBeCloseTo(Math.PI / 2, 6)
    expect(
      rotations[2]!,
      `ORIENTATION: a complex-shaping (Arabic) glyph must NOT verticalize (§1.2a / §2). ` +
        `Got ${rotations[2]}, expected +π/2.`,
    ).toBeCloseTo(Math.PI / 2, 6)
  })

  it('the truth table itself, per codepoint', () => {
    expect(glyphVerticalizes('東'.codePointAt(0)!)).toBe(true)
    expect(glyphVerticalizes('서'.codePointAt(0)!)).toBe(true)
    expect(glyphVerticalizes('A'.codePointAt(0)!)).toBe(true)
    expect(glyphVerticalizes('7'.codePointAt(0)!)).toBe(true)
    expect(glyphVerticalizes(' '.codePointAt(0)!)).toBe(false)
    expect(glyphVerticalizes('　'.codePointAt(0)!)).toBe(false) // ideographic space
    expect(glyphVerticalizes('ا'.codePointAt(0)!)).toBe(false) // Arabic
  })
})

describe('#2144 — the hint gate (design §1.4): a Unicode property, not a ratio', () => {
  it('one ideograph in an otherwise Latin string is enough', () => {
    expect(allowsVerticalWritingMode('Tokyo 東京')).toBe(true)
    expect(allowsVerticalWritingMode(HANGUL)).toBe(true)
    expect(allowsVerticalWritingMode('Seoul')).toBe(false)
    expect(allowsVerticalWritingMode('12345')).toBe(false)
  })

  it('astral CJK (SIP) counts', () => {
    expect(allowsVerticalWritingMode('\u{20000}')).toBe(true)
  })

  it('the predicate is stateless — the same input answers the same twice', () => {
    // A `/g` regex under `.test()` carries lastIndex and would alternate.
    expect(allowsVerticalWritingMode(HAN)).toBe(true)
    expect(allowsVerticalWritingMode(HAN)).toBe(true)
    expect(glyphVerticalizes('東'.codePointAt(0)!)).toBe(true)
    expect(glyphVerticalizes('東'.codePointAt(0)!)).toBe(true)
  })

  it('the style flag alone does not verticalize a script that does not support it', () => {
    expect(verticalWritingActive('vertical', 'Seoul')).toBe(false)
    expect(verticalWritingActive('vertical', HANGUL)).toBe(true)
    expect(verticalWritingActive('horizontal', HANGUL)).toBe(false)
    expect(verticalWritingActive(undefined, HANGUL)).toBe(false)
  })
})

describe('#2144 §10 — layoutCacheKey separates a column from a row', () => {
  it('the ONLY differing term is the writing mode, and the keys differ', () => {
    const args = [0x1234, SIZE, 0, Infinity, 28.8, 'center', 'center', 0, 0, 0, 0, 2, 1, 0] as const
    const horizontal = layoutCacheKey(...args, false, false)
    const vertical = layoutCacheKey(...args, false, true)
    expect(
      vertical,
      `layout-cache ALIASING: the same font/text/size/anchor/halo/offsets hash to the SAME ` +
        `key whether the label is a column or a row, so whichever is laid out first wins and ` +
        `the other renders in the wrong orientation with no error anywhere (design §10).`,
    ).not.toBe(horizontal)
  })
})

describe('#2144 §7 — the collision box under a column is TALL AND NARROW', () => {
  it('the box derived from the column metrics matches the offsets it describes', () => {
    const { offsets, blockTop, blockBottom } = column(HANGUL, [24, 24, 24, 24, 24])
    // The metrics TextStage hands deriveLabelBbox for a vertical label: the
    // column is one em wide, and its block spans the cells.
    const drawX = 100 - SIZE / 2 // anchor 100, centred → drawX = anchor − width/2
    const box = deriveLabelBbox(drawX, 200, {
      totalAdvance: SIZE,
      blockTop,
      blockBottom,
      padding: 0,
    })
    const w = box.maxX - box.minX
    const h = box.maxY - box.minY
    expect(
      h,
      `the collision box stayed WIDE-AND-SHORT under a tall-and-narrow label (w=${w}, h=${h}) — ` +
        `the gate-passing-but-wrong outcome design §7 names.`,
    ).toBeGreaterThan(w * 2)
    // And it actually contains the glyph cells it is meant to describe.
    const ys = [...HANGUL].map((_, i) => 200 + offsets[i * 2 + 1]!)
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(box.minY)
    expect(Math.max(...ys)).toBeLessThanOrEqual(box.maxY)
  })
})

// ── The real pipeline: TextStage.prepare() ─────────────────────────────────

const G = globalThis as Record<string, unknown>
G.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 }
G.GPUBufferUsage ??= {
  MAP_READ: 1,
  MAP_WRITE: 2,
  COPY_SRC: 4,
  COPY_DST: 8,
  INDEX: 16,
  VERTEX: 32,
  UNIFORM: 64,
  STORAGE: 128,
  INDIRECT: 256,
  QUERY_RESOLVE: 512,
}
G.GPUTextureUsage ??= {
  COPY_SRC: 1,
  COPY_DST: 2,
  TEXTURE_BINDING: 4,
  STORAGE_BINDING: 8,
  RENDER_ATTACHMENT: 16,
}
G.GPUColorWrite ??= { RED: 1, GREEN: 2, BLUE: 4, ALPHA: 8, ALL: 15 }

function stubDevice(): GPUDevice {
  const stub: unknown = new Proxy(
    function () {
      return stub
    },
    {
      get(_t, p) {
        if (p === 'size') return 1 << 22
        if (p === 'width' || p === 'height') return 4096
        if (p === 'limits') return { maxTextureDimension2D: 8192 }
        if (p === Symbol.toPrimitive) return () => 0
        return stub
      },
      apply() {
        return stub
      },
    },
  )
  return stub as GPUDevice
}

/** Latin and CJK with DIFFERENT advance AND different bearingY — the decoy the
 *  §5 trap needs. A column that centred on `bearingY`, or paced on
 *  `advanceWidth`, comes out visibly different for the two scripts. */
class BilingualMetricsRasterizer implements GlyphRasterizer {
  rasterize(req: GlyphRasterRequest): GlyphRasterResult {
    const { fontKey, codepoint, sdfRadius, slotSize, fontSize } = req
    const ideographic = codepoint >= 0x2e80
    const advanceWidth = ideographic ? fontSize : fontSize * 0.55
    const bearingY = ideographic ? fontSize * 0.88 : fontSize * 0.71
    const height = ideographic ? fontSize * 0.97 : fontSize * 0.71
    const alpha = new Uint8Array(slotSize * slotSize)
    const c = slotSize / 2
    for (let y = 0; y < slotSize; y++)
      for (let x = 0; x < slotSize; x++)
        if (Math.hypot(x - c, y - c) < slotSize / 5) alpha[y * slotSize + x] = 255
    return {
      fontKey,
      codepoint,
      sdfRadius,
      sdf: computeSDF(alpha, slotSize, slotSize, sdfRadius),
      advanceWidth,
      bearingX: 0,
      bearingY,
      width: advanceWidth * 0.9,
      height,
      rasterFontSize: fontSize,
    }
  }
}

function litValue(s: string): TextValue {
  return { kind: 'expr', expr: { ast: { kind: 'StringLiteral', value: s } as never } }
}
function defOf(writingMode?: 'vertical'): LabelDef {
  return {
    text: litValue(''),
    size: SIZE,
    maxWidth: 100,
    font: ['Noto Sans Bold'],
    anchor: 'center',
    allowOverlap: true,
    ...(writingMode ? { writingMode } : {}),
  } as LabelDef
}

interface Placed {
  draw: TextDraw
  /** Display advance of glyph i — the renderer's own per-glyph scale. */
  advanceOf(i: number): number
}

/** Drive the REAL prepare() for one or more labels in one frame and return the
 *  draw for each requested text, in submission order. */
function place(texts: Array<{ text: string; writingMode?: 'vertical' }>): Placed[] {
  const stage = new TextStage(stubDevice(), new WebGpuDevice(stubDevice()), 'bgra8unorm', {
    rasterizer: new BilingualMetricsRasterizer(),
  })
  const captured: TextDraw[][] = []
  ;(stage as unknown as { renderer: { setDraws(d: TextDraw[]): void } }).renderer.setDraws = (
    d: TextDraw[],
  ) => {
    captured.push(d)
  }
  stage.setCameraZoom(12)
  stage.beginFrame()
  const anchorXOf = (i: number): number => 200 + i * 400
  texts.forEach((t, i) => {
    stage.addLabel(litValue(t.text), {}, anchorXOf(i), 300, defOf(t.writingMode), undefined, 'lyr')
  })
  stage.prepare()
  const draws = captured[0] ?? []
  return texts.map((t, i) => {
    // Match on the SUBMITTED ANCHOR, never the text — the §10 witness submits
    // the same string twice, and a text match would hand back one draw twice
    // and "prove" an aliasing that was really the test reading itself.
    const wanted = anchorXOf(i)
    const same = draws.filter(
      (d) => String.fromCodePoint(...d.glyphs.map((g) => g.codepoint)) === t.text,
    )
    const draw = same.find((d) => Math.abs(d.anchorX - wanted) < 200)
    expect(draw, `no draw for "${t.text}" at x≈${wanted} (drew ${draws.length})`).toBeDefined()
    return {
      draw: draw!,
      advanceOf(i: number): number {
        const g = draw!.glyphs[i]!
        return g.advanceWidth * (draw!.fontSize / (g.rasterFontSize ?? draw!.rasterFontSize))
      },
    }
  })
}

describe('#2144 — end to end through TextStage.prepare()', () => {
  it(`COLUMN: "${HANGUL}" leaves prepare() as a downward column at em pitch`, () => {
    const [p] = place([{ text: HANGUL, writingMode: 'vertical' }])
    const off = p!.draw.glyphOffsets!
    const ys = [...HANGUL].map((_, i) => off[i * 2 + 1]!)
    for (let i = 1; i < ys.length; i++) {
      expect(
        ys[i]! - ys[i - 1]!,
        `COLUMN broken end to end for "${HANGUL}": step ${i - 1}→${i} is ` +
          `${ys[i]! - ys[i - 1]!} px, expected the em ${p!.draw.fontSize}. y=[${ys.join(', ')}]`,
      ).toBeCloseTo(p!.draw.fontSize, 4)
    }
  })

  it('ORIENTATION: prepare() emits an all-upright rotation array for a CJK column', () => {
    const [p] = place([{ text: HANGUL, writingMode: 'vertical' }])
    const rot = p!.draw.glyphRotations
    expect(
      rot,
      `ORIENTATION missing: a vertical label reached the renderer with NO glyphRotations, so ` +
        `every glyph would draw at the label's default orientation.`,
    ).toBeDefined()
    expect(
      [...rot!],
      `ORIENTATION wrong end to end for "${HANGUL}": [${[...rot!].join(', ')}], expected all 0.`,
    ).toEqual([0, 0, 0, 0, 0])
  })

  it('the draw is tagged `vertical`, so diagnostics cannot call it a curved road name', () => {
    const [p] = place([{ text: HANGUL, writingMode: 'vertical' }])
    expect(p!.draw.glyphLayout).toBe('vertical')
  })

  it('a horizontal label is untouched — no rotations, no tag, pen along +x', () => {
    const [p] = place([{ text: HANGUL }])
    expect(p!.draw.glyphRotations).toBeUndefined()
    expect(p!.draw.glyphLayout).toBeUndefined()
    const off = p!.draw.glyphOffsets!
    expect(off[1]).toBeCloseTo(off[3]!, 6) // one line: same baseline
    expect(off[2]!).toBeGreaterThan(off[0]!) // pen advances in +x
  })

  it('CROSS-AXIS (§5): a bilingual column shares ONE centreline despite the metrics', () => {
    // "東A京": the Latin A has a smaller advance AND a smaller bearingY than the
    // two Han glyphs. A column centred on an INK metric zig-zags; the centreline
    // must come from the em/advance box alone.
    const [p] = place([{ text: '東A京', writingMode: 'vertical' }])
    const off = p!.draw.glyphOffsets!
    const centres = [0, 1, 2].map((i) => off[i * 2]! + p!.advanceOf(i) / 2)
    const spread = Math.max(...centres) - Math.min(...centres)
    expect(
      spread,
      `CROSS-AXIS zig-zag in "東A京": the three glyph centres sit at ` +
        `[${centres.map((c) => c.toFixed(3)).join(', ')}] — a spread of ${spread.toFixed(3)} px. ` +
        `All three must share ONE centreline; a per-glyph INK metric (bearingY / bearingX / ` +
        `width) leaking into the cross axis is the design §5 trap, and it differs between ` +
        `Latin and Hangul at the same nominal size.`,
    ).toBeCloseTo(0, 4)
  })

  it('CROSS-AXIS: the pitch of a bilingual column is still the em, not the advances', () => {
    const [p] = place([{ text: '東A京', writingMode: 'vertical' }])
    const off = p!.draw.glyphOffsets!
    expect(p!.advanceOf(1)).toBeLessThan(p!.advanceOf(0)) // the decoy is live
    expect(off[3]! - off[1]!).toBeCloseTo(p!.draw.fontSize, 4)
    expect(off[5]! - off[3]!).toBeCloseTo(p!.draw.fontSize, 4)
  })

  it('§10 WITNESS: a column and a row of the SAME string do not share a layout entry', () => {
    // Same font, text, size, anchor, halo and offsets — everything the layout
    // cache keys on before #2144 — with only the writing mode differing. Both in
    // ONE frame, so the second is served from the first's entry if they alias.
    const [horiz, vert] = place([{ text: HANGUL }, { text: HANGUL, writingMode: 'vertical' }])
    const h = horiz!.draw.glyphOffsets!
    const v = vert!.draw.glyphOffsets!
    const identical = h.length === v.length && [...h].every((x, i) => x === v[i])
    expect(
      identical,
      `layout-cache ALIASING (design §10): the vertical "${HANGUL}" was served the HORIZONTAL ` +
        `label's glyphOffsets byte for byte — the two hash to one layoutCacheKey because it ` +
        `carries no writing-mode term, so whichever was laid out first won and the other ` +
        `renders in the wrong orientation with no error anywhere. ` +
        `horizontal y=[${[...h].filter((_, i) => i % 2 === 1).join(', ')}] ` +
        `vertical y=[${[...v].filter((_, i) => i % 2 === 1).join(', ')}]`,
    ).toBe(false)
    // And the vertical one really is a column, not just "different".
    expect(v[3]! - v[1]!).toBeCloseTo(vert!.draw.fontSize, 4)
    expect(vert!.draw.glyphRotations).toBeDefined()
    expect(horiz!.draw.glyphRotations).toBeUndefined()
  })
})
