// text-radial-offset → label draw-anchor wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap. text-radial-offset
// is marked `supported` in compiler/src/convert/spec-coverage/layout-symbol.ts
// and lowers to LabelDef.radialOffset (proven by label-anchor-mapbox.test.ts),
// and the PURE math helper evaluateVariableOffsetEm is unit-tested in
// text-stage.test.ts. But NOTHING pins the RUNTIME WIRING that connects them:
// that TextStage.prepare() actually reads `p.def.radialOffset`, calls
// evaluateVariableOffsetEm(anchor, [radialOffset, 0], /*isRadial*/ true), and
// folds the result (× sizePx) into the emitted point-label draw anchor
// (text-stage.ts ~:989-996, drawX/drawY at ~:1010-1011, pushed at ~:1101-1102,
// flushed via renderer.setDraws at ~:1572). Delete that branch and EVERY
// helper + lower test still passes while the prop silently stops moving labels
// — the heatmap-class "supported but the data path is broken" bug.
//
// This drives the REAL TextStage.prepare() with a stub GPU device + the
// MockRasterizer (prepare is CPU-only; the GPU is touched only at setDraws,
// which we spy past) — identical harness to curved-line-shaping.test.ts /
// bilingual-prepare-scatter.test.ts. We read the captured TextDraw.anchorX /
// anchorY and assert the EXACT radial term radialOffset × sizePx, isolated by
// differencing the radial case against the no-radialOffset control for the
// same static anchor (so the base box-anchor / advance terms cancel and only
// the radial wire remains).
//
// Fail-before: replace
//   ;[vx, vy] = evaluateVariableOffsetEm(anchor, [p.def.radialOffset, 0], true)
// with `;[vx, vy] = [0, 0]` (drop the radial contribution) and the deltas
// collapse to 0 — the X-axis (right anchor) and Y-axis (bottom anchor)
// assertions both go red, before any render.

import { describe, it, expect } from 'vitest'
import { TextStage } from './text-stage'
import { MockRasterizer } from '@xgis/map'
import { WebGpuDevice } from '@xgis/engine'
import type { LabelDef, TextValue } from '@xgis/compiler'
import type { TextDraw } from './text-renderer'

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

function makeStage() {
  // dpr defaults to 1 (TextStage.dpr) ⇒ sizePx = def.size.
  const stage = new TextStage(stubDevice(), new WebGpuDevice(stubDevice()), 'bgra8unorm', { rasterizer: new MockRasterizer() })
  const captured: TextDraw[][] = []
  ;(stage as unknown as { renderer: { setDraws(d: TextDraw[]): void } }).renderer.setDraws =
    (d: TextDraw[]) => { captured.push(d) }
  return { stage, captured }
}

// MapLibre baseline correction shared by the radial Y branch
// (text-stage-helpers.ts BASELINE_OFFSET_EM = 7 / ONE_EM, ONE_EM = 24).
const ONE_EM = 24
const B = 7 / ONE_EM

const SIZE = 24            // dpr 1 ⇒ sizePx = 24
const RADIUS = 2           // text-radial-offset, em
const ANCHOR_X = 300
const ANCHOR_Y = 200

/** Point LabelDef anchored at a single static anchor. `allowOverlap`
 *  guarantees the label survives the collision pass so its chosen draw
 *  reaches setDraws; a single explicit anchor keeps the candidate set
 *  deterministic (no text-variable-anchor / variable-anchor-offset). */
function pointDef(anchor: LabelDef['anchor'], radialOffset?: number): LabelDef {
  return {
    text: litValue(''),
    size: SIZE,
    letterSpacing: 0,
    font: ['Noto Sans Bold'],
    anchor,
    allowOverlap: true,
    ...(radialOffset !== undefined ? { radialOffset } : {}),
  } as LabelDef
}

/** Shape one point label and return its emitted draw anchor (drawX/drawY). */
function drawAnchorFor(def: LabelDef): { x: number; y: number } {
  const { stage, captured } = makeStage()
  stage.beginFrame()
  stage.addLabel(litValue('AB'), {}, ANCHOR_X, ANCHOR_Y, def)
  stage.prepare()
  expect(captured.length, 'setDraws should have been called once').toBe(1)
  const draws = captured[0]!
  expect(draws.length, 'exactly one label draw expected').toBe(1)
  return { x: draws[0]!.anchorX, y: draws[0]!.anchorY }
}

describe('text-radial-offset → label draw-anchor wiring (GPU-free)', () => {
  // `right` anchor: evaluateVariableOffsetEm('right', [r,0], true) = [-r, 0]
  // ⇒ the radial wire shifts drawX by -r·sizePx and leaves drawY unchanged.
  // Differencing against the no-radialOffset control for the SAME anchor
  // cancels the base box-anchor (-totalAdvance) term, isolating the wire.
  it('radialOffset pushes drawX by -radialOffset·sizePx at the `right` anchor', () => {
    const withRadial = drawAnchorFor(pointDef('right', RADIUS))
    const control = drawAnchorFor(pointDef('right'))
    // The wire: dx += evaluateVariableOffsetEm('right',[r,0],true)[0] * sizePx.
    expect(withRadial.x - control.x).toBeCloseTo(-RADIUS * SIZE, 5)   // = -48
    // X-only: the right anchor's radial Y term is 0 ⇒ drawY untouched.
    expect(withRadial.y - control.y).toBeCloseTo(0, 5)
  })

  // `bottom` anchor: evaluateVariableOffsetEm('bottom', [r,0], true)
  //   = [0, -r + B] ⇒ the radial wire shifts drawY by (-r + B)·sizePx.
  it('radialOffset pushes drawY by (-radialOffset + baseline)·sizePx at the `bottom` anchor', () => {
    const withRadial = drawAnchorFor(pointDef('bottom', RADIUS))
    const control = drawAnchorFor(pointDef('bottom'))
    // The wire: dy += evaluateVariableOffsetEm('bottom',[r,0],true)[1] * sizePx.
    expect(withRadial.y - control.y).toBeCloseTo((-RADIUS + B) * SIZE, 5) // = -41
    // Y-only: the bottom anchor's radial X term is 0 ⇒ drawX untouched.
    expect(withRadial.x - control.x).toBeCloseTo(0, 5)
  })

  // Non-vacuity guard: the asserted shift is genuinely radialOffset-dependent
  // (scales with the prop), not a constant baked into the harness.
  it('the drawX shift scales with the radialOffset magnitude', () => {
    const base = drawAnchorFor(pointDef('right')).x
    const r1 = drawAnchorFor(pointDef('right', 1)).x - base
    const r3 = drawAnchorFor(pointDef('right', 3)).x - base
    expect(r1).toBeCloseTo(-1 * SIZE, 5)
    expect(r3).toBeCloseTo(-3 * SIZE, 5)
    expect(r3 / r1).toBeCloseTo(3, 5)
  })
})
