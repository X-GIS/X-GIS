// Curved / line-label CJK display-size PARITY with the point path (#421).
//
// HISTORY: a `CJK_MIN_DISPLAY_PX = 14` floor used to INFLATE any dense-CJK
// label below 14 px so a 国-class glyph minified from the fixed 24-px SDF atlas
// didn't collapse into a box at low zoom. That floor broke MapLibre SIZE parity
// (#421 — labels ~1.4× too big) and applied to the whole label (Latin sub-lines
// too). It is now REMOVED: CJK glyphs are rasterised LOCALLY at their
// display-size bucket (local-ideograph, like MapLibre's localIdeographFontFamily)
// so they stay legible at the AUTHORED size — legibility comes from the SDF
// size, not from inflating the text.
//
// This pins the NEW contract on the curved path: a CJK curved label emits the
// faithful `def.size * dpr` (NOT a floored 14), matching both MapLibre and the
// point-label path. Same harness as curved-line-shaping.test.ts.

import { describe, it, expect } from 'vitest'
import { TextStage } from './text-stage'
import { MockRasterizer } from './sdf/glyph-rasterizer'
import { WebGpuDevice } from '@xgis/engine'
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
  const stage = new TextStage(stubDevice(), new WebGpuDevice(stubDevice()), 'bgra8unorm', { rasterizer: new MockRasterizer() })
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

describe('CJK curved/line-label display-size parity with the point path (#421)', () => {
  const DPR = 1
  // Small dense-CJK size that the OLD floor would have inflated to 14. The new
  // contract: emit it FAITHFULLY (no inflation) — legibility comes from the
  // local-ideograph display-size SDF, not from enlarging the text.
  const SMALL = 6

  it('CJK curved label is NOT inflated — emits the faithful def.size*dpr (was floored to 14)', () => {
    // 国 (U+56FD) is a dense Han ideograph — the glyph the old floor targeted.
    const draw = emitCurved('国', SMALL)
    expect(draw.fontSize).toBe(SMALL * DPR)
  })

  it('CJK and Latin curved labels resolve to the SAME size (no CJK special-case inflation)', () => {
    // Parity: the size path must treat 国 and AB identically now that the floor
    // is gone — both = the authored size, matching MapLibre.
    const cjk = emitCurved('国', SMALL)
    const latin = emitCurved('AB', SMALL)
    expect(cjk.fontSize).toBe(latin.fontSize)
    expect(latin.fontSize).toBe(SMALL * DPR)
  })
})
