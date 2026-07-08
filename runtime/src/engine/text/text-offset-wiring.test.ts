// text-offset → TextStage draw-anchor wiring (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: `text-offset` is
// marked `supported` (constant) in compiler/src/convert/spec-coverage +
// the symbol capability table (capabilities/symbol.ts:53), AND the
// converter→IR lowering (`text-offset` → LabelDef.offset) is pinned by
// label-anchor-mapbox.test.ts. But NO test proves the RUNTIME consumes
// LabelDef.offset to actually MOVE the rendered label — exactly the
// heatmap-class "field reaches ShowCommand but the renderer drops it"
// failure the audit targets.
//
// The runtime consumer is the static (non-variable) text-offset path in
// TextStage.prepare() (text-stage.ts:997-999):
//
//     } else if (p.def.offset) {
//       dx += p.def.offset[0] * sizePx
//       dy += p.def.offset[1] * sizePx
//
// where sizePx = def.size * dpr (dpr default 1) and the resolved
// (drawX, drawY) = (anchorX + dx, anchorY + dy) become the emitted
// TextDraw.anchorX / anchorY uploaded to the renderer.
//
// Harness mirrors symbol-z-order.test.ts / prepare-collision-wiring.test.ts
// (the TextStage analog of the heatmap/circle writeBuffer-intercept
// wiring tests): drive the REAL TextStage.addLabel + prepare() against a
// stub GPUDevice + MockRasterizer (no GPU), and spy renderer.setDraws to
// read the draw anchors the stage actually produces.
//
// Non-vacuous + offset-isolating: the test is DIFFERENTIAL. The same
// label (anchor 'left', size 20) is shaped once WITH offset [ox, oy] and
// once with NO offset; the DELTA of the emitted anchors must equal
// [ox*size, oy*size]. Subtracting the no-offset draw cancels every other
// term (left-anchor advance, vertical baseline, dpr) so the assertion
// pins EXACTLY the text-offset wire and nothing else.
//
// Fail-before: replace `dx += p.def.offset[0] * sizePx` /
// `dy += p.def.offset[1] * sizePx` with `dx += 0` / `dy += 0` (drop the
// offset threading) and the delta collapses to [0, 0] — the assertions
// go red. text-offset is then no longer "supported" and this test says
// so before any render runs.

import { describe, it, expect } from 'vitest'
import { TextStage } from '@xgis/map'
import { MockRasterizer } from '@xgis/map'
import { WebGpuDevice } from '@xgis/rhi-webgpu'
import type { LabelDef, TextValue } from '@xgis/compiler'
import type { TextDraw } from '@xgis/map'

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

// anchor 'left', single static candidate (no radialOffset /
// variableAnchorOffset / anchorCandidates) → variableMode === false, so
// the STATIC text-offset path (text-stage.ts:997-999) runs.
const SIZE = 20
function pointDef(extra: Partial<LabelDef> = {}): LabelDef {
  return {
    text: litValue(''),
    size: SIZE,
    letterSpacing: 0,
    font: ['Noto Sans Bold'],
    anchor: 'left',
    ...extra,
  } as LabelDef
}

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

/** Shape a single 'A' label at (ax, ay) with the given def and return its
 *  one emitted draw anchor. dpr is left at its default (1), so
 *  sizePx === SIZE. */
function drawAnchorFor(def: LabelDef, ax: number, ay: number): { x: number; y: number } {
  const { stage, captured } = makeStage()
  stage.beginFrame()
  stage.addLabel(litValue('A'), {}, ax, ay, def)
  stage.prepare()
  const draws = captured[0]!
  expect(draws.length, 'exactly one label placed').toBe(1)
  return { x: draws[0]!.anchorX, y: draws[0]!.anchorY }
}

describe('text-offset → TextStage draw-anchor wiring (GPU-free)', () => {
  // Same anchor screen-point for both shapings so the delta isolates the
  // offset contribution.
  const AX = 300
  const AY = 200

  it('text-offset [ox, oy] shifts the draw anchor by [ox*size, oy*size] (delta vs no-offset)', () => {
    const OX = 1.5
    const OY = -0.75
    const base = drawAnchorFor(pointDef(), AX, AY)
    const off = drawAnchorFor(pointDef({ offset: [OX, OY] }), AX, AY)
    // The ONLY differing input is text-offset → the anchor delta must be
    // exactly the offset (em) × display size (px). Drop the offset
    // threading and both deltas collapse to 0.
    expect(off.x - base.x, 'x shifted by ox*size').toBeCloseTo(OX * SIZE, 5)
    expect(off.y - base.y, 'y shifted by oy*size').toBeCloseTo(OY * SIZE, 5)
  })

  it('per-axis: x-only offset moves x and not y; y-only offset moves y and not x', () => {
    const base = drawAnchorFor(pointDef(), AX, AY)
    const xOnly = drawAnchorFor(pointDef({ offset: [2, 0] }), AX, AY)
    const yOnly = drawAnchorFor(pointDef({ offset: [0, 3] }), AX, AY)
    expect(xOnly.x - base.x, 'x-only offset moves x by 2*size').toBeCloseTo(2 * SIZE, 5)
    expect(xOnly.y - base.y, 'x-only offset leaves y unchanged').toBeCloseTo(0, 5)
    expect(yOnly.y - base.y, 'y-only offset moves y by 3*size').toBeCloseTo(3 * SIZE, 5)
    expect(yOnly.x - base.x, 'y-only offset leaves x unchanged').toBeCloseTo(0, 5)
  })

  it('zero offset is a no-op (anchor unchanged)', () => {
    const base = drawAnchorFor(pointDef(), AX, AY)
    const zero = drawAnchorFor(pointDef({ offset: [0, 0] }), AX, AY)
    expect(zero.x - base.x).toBeCloseTo(0, 5)
    expect(zero.y - base.y).toBeCloseTo(0, 5)
  })
})
