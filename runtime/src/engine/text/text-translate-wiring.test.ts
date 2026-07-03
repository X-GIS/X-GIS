// text-translate (paint property) screen-space anchor-shift wiring
// (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: `text-translate`
// is marked `supported` in compiler/src/convert/spec-coverage/paint-symbol.ts
// and the compiler lower path is covered behaviorally by
// compiler/src/__tests__/translate-anchor-map-end-to-end.test.ts — but that
// test only proves the converter emits `label.translate` /
// `label.translateAnchorMap` onto the ShowCommand. The RUNTIME consumer that
// actually moves the rendered glyph anchor by that offset
// (TextStage.prepare(), text-stage.ts:1001-1009:
//   if (p.def.translate) { dx += txRaw * dpr; dy += tyRaw * dpr }
// feeding drawX = anchorX + dx / drawY = anchorY + dy at text-stage.ts:1010-1011)
// had no behavioral wiring test. A break there ships silently — the
// heatmap-class "supported but the data path is dead" bug.
//
// Drives the REAL TextStage.prepare() against a stub GPU device + the
// deterministic MockRasterizer (identical harness to
// text-anchor-wiring.test.ts), spying past renderer.setDraws to read the
// produced TextDraw's anchorX/anchorY. With a STATIC 'left' anchor (the
// anchor branch contributes dx = 0), NO text-offset, viewport
// translate-anchor (no bearing rotation) and dpr = 1, the ONLY contributor
// to the draw anchor delta is text-translate:
//   draw.anchorX - submittedAnchorX === translate[0]
//   draw.anchorY - submittedAnchorY === translate[1]
// Non-zero, distinct, asymmetric TX/TY (so a swapped/zeroed/constant write
// is caught), plus a translate-absent control that pins dx = dy = 0 — the
// assertions track the PROP, never a constant.
//
// Fail-before: zero the two translate adds in text-stage.ts
//   `dx += txRaw * dpr`  →  `dx += 0`
//   `dy += tyRaw * dpr`  →  `dy += 0`
// and the translated-case assertions go red while the control stays green —
// the wiring that makes `text-translate` actually shift the label is gone,
// caught before any render.

import { describe, it, expect } from 'vitest'
import { TextStage } from '@xgis/map'
import { MockRasterizer } from '@xgis/map'
import { WebGpuDevice } from '@xgis/engine'
import type { LabelDef, TextValue } from '@xgis/compiler'
import type { TextDraw } from '@xgis/map'

// WebGPU bitflag globals the GPU classes reference at construction —
// absent in the node test env. Values per the WebGPU spec.
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

// Recursive Proxy stub device — every access returns a callable that
// returns the stub; numeric-ish props return a number so the GPU
// classes' constructors don't choke on `.size` / `.width`.
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

/** Single-line point-label def, static 'left' anchor (anchor branch dx = 0),
 *  NO offset, viewport translate-anchor. `translate` (if given) is then the
 *  SOLE driver of the draw-anchor delta. */
function translateDef(translate?: [number, number]): LabelDef {
  return {
    text: litValue(''),
    size: 20,
    letterSpacing: 0,
    font: ['Noto Sans Bold'],
    anchor: 'left',
    ...(translate ? { translate } : {}),
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

const TEXT = 'AB'
const X = 600
const Y = 300

// Distinct, non-zero, asymmetric so a zeroed / swapped / single-axis /
// constant write is detectable on at least one axis.
const TX = 17
const TY = -29

/** Recover the (anchorX,anchorY) draw delta for one static 'left' label at
 *  (X, Y) with the given translate. dpr defaults to 1 in TextStage, so the
 *  delta equals translate exactly. */
function deltaFor(translate?: [number, number]): { dx: number; dy: number } {
  const { stage, captured } = makeStage()
  stage.beginFrame()
  stage.addLabel(litValue(TEXT), {}, X, Y, translateDef(translate))
  stage.prepare()
  const draws = captured[captured.length - 1]!
  expect(draws.length, 'exactly one draw for a single label').toBe(1)
  return { dx: draws[0]!.anchorX - X, dy: draws[0]!.anchorY - Y }
}

describe('text-translate runtime anchor-shift wiring (GPU-free)', () => {
  it('no translate → draw anchor unshifted (dx = dy = 0) — control, pins non-vacuity', () => {
    const { dx, dy } = deltaFor(undefined)
    expect(dx).toBeCloseTo(0, 6)
    expect(dy).toBeCloseTo(0, 6)
  })

  it('translate [TX,TY] shifts the draw anchor by exactly [TX,TY] at dpr 1', () => {
    // Zero the `dx += txRaw * dpr` / `dy += tyRaw * dpr` adds and BOTH fail.
    const { dx, dy } = deltaFor([TX, TY])
    expect(dx).toBeCloseTo(TX, 6)
    expect(dy).toBeCloseTo(TY, 6)
  })

  it('translate is the DELTA from the unshifted anchor (prop-driven, not a constant)', () => {
    const base = deltaFor(undefined)
    const shifted = deltaFor([TX, TY])
    // The shift equals translate on each axis independently — a single-axis
    // or swapped-axis write breaks one of these.
    expect(shifted.dx - base.dx).toBeCloseTo(TX, 6)
    expect(shifted.dy - base.dy).toBeCloseTo(TY, 6)
  })
})
