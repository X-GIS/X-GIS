// text-anchor (static, 9-way enum) horizontal-placement wiring
// (GPU-free, fail-before).
//
// Closes a spec-coverage "supported-but-untested" gap: `text-anchor` is
// marked `supported` (constant, "9-way enum literal") in
// compiler/src/convert/spec-coverage symbol.ts:49, but the only runtime
// coverage was for the VARIABLE-anchor offset helpers
// (evaluateVariableOffsetEm / variableAnchorOffsetEm in
// text-stage.test.ts). The STATIC single-anchor horizontal-placement
// path — the actual `text-anchor` enum consumer in TextStage.prepare()
// (text-stage.ts:962-964) — had no behavioral test. That path is:
//   left   / *-left  → dx = 0                  (anchor's left edge on the point)
//   right  / *-right → dx = -totalAdvance      (right edge on the point)
//   else   (center)  → dx = -totalAdvance / 2  (centred on the point)
// The renderer then draws each glyph from drawX = anchorX + dx
// (text-renderer.ts:255), so a broken branch silently mis-places every
// statically-anchored label horizontally.
//
// Drives the REAL TextStage.prepare() against a stub GPU device + the
// deterministic MockRasterizer (same harness as
// prepare-collision-wiring.test.ts / bilingual-prepare-scatter.test.ts).
// prepare() is CPU-only; the GPU is only touched at setDraws/draw, which
// we spy past to capture the produced TextDraws and read draw.anchorX
// (== drawX). With a static anchor and NO offset/translate,
// drawX = submittedAnchorX + dx, so dx is recovered exactly as
// draw.anchorX - submittedAnchorX.
//
// MockRasterizer advance = fontSize * 0.6 (glyph-rasterizer.ts:314) with
// rasterFontSize = fontSize, so the display advance per glyph is
// 0.6 * sizePx. For the 2-glyph "AB" at size 20, dpr 1 → totalAdvance
// = 2 * 0.6 * 20 = 24. Hence dxLeft = 0, dxCenter = -12, dxRight = -24.
//
// Fail-before: change the right-anchor branch
//   `else if (anchor === 'right' || anchor.endsWith('-right')) dx = -totalAdvance`
// to `... dx = 0` (or any constant) and the right-anchor assertions go
// red — the wiring that makes `text-anchor: right` actually shift the
// label is gone, caught before any render.

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

/** Single-line point-label def with a static text-anchor and NO offset /
 *  translate / variable-anchor → drawX = anchorX + dx where dx is driven
 *  ONLY by the static text-anchor branch under test. */
function anchorDef(anchor: string): LabelDef {
  return {
    text: litValue(''),
    size: 20,
    letterSpacing: 0,
    font: ['Noto Sans Bold'],
    anchor,
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

// "AB" → 2 glyphs; MockRasterizer advance 0.6*size, dpr 1, size 20 →
// totalAdvance = 2 * 0.6 * 20 = 24.
const TOTAL_ADVANCE = 24
const TEXT = 'AB'

// Well-separated anchorX so the three labels never collide (gap 400 ≫
// totalAdvance 24) — each produces exactly one surviving draw.
const X_LEFT = 200
const X_CENTER = 600
const X_RIGHT = 1000
const Y = 300

/** Recover dx (= draw.anchorX - submittedAnchorX) for a single static
 *  anchored label placed at (x, Y). */
function dxFor(anchor: string, x: number): number {
  const { stage, captured } = makeStage()
  stage.beginFrame()
  stage.addLabel(litValue(TEXT), {}, x, Y, anchorDef(anchor))
  stage.prepare()
  const draws = captured[captured.length - 1]!
  expect(draws.length, `exactly one draw for a single ${anchor} label`).toBe(1)
  return draws[0]!.anchorX - x
}

describe('text-anchor static horizontal-placement wiring (GPU-free)', () => {
  it('left anchor → dx = 0 (label left edge sits on the point)', () => {
    expect(dxFor('left', X_LEFT)).toBeCloseTo(0, 6)
  })

  it('right anchor → dx = -totalAdvance (label right edge on the point)', () => {
    // Break `dx = -totalAdvance` → `dx = 0` and this fails.
    expect(dxFor('right', X_RIGHT)).toBeCloseTo(-TOTAL_ADVANCE, 6)
  })

  it('center (default) anchor → dx = -totalAdvance / 2', () => {
    expect(dxFor('center', X_CENTER)).toBeCloseTo(-TOTAL_ADVANCE / 2, 6)
  })

  it('the three branches are distinct + ordered: right < center < left, with right = 2×center', () => {
    const dxLeft = dxFor('left', X_LEFT)
    const dxCenter = dxFor('center', X_CENTER)
    const dxRight = dxFor('right', X_RIGHT)
    // Ordering — collapses if the right/center branch is broken to a constant.
    expect(dxLeft).toBe(0)
    expect(dxCenter).toBeLessThan(dxLeft)
    expect(dxRight).toBeLessThan(dxCenter)
    // right = -totalAdvance, center = -totalAdvance/2 → right is exactly 2× center.
    expect(dxRight).toBeCloseTo(2 * dxCenter, 6)
  })

  it('compound anchors map by their -left / -right suffix (top-right → right rule)', () => {
    // top-right ends with '-right' → same dx as plain 'right'; top-left
    // ends with '-left' → dx 0. Pins the endsWith() suffix dispatch.
    expect(dxFor('top-right', X_RIGHT)).toBeCloseTo(-TOTAL_ADVANCE, 6)
    expect(dxFor('top-left', X_LEFT)).toBeCloseTo(0, 6)
  })
})
