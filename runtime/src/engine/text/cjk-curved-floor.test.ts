// Fail-before gate for the CJK display-size floor on CURVED / line labels.
//
// The point-label loop floors a dense-CJK label's display size to
// CJK_MIN_DISPLAY_PX (text-stage.ts ~:716, gated cjk-minification-box.test +
// the headed z0 box-out evidence) so a 国-class glyph minified from the 24-px
// SDF atlas doesn't collapse into a solid box at low zoom. The CURVED loop
// (addCurvedLineLabel → prepare line-loop) computed `sizePx = def.size * dpr`
// with NO floor, so CJK road / line labels boxed out at low zoom while their
// point-label siblings stayed legible.
//
// This pins the floor on the curved path: a CJK curved label whose
// def.size*dpr is BELOW the floor must emit TextDraw.fontSize >= the floor.
// Pre-fix it emits def.size*dpr (< floor) → red. Same harness as
// curved-line-shaping.test.ts (real TextStage.prepare with a stub device).

import { describe, it, expect } from 'vitest'
import { TextStage } from './text-stage'
import { MockRasterizer } from './sdf/glyph-rasterizer'
import { CJK_MIN_DISPLAY_PX } from './text-wrap'
import type { LabelDef, TextValue } from '@xgis/compiler'
import type { TextDraw } from './text-renderer'

// WebGPU bitflag globals the GPU classes reference at construction (per spec).
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

// Recursive Proxy stub — identical to curved-line-shaping.test.ts.
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

function curvedDef(size: number, extra: Partial<LabelDef> = {}): LabelDef {
  return {
    text: litValue(''),
    size,
    letterSpacing: 0,
    font: ['Noto Sans Bold'],
    placement: 'line',
    ...extra,
  } as LabelDef
}

function makeStage() {
  const stage = new TextStage(stubDevice(), 'bgra8unorm', { rasterizer: new MockRasterizer() })
  const captured: TextDraw[][] = []
  ;(stage as unknown as { renderer: { setDraws(d: TextDraw[]): void } }).renderer.setDraws =
    (d: TextDraw[]) => { captured.push(d) }
  return { stage, captured }
}

/** Drive one curved label over a long horizontal polyline (so the run fits)
 *  and return the emitted curved TextDraw. */
function emitCurved(text: string, size: number): TextDraw {
  const { stage, captured } = makeStage()
  const px = new Float32Array([0, 1000])
  const py = new Float32Array([100, 100])
  stage.beginFrame()
  stage.addCurvedLineLabel(litValue(text), {}, px, py, 500, curvedDef(size))
  stage.prepare()
  expect(captured.length).toBe(1)
  const draw = captured[0]!.find(d => d.glyphRotations !== undefined)
  expect(draw, 'curved draw missing — label was dropped').toBeDefined()
  return draw!
}

describe('CJK curved/line-label display-size floor (parity with the point path)', () => {
  const DPR = 1
  // def.size deliberately below the floor so the floor is the only thing that
  // can lift the emitted fontSize. 6 px < CJK_MIN_DISPLAY_PX (14).
  const SMALL = 6

  it('CJK curved label below the floor emits fontSize >= CJK_MIN_DISPLAY_PX*dpr', () => {
    // 国 (U+56FD) is a dense Han ideograph — the box-out glyph.
    const draw = emitCurved('国', SMALL)
    expect(draw.fontSize).toBeGreaterThanOrEqual(CJK_MIN_DISPLAY_PX * DPR)
  })

  it('the floor binds (def.size*dpr was actually below it) — guards a no-op test', () => {
    // Confirms the case is real: the raw size is under the floor, so a passing
    // assertion above can only be the floor, not an already-large size.
    expect(SMALL * DPR).toBeLessThan(CJK_MIN_DISPLAY_PX * DPR)
    const draw = emitCurved('国', SMALL)
    expect(draw.fontSize).toBe(CJK_MIN_DISPLAY_PX * DPR)
  })

  it('non-CJK curved label is NOT floored — keeps its (small) style size', () => {
    // Latin labels carry less ink and must keep parity with the style size;
    // the floor must not touch them.
    const draw = emitCurved('AB', SMALL)
    expect(draw.fontSize).toBe(SMALL * DPR)
  })
})
