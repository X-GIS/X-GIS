// text-justify wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: text-justify is
// marked `supported` in compiler/src/convert/spec-coverage/layout-symbol.ts
// + plumbed as LabelDef.justify, but its RUNTIME effect (the per-line
// horizontal alignment of a multi-line label) was only covered
// indirectly. The runtime contract lives in TextStage.prepare()
// (text-stage.ts:1077-1090): for each wrap line, the line's start pen
//   • justify 'left'   → lineX = 0
//   • justify 'right'  → lineX = totalAdvance - line.width
//   • justify 'center' → lineX = (totalAdvance - line.width) * 0.5
// and that lineX is baked into the per-glyph X in `glyphOffsets[gi*2]`,
// which text-renderer.ts:183 reads to place every glyph quad. A broken
// justify wire ships a silently mis-aligned label.
//
// This drives the REAL TextStage.prepare() (wrap + composition loop)
// with a stub GPU device (prepare is CPU-only; the GPU is only touched
// at setDraws/draw, which we spy past) and a MockRasterizer (uniform
// advance = sizePx*0.6), then inspects the actual glyphOffsets in the
// produced TextDraw. Two-line label "AB\nCDEF": line-0 ("AB", 2 glyphs)
// is STRICTLY shorter than line-1 ("CDEF", 4 glyphs = totalAdvance), so
// line-0's first-glyph X is prop-controlled and DIFFERS per justify:
//   left → 0, right → +(width gap), center → +(gap/2).
// Asserting all three (and their order) is non-vacuous: it fails if any
// branch is replaced by a constant or a value independent of justify.
//
// Fail-before: in text-stage.ts:1080 change
//   `if (effectiveJustify === 'right') lineX = totalAdvance - ln.width`
// to `... lineX = 0` and the 'right' assertions (rightX0 > 0,
// centerX0 ≈ rightX0/2) fail — the wire that makes text-justify reach
// the glyph offsets is gone, caught before any render.

import { describe, it, expect } from 'vitest'
import { TextStage } from './text-stage'
import { MockRasterizer } from '@xgis/map'
import { WebGpuDevice } from '@xgis/engine'
import type { LabelDef, TextValue } from '@xgis/compiler'
import type { TextDraw } from '@xgis/map'

// WebGPU bitflag globals the GPU classes reference at construction —
// not present in the node test env. Values per the WebGPU spec.
const g = globalThis as Record<string, unknown>
g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 }
g.GPUBufferUsage ??= {
  MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
  VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
}
g.GPUTextureUsage ??= {
  COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16,
}
g.GPUColorWrite ??= { RED: 1, GREEN: 2, BLUE: 4, ALPHA: 8, ALL: 15 }

// Recursive Proxy stub — any property access returns a callable that
// returns the same stub; numeric-ish props return a number so the GPU
// classes' constructors don't choke on `.size` / `.width`.
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

function litValue(s: string): TextValue {
  return { kind: 'expr', expr: { ast: { kind: 'StringLiteral', value: s } as never } }
}

/** Build a stage, spy on its renderer.setDraws to capture draws. */
function makeStage() {
  const stage = new TextStage(stubDevice(), new WebGpuDevice(stubDevice()), 'bgra8unorm', { rasterizer: new MockRasterizer() })
  const captured: TextDraw[][] = []
  ;(stage as unknown as { renderer: { setDraws(d: TextDraw[]): void } }).renderer.setDraws =
    (d: TextDraw[]) => { captured.push(d) }
  return { stage, captured }
}

// 2-line label with DIFFERENT line lengths so justify produces a
// non-zero, justify-dependent horizontal shift on the shorter line.
// Latin-only (no CJK vertical layout) keeps the glyph stream simple:
//   A(0) B(1) \n(2) C(3) D(4) E(5) F(6)
// wrap → line0 [0,2) "AB" (shorter), line1 [3,7) "CDEF" (= totalAdvance).
const TEXT = 'AB\nCDEF'
const CP_A = 0x41   // first glyph of line-0

/** anchor=center + EXPLICIT justify so the 'auto' per-anchor resolution
 *  is bypassed and the asserted lineX is purely the justify branch. */
function defOf(justify: 'left' | 'center' | 'right'): LabelDef {
  return {
    text: litValue(''),
    size: 15,
    maxWidth: 25,            // wide enough that only the hard \n breaks
    font: ['Noto Sans'],
    anchor: 'center',
    justify,
  } as LabelDef
}

/** Drive one prepare() for the given justify and return the X offset of
 *  line-0's first glyph (codepoint 'A') from the produced draw. */
function lineZeroFirstGlyphX(justify: 'left' | 'center' | 'right'): number {
  const { stage, captured } = makeStage()
  stage.setCameraZoom(8)
  stage.beginFrame()
  stage.addLabel(litValue(TEXT), {}, 400, 300, defOf(justify))
  stage.prepare()
  expect(captured.length, `${justify}: no setDraws`).toBe(1)
  const draw = captured[0]!.find(d => d.glyphs.some(gl => gl.codepoint === CP_A))
  expect(draw, `${justify}: draw missing`).toBeDefined()
  const gi = draw!.glyphs.findIndex(gl => gl.codepoint === CP_A)
  const x = draw!.glyphOffsets![gi * 2]!
  expect(Number.isFinite(x), `${justify}: non-finite X (${x})`).toBe(true)
  return x
}

describe('text-justify wiring (GPU-free): per-line lineX → glyphOffsets', () => {
  it('left pins the shorter line to x=0; right pushes it fully right; center is half', () => {
    const leftX0 = lineZeroFirstGlyphX('left')
    const centerX0 = lineZeroFirstGlyphX('center')
    const rightX0 = lineZeroFirstGlyphX('right')

    // 'left' branch (text-stage.ts:1081): lineX = 0.
    expect(leftX0).toBeCloseTo(0, 6)

    // 'right' branch (text-stage.ts:1080): lineX = totalAdvance - width.
    // The shorter line is pushed strictly to the right of the left case.
    expect(rightX0).toBeGreaterThan(leftX0 + 1e-3)

    // 'center' branch (text-stage.ts:1082): lineX = (totalAdvance - width)*0.5
    // = exactly half the right-justified margin.
    expect(centerX0).toBeCloseTo(rightX0 / 2, 5)

    // Strict monotonic order — fails if any branch collapses to a constant.
    expect(leftX0).toBeLessThan(centerX0)
    expect(centerX0).toBeLessThan(rightX0)
  })
})
