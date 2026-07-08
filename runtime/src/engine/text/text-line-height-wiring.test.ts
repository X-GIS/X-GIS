// text-line-height: prop → inter-line baseline spacing wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap. `text-line-height`
// is marked `supported` (compiler lowers `text-line-height` → LabelDef.lineHeight,
// render-node.ts:413) and the spec DEFAULT (1.2) is checked compiler-side
// (mapbox-spec-conformance.test.ts:190). The vertical-layout MATH is checked
// in isolation (text-vertical.test.ts / text-layout-edge.test.ts call
// mlVerticalLayout with a pre-computed lineHeightPx). But NOTHING pins the
// RUNTIME WIRING: that the `lineHeight` PROP on the LabelDef actually reaches
// TextStage.prepare() and sets the per-line glyph baseline spacing. If
// text-stage.ts:775 stopped reading `p.def.lineHeight` (e.g. hardcoded 1.2),
// every existing test stays green — a silent wiring break (the heatmap-class bug).
//
// The consumer is text-stage.ts:775:
//   const lineHeightEm = (p.def.lineHeight ?? 1.2) * typo.lineHeightScale
//   const lineHeightPx = lineHeightEm * sizePx
// → fed to mlVerticalLayout → vlay.baselineY[li] = li·LH + off + shiftY
// → glyphOffsets[gi*2+1] = vlay.baselineY[li] + centreShift  (text-stage.ts:1083-1087)
// centreShift is a UNIFORM per-label shift (same for every line), so the
// DELTA between consecutive lines' glyph Y offsets equals exactly lineHeightPx
// = lineHeight · sizePx — independent of SHAPING_DEFAULT_OFFSET, vAlign and
// ink metrics. We use anchor='top' (vAlign=0 → centreShift=0) and the default
// font (no fontTypography table → lineHeightScale = 1, dpr=1 → sizePx = size),
// so the measured delta is the prop value × size.
//
// This drives the REAL TextStage.prepare() (wrap + mlVerticalLayout +
// composition loop) against a stub GPU device + MockRasterizer (prepare is
// CPU-only), mirroring bilingual-prepare-scatter.test.ts, and reads the actual
// glyphOffsets in the produced TextDraws.
//
// Non-vacuous: two labels with DIFFERENT lineHeight (1.0 vs 2.5) must produce
// DIFFERENT, prop-proportional inter-line spacing. Asserting a constant or a
// value independent of the prop would pass with the wire broken — these don't.
//
// Fail-before: hardcode line 775 to `(1.2) * typo.lineHeightScale` (drop the
// `p.def.lineHeight` read). Both labels then space at 1.2·size regardless of
// the prop → the exact-value AND the scaling assertions go red.

import { describe, it, expect } from 'vitest'
import { TextStage } from '@xgis/map'
import { MockRasterizer } from '@xgis/map'
import { WebGpuDevice } from '@xgis/rhi-webgpu'
import type { LabelDef, TextValue } from '@xgis/compiler'
import type { TextDraw } from '@xgis/map'

