// text-max-width wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: text-max-width is
// marked `supported` in compiler/src/convert/spec-coverage (symbol layout)
// + the symbol capability table, but the runtime side was only exercised
// indirectly by the bilingual-scatter / country-label cases (which pass a
// FIXED maxWidth). None of them asserts that VARYING text-max-width
// actually re-flows the label — i.e. that LabelDef.maxWidth is still
// threaded into the wrap. A broken wire (maxWidthPx pinned to Infinity, or
// the field dropped before wrapWithKnuthPlass) would ship silently: every
// label would render on a single line and no existing test would notice.
//
// The runtime contract (text-stage.ts:773-774, then :812-815):
//     const maxWidthPx = p.def.maxWidth !== undefined
//       ? p.def.maxWidth * sizePx : Infinity
//     ...
//     const lines = wrapWithKnuthPlass(glyphs, advances, fontKey, sizePx,
//                                      letterSpacingPx, maxWidthPx)
// A small text-max-width must produce MORE wrapped lines (more distinct
// glyph baselines) than a large one for the same multi-word label.
//
// This drives the REAL TextStage.prepare() (wrap + layout) with a stub GPU
// device (prepare is CPU-only) and a MockRasterizer for deterministic
// advances, capturing the produced TextDraws and counting the distinct
// baseline-Y values among the glyphOffsets — the line count.
//
// Fail-before: pin `maxWidthPx` to `Infinity` (drop `p.def.maxWidth *
// sizePx`) and the SMALL-maxWidth label stops wrapping → its line count
// collapses to the large-maxWidth label's (both = 1) → the
// `smallLines > largeLines` assertion fails. The text-max-width wire is
// gone and the test says so before any render.

import { describe, it, expect } from 'vitest'
import { TextStage } from '@xgis/map'
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

function defOf(size: number, maxWidth: number): LabelDef {
  return {
    text: litValue(''),
    size,
    maxWidth,
    font: ['Noto Sans Bold'],
    anchor: 'center',
  } as LabelDef
}

/** Build a stage, spy on its renderer.setDraws to capture draws. */
function makeStage() {
  const stage = new TextStage(stubDevice(), new WebGpuDevice(stubDevice()), 'bgra8unorm', { rasterizer: new MockRasterizer() })
  const captured: TextDraw[][] = []
  ;(stage as unknown as { renderer: { setDraws(d: TextDraw[]): void } }).renderer.setDraws =
    (d: TextDraw[]) => { captured.push(d) }
  return { stage, captured }
}

// A multi-WORD Latin label: many break opportunities (spaces) so a small
// text-max-width forces wrapping, a large one keeps it on one line.
const LABEL = 'alpha beta gamma delta epsilon zeta eta theta'

/** Distinct baseline-Y count among non-newline glyphs of a draw = number
 *  of wrapped lines. Y values are bucketed (rounded) so within-line
 *  sub-pixel drift collapses to one baseline. */
function lineCount(draw: TextDraw): number {
  const off = draw.glyphOffsets
  expect(off, 'draw missing glyphOffsets').toBeDefined()
  const ys = new Set<number>()
  for (let gi = 0; gi < draw.glyphs.length; gi++) {
    if (draw.glyphs[gi]!.codepoint === 10) continue // \n: not positioned
    const y = off![gi * 2 + 1]!
    expect(Number.isFinite(y), `g${gi} non-finite y`).toBe(true)
    ys.add(Math.round(y))
  }
  return ys.size
}

/** Run prepare() once for the LABEL at the given text-max-width and return
 *  its line count (distinct glyph baselines). */
function lineCountFor(maxWidth: number): number {
  const { stage, captured } = makeStage()
  stage.setCameraZoom(8)
  stage.beginFrame()
  stage.addLabel(litValue(LABEL), {}, 400, 300, defOf(16, maxWidth))
  stage.prepare()
  expect(captured.length).toBe(1)
  const draws = captured[0]!
  // First non-empty draw is our single label.
  const draw = draws.find(d => d.glyphs.some(gl => gl.codepoint !== 10))
  expect(draw, 'label draw missing').toBeDefined()
  return lineCount(draw!)
}

describe('text-max-width wrap wiring (GPU-free)', () => {
  it('large text-max-width keeps the multi-word label on ONE line', () => {
    expect(lineCountFor(1000)).toBe(1)
  })

  it('small text-max-width WRAPS the label onto more lines than a large one', () => {
    const largeLines = lineCountFor(1000)
    const smallLines = lineCountFor(3)
    // Non-vacuous: the ONLY difference between the two runs is text-max-width.
    // If LabelDef.maxWidth no longer reaches wrapWithKnuthPlass (pinned to
    // Infinity), both produce 1 line and this strict inequality fails.
    expect(largeLines).toBe(1)
    expect(smallLines).toBeGreaterThan(largeLines)
  })
})
