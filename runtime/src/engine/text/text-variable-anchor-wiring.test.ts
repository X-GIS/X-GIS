// text-variable-anchor: runtime placement wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap. text-variable-anchor
// is marked `supported` in compiler/src/convert/spec-coverage/layout-symbol.ts
// ("lower to anchorCandidates; runtime collision picks first non-overlapping").
// The COMPILE side (text-variable-anchor -> LabelDef.anchorCandidates) is
// behaviorally tested in compiler/.../label-anchor-mapbox.test.ts, but the
// RUNTIME side was blind: nothing pinned that prepare() actually CONSUMES
// anchorCandidates to place the label at the chosen anchor. A break that
// drops anchorCandidates (collapsing every variable label to the static
// anchor) would ship silently — the heatmap-class "wire-cut" bug.
//
// Runtime consumer (the wire under test): text-stage.ts:828-833 derives the
// per-label `candidates` set from `p.def.anchorCandidates`, and the loop at
// text-stage.ts:960-1011 builds ONE layout per candidate with the box-anchor
// dx rule (left -> dx 0; right -> dx -totalAdvance). For a single,
// non-colliding label the greedy collision picks candidates[0] (chosen=0,
// text-stage.ts:1552), so draw.anchorX is governed entirely by
// anchorCandidates[0].
//
// Geometry (mirrors prepare-collision-wiring.test.ts): a single multi-char
// ASCII label with NO text-offset, so the variable-offset term is zero
// (evaluateVariableOffsetEm(anchor, [0,0], false) returns x=0 for both left
// and right). The ONLY thing that moves anchorX is the anchor the runtime
// selects from anchorCandidates[0]:
//   anchorCandidates[0] = 'left'  -> dx = 0            -> draw.anchorX == X
//   anchorCandidates[0] = 'right' -> dx = -totalAdvance -> draw.anchorX <  X
// so anchorX(left) - anchorX(right) == totalAdvance > 0. A non-vacuous,
// anchor-controlled value (not a constant, not anchor-independent).
//
// Fail-before: in text-stage.ts:828-833, make `candidates` ignore
// anchorCandidates (collapse to the single static anchor). Both configs then
// resolve to the SAME anchor, anchorX(left) == anchorX(right), the delta
// collapses to 0, and the `toBeGreaterThan` assertion fails — the wiring that
// makes text-variable-anchor actually choose the placement is gone, and this
// test catches it before any render runs.

import { describe, it, expect } from 'vitest'
import { TextStage } from './text-stage'
import { MockRasterizer } from '@xgis/map'
import { WebGpuDevice } from '@xgis/engine'
import type { LabelDef, TextValue } from '@xgis/compiler'
import type { TextDraw } from '@xgis/map'

// WebGPU bitflag globals the GPU classes reference at construction — not
// present in the node test env. Values per the WebGPU spec. (Mirrors
// prepare-collision-wiring.test.ts / bilingual-prepare-scatter.test.ts.)
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

/** Point-label def with the given variable-anchor candidate list and NO
 *  text-offset, so the variable-offset term is zero and only the box-anchor
 *  rule (driven by anchorCandidates[0]) moves anchorX. */
function variableDef(candidates: string[]): LabelDef {
  return {
    text: litValue(''),
    size: 20,
    letterSpacing: 0,
    font: ['Noto Sans Bold'],
    anchorCandidates: candidates,
  } as unknown as LabelDef
}

function makeStage() {
  const stage = new TextStage(stubDevice(), new WebGpuDevice(stubDevice()), 'bgra8unorm', { rasterizer: new MockRasterizer() })
  const captured: TextDraw[][] = []
  ;(stage as unknown as { renderer: { setDraws(d: TextDraw[]): void } }).renderer.setDraws =
    (d: TextDraw[]) => { captured.push(d) }
  return { stage, captured }
}

const TEXT = 'WIDE'        // multi-char ASCII → nonzero totalAdvance
const X = 400
const Y = 300

/** Drive a real prepare() for a single label whose variable-anchor list
 *  begins with `firstAnchor`, and return the chosen draw's anchorX. The
 *  label is alone in the frame, so collision picks candidates[0]. */
function anchorXFor(firstAnchor: 'left' | 'right'): number {
  const others = ['top', 'bottom']  // length>1 so variable placement engages
  const { stage, captured } = makeStage()
  stage.beginFrame()
  stage.addLabel(litValue(TEXT), {}, X, Y, variableDef([firstAnchor, ...others]))
  stage.prepare()
  const draws = captured[0]!
  expect(draws.length, `${firstAnchor}: exactly one draw`).toBe(1)
  return draws[0]!.anchorX
}

describe('text-variable-anchor runtime placement wiring (GPU-free)', () => {
  it('anchorCandidates[0]=left places the label box at the anchor (drawX == submitted X)', () => {
    // 'left' box-anchor rule → dx = 0 → anchorX === submitted X.
    expect(anchorXFor('left')).toBeCloseTo(X, 6)
  })

  it('anchorCandidates[0]=right shifts the box left by the text advance (drawX < submitted X)', () => {
    // 'right' box-anchor rule → dx = -totalAdvance → anchorX strictly < X.
    expect(anchorXFor('right')).toBeLessThan(X)
  })

  it('the chosen anchor is driven by anchorCandidates[0]: left vs right differ by the text advance', () => {
    // The CORE wiring assertion. With no text-offset the only thing moving
    // anchorX is which anchor the runtime selected from anchorCandidates[0].
    // left - right == totalAdvance > 0 and equals the box width (= X - rightX).
    const leftX = anchorXFor('left')
    const rightX = anchorXFor('right')
    const advance = leftX - rightX
    // Non-vacuous: a real, positive text advance (not a constant, not 0).
    expect(advance).toBeGreaterThan(0)
    // 'left' parked the box at X exactly, so the advance is exactly X-rightX:
    // proves both placements share one totalAdvance and only the anchor moved.
    expect(advance).toBeCloseTo(X - rightX, 6)
  })
})