// WebGPU bitflag globals the GPU classes reference at construction — not
// present in the node test env. Values per the WebGPU spec.
const g = globalThis as Record<string, unknown>
g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 }
g.GPUBufferUsage ??= {
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
g.GPUTextureUsage ??= {
  COPY_SRC: 1,
  COPY_DST: 2,
  TEXTURE_BINDING: 4,
  STORAGE_BINDING: 8,
  RENDER_ATTACHMENT: 16,
}
g.GPUColorWrite ??= { RED: 1, GREEN: 2, BLUE: 4, ALPHA: 8, ALL: 15 }

// Recursive Proxy stub — any property access returns a callable that returns
// the same stub; numeric-ish props return a number so the GPU classes'
// constructors don't choke on `.size` / `.width`.
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

function litValue(s: string): TextValue {
  return { kind: 'expr', expr: { ast: { kind: 'StringLiteral', value: s } as never } }
}

/** LabelDef carrying an explicit text-line-height. anchor='top' → vAlign 0 →
 *  centreShift is 0, so glyphOffsets Y delta is exactly lineHeightPx. */
function defWithLineHeight(size: number, lineHeight: number): LabelDef {
  return {
    text: litValue(''),
    size,
    maxWidth: 8, // wide enough that the \n is the only break
    font: ['Noto Sans Bold'],
    anchor: 'top',
    lineHeight,
  } as LabelDef
}

/** Build a stage and spy on renderer.setDraws to capture the produced draws. */
function makeStage() {
  const stage = new TextStage(stubDevice(), new WebGpuDevice(stubDevice()), 'bgra8unorm', {
    rasterizer: new MockRasterizer(),
  })
  const captured: TextDraw[][] = []
  ;(stage as unknown as { renderer: { setDraws(d: TextDraw[]): void } }).renderer.setDraws = (
    d: TextDraw[],
  ) => {
    captured.push(d)
  }
  return { stage, captured }
}

/** Find the draw whose glyph codepoints contain the given char. */
function findDrawWithText(draws: TextDraw[], cp: number): TextDraw | undefined {
  return draws.find((d) => d.glyphs.some((g) => g.codepoint === cp))
}

/** Measure the inter-line baseline spacing (line-2 Y − line-1 Y) from a draw's
 *  real glyphOffsets. Two distinct rounded Y buckets = two lines; returns their
 *  difference. The \n glyph (cp 10) is not positioned, so it is skipped. */
function interLineDelta(draw: TextDraw): number {
  const off = draw.glyphOffsets
  expect(off, 'draw has glyphOffsets').toBeDefined()
  const ys: number[] = []
  for (let gi = 0; gi < draw.glyphs.length; gi++) {
    if (draw.glyphs[gi]!.codepoint === 10) continue
    const y = off![gi * 2 + 1]!
    expect(Number.isFinite(y), `glyph ${gi} Y finite`).toBe(true)
    const k = Math.round(y * 1000) / 1000
    if (!ys.includes(k)) ys.push(k)
  }
  expect(ys.length, 'label split into exactly two lines').toBe(2)
  ys.sort((a, b) => a - b)
  return ys[1]! - ys[0]!
}

// Two-line ASCII label — the \n is the sole break opportunity (maxWidth wide).
const TWO_LINE = 'Ab\nCd'
const SIZE = 16 // dpr defaults to 1 → sizePx = SIZE

/** Drive a single-label frame with the given lineHeight and return the
 *  measured inter-line baseline delta from the real prepare() output. */
function measuredSpacing(lineHeight: number): number {
  const { stage, captured } = makeStage()
  stage.setCameraZoom(10)
  stage.beginFrame()
  stage.addLabel(litValue(TWO_LINE), {}, 400, 300, defWithLineHeight(SIZE, lineHeight))
  stage.prepare()
  expect(captured.length).toBe(1)
  const draw = findDrawWithText(captured[0]!, 0x41 /* 'A' */)
  expect(draw, 'two-line label draw missing').toBeDefined()
  return interLineDelta(draw!)
}

describe('text-line-height prop → baseline spacing wiring (GPU-free)', () => {
  it('inter-line spacing equals lineHeight × size (lineHeight=1.0)', () => {
    // Wire intact: lineHeightPx = 1.0 · 16 = 16. Broken (hardcoded 1.2) → 19.2.
    expect(measuredSpacing(1.0)).toBeCloseTo(1.0 * SIZE, 3)
  })

  it('inter-line spacing equals lineHeight × size (lineHeight=2.5)', () => {
    // Wire intact: lineHeightPx = 2.5 · 16 = 40. Broken (hardcoded 1.2) → 19.2.
    expect(measuredSpacing(2.5)).toBeCloseTo(2.5 * SIZE, 3)
  })

  it('a larger text-line-height yields proportionally larger spacing', () => {
    // Non-vacuity: the spacing must TRACK the prop, not a constant. With the
    // 775 read dropped (constant 1.2) both spacings collapse to 19.2 and this
    // exact 2.5× ratio fails.
    const a = measuredSpacing(1.0)
    const b = measuredSpacing(2.5)
    expect(b).toBeCloseTo(a * 2.5, 3)
    expect(b).toBeGreaterThan(a)
  })
})
