// Phase-0 characterization pin for the curved-line label shaping loop
// (text-stage.ts addCurvedLineLabel queue → prepare() line-loop,
// ~:1694-1882). `grep addCurvedLineLabel **/*.test.ts` had ZERO hits
// before this file: the geometry-heaviest code in TextStage (keep-
// upright reversal, advance-box-LEFT sampling, perpendicular shift
// verticalOffsetPx = sizePx*0.4, fit/skip drops, walkReversed startS
// mirror) had no pin at all. Unit 2 of the decomposition reads the
// curved draws in the emit-phase dump loop and the trace block sits
// INSIDE addCurvedLineLabel — this file is the gate that proves the
// move is behavior-preserving.
//
// Golden source = FIRST-PRINCIPLES straight-line geometry, NOT a
// snapshot. With a horizontal polyline the per-glyph anchor is a
// closed-form interpolation of the MockRasterizer's fixed advances,
// so every expected offset/rotation is hand-derived below (see the
// header of each `it`). Drives the REAL TextStage.prepare() with a
// stub GPU device (prepare is CPU-only; GPU is only touched at
// setDraws/draw, which we spy past) — same harness as
// bilingual-prepare-scatter.test.ts.
//
// MockRasterizer metrics (glyph-rasterizer.ts:280-288), baked at the
// host's rasterFontSize = 24 (DEFAULTS): advanceWidth = 24*0.6 = 14.4,
// rasterFontSize = 24. In the curved loop the display advance is
//   adv = advanceWidth * (sizePx / rasterFontSize) = 14.4 * sizePx/24.
// With size = 20, dpr = 1 → sizePx = 20 → adv = 12 px/glyph exactly.

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

/** Curved-label LabelDef. size 20 → sizePx 20 (dpr 1) → adv 12 px,
 *  verticalOffsetPx = 0.4*20 = 8. letterSpacing 0 → no extra tracking. */
function curvedDef(extra: Partial<LabelDef> = {}): LabelDef {
  return {
    text: litValue(''),
    size: 20,
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

/** Wrap angle into [-π, π) for robust rotation comparison. */
function norm(a: number): number {
  let x = a % (2 * Math.PI)
  if (x >= Math.PI) x -= 2 * Math.PI
  if (x < -Math.PI) x += 2 * Math.PI
  return x
}

// Derived constants for the size-20 ASCII case (see file header).
const ADV = 12        // 14.4 * 20/24
const VOFF = 8        // 0.4 * 20

describe('curved-line label shaping (addCurvedLineLabel → prepare line-loop)', () => {
  it('horizontal L→R: x strictly increasing by adv, rotations 0, perp shift = 0.4*sizePx, anchor at origin', () => {
    // polyline = [(0,Y),(1000,Y)], "AB" (2 glyphs), centerOffsetPx 500.
    // totalAdvancePx = 12+12 = 24; startS = 500 - 12 = 488.
    //   g0: sampleAt(488) → sx = 0 + 1000*(488/1000) = 488, sy = Y,
    //       angle 0 → perpX 0, perpY = cos(0)*8 = 8 → off = (488, Y+8)
    //   g1: cursor 500 → sx = 500, off = (500, Y+8)
    const Y = 100
    const { stage, captured } = makeStage()
    const px = new Float32Array([0, 1000])
    const py = new Float32Array([Y, Y])
    stage.beginFrame()
    stage.addCurvedLineLabel(litValue('AB'), {}, px, py, 500, curvedDef())
    stage.prepare()
    expect(captured.length).toBe(1)
    const draw = captured[0]!.find(d => d.glyphRotations !== undefined)
    expect(draw, 'curved draw missing').toBeDefined()
    const off = draw!.glyphOffsets!
    const rot = draw!.glyphRotations!
    expect(draw!.glyphs.length).toBe(2)

    // anchor at origin (curved labels carry absolute screen coords in offsets).
    expect(draw!.anchorX).toBe(0)
    expect(draw!.anchorY).toBe(0)

    // x strictly increasing, spaced by adv + letterSpacing (= 12).
    for (let i = 1; i < draw!.glyphs.length; i++) {
      expect(off[i * 2]! > off[(i - 1) * 2]!, `g${i} x not increasing`).toBe(true)
      expect(off[i * 2]! - off[(i - 1) * 2]!).toBeCloseTo(ADV, 6)
    }
    // rotation 0 at every glyph (tangent of a horizontal line).
    for (let i = 0; i < rot.length; i++) expect(norm(rot[i]!)).toBeCloseTo(0, 6)
    // perpendicular shift at angle 0 → y = polylineY + 0.4*sizePx.
    for (let i = 0; i < draw!.glyphs.length; i++) expect(off[i * 2 + 1]!).toBeCloseTo(Y + VOFF, 6)
    // exact closed-form positions.
    expect(off[0]!).toBeCloseTo(488, 6)
    expect(off[2]!).toBeCloseTo(500, 6)
  })

  it('keep-upright (default true): reversed polyline still reads L→R, rotation flipped by π vs naive tangent', () => {
    // Same geometry, vertices reversed: [(1000,Y),(0,Y)].
    // midAngle = atan2(0,-1000) = π > π/2 → walkReversed = true,
    // startS = 1000 - 500 - 12 = 488.
    //   g0: sFwd = 1000-488 = 512 → sx = 1000 + (0-1000)*0.512 = 488
    //   g1: sFwd = 1000-500 = 500 → sx = 500
    // angle = π + π = 2π ≡ 0 (flipped from the naive reversed tangent π).
    const Y = 100
    const { stage, captured } = makeStage()
    const px = new Float32Array([1000, 0])
    const py = new Float32Array([Y, Y])
    stage.beginFrame()
    stage.addCurvedLineLabel(litValue('AB'), {}, px, py, 500, curvedDef())
    stage.prepare()
    const draw = captured[0]!.find(d => d.glyphRotations !== undefined)!
    const off = draw.glyphOffsets!
    const rot = draw.glyphRotations!
    // x still LEFT-TO-RIGHT (monotonic increasing) — label reads upright.
    for (let i = 1; i < draw.glyphs.length; i++) {
      expect(off[i * 2]! > off[(i - 1) * 2]!, `g${i} x not increasing under keep-upright`).toBe(true)
    }
    expect(off[0]!).toBeCloseTo(488, 6)
    expect(off[2]!).toBeCloseTo(500, 6)
    // Naive reversed tangent = π; keep-upright rotation ≡ 0 → differs by π.
    const naive = Math.PI
    for (let i = 0; i < rot.length; i++) {
      expect(norm(rot[i]!)).toBeCloseTo(0, 6)
      expect(Math.abs(norm(rot[i]! - naive))).toBeCloseTo(Math.PI, 6)
    }
  })

  it('keep-upright false: reversed polyline NOT flipped — x decreasing, rotation = naive tangent π', () => {
    // walkReversed stays false → sampleAt walks s forward on the
    // reversed vertices: g0 sFwd 488 → sx = 1000-488 = 512; g1 → 500.
    // x DECREASES (512→500); rotation = atan2(0,-1000) = π (unflipped).
    const Y = 100
    const { stage, captured } = makeStage()
    const px = new Float32Array([1000, 0])
    const py = new Float32Array([Y, Y])
    stage.beginFrame()
    stage.addCurvedLineLabel(litValue('AB'), {}, px, py, 500, curvedDef({ keepUpright: false }))
    stage.prepare()
    const draw = captured[0]!.find(d => d.glyphRotations !== undefined)!
    const off = draw.glyphOffsets!
    const rot = draw.glyphRotations!
    // x DECREASES — the un-flipped (upside-down) run.
    expect(off[2]! < off[0]!, 'x should decrease when keepUpright=false on a reversed line').toBe(true)
    expect(off[0]!).toBeCloseTo(512, 6)
    expect(off[2]!).toBeCloseTo(500, 6)
    // rotation = naive tangent π (NOT flipped).
    for (let i = 0; i < rot.length; i++) expect(Math.abs(norm(rot[i]!))).toBeCloseTo(Math.PI, 6)
  })

  it('fit/skip: label wider than the polyline → no draw emitted', () => {
    // polyline length 10 px; "AB" needs 24 px → totalAdvancePx > totalLineLen
    // → continue (label dropped), draws empty.
    const { stage, captured } = makeStage()
    const px = new Float32Array([0, 10])
    const py = new Float32Array([100, 100])
    stage.beginFrame()
    stage.addCurvedLineLabel(litValue('AB'), {}, px, py, 5, curvedDef())
    stage.prepare()
    expect(captured.length).toBe(1)
    expect(captured[0]!.length).toBe(0)
  })

  it('fit/skip: centerOffsetPx pushes the run past the start → no draw (startS < 0)', () => {
    // 1000-px line, centerOffsetPx 5 → startS = 5 - 12 = -7 < 0 → skip.
    const { stage, captured } = makeStage()
    const px = new Float32Array([0, 1000])
    const py = new Float32Array([100, 100])
    stage.beginFrame()
    stage.addCurvedLineLabel(litValue('AB'), {}, px, py, 5, curvedDef())
    stage.prepare()
    expect(captured.length).toBe(1)
    expect(captured[0]!.length).toBe(0)
  })

  it('dump capture: curved===true and per-glyph dump x/y equal the draw glyphOffsets', () => {
    const Y = 100
    const { stage, captured } = makeStage()
    const px = new Float32Array([0, 1000])
    const py = new Float32Array([Y, Y])
    stage.setLabelDumpFilter('AB')
    stage.beginFrame()
    stage.addCurvedLineLabel(litValue('AB'), {}, px, py, 500, curvedDef())
    stage.prepare()
    const draw = captured[0]!.find(d => d.glyphRotations !== undefined)!
    const off = draw.glyphOffsets!
    const dumped = stage.getDumpedLabels()
    expect(dumped.length).toBe(1)
    expect(dumped[0]!.curved).toBe(true)
    const dg = dumped[0]!.glyphs
    expect(dg.length).toBe(draw.glyphs.length)
    for (let i = 0; i < dg.length; i++) {
      expect(dg[i]!.x).toBeCloseTo(off[i * 2]!, 6)
      expect(dg[i]!.y).toBeCloseTo(off[i * 2 + 1]!, 6)
    }
  })
})

// Phase S Batch 2 — Mapbox `text-max-angle` (LabelDef.maxAngle, DEGREES).
// A 90°-corner polyline puts glyph 0 on the horizontal segment (tangent 0°)
// and glyph 1 on the vertical segment (tangent 90°), so the per-glyph
// tangent delta is 90°. With maxAngle=45 the label is dropped; UNSET (the
// historical default) places it exactly as before — proving no regression
// for styles that don't author text-max-angle.
describe('curved-line label text-max-angle angular gate', () => {
  // polyline: (0,100)→(50,100)→(50,150). seg0 horizontal len 50 (0°),
  // seg1 vertical len 50 (90°). centerOffsetPx 56 → startS 44.
  //   g0 sampleAt(44) → seg0, tangent 0°.
  //   g1 sampleAt(56) → seg1 (cumLen[1]=50<56), tangent 90°.
  // Δ = 90° between adjacent glyphs.
  const cornerPx = () => new Float32Array([0, 50, 50])
  const cornerPy = () => new Float32Array([100, 100, 150])
  const CENTER = 56

  it('maxAngle 45: 90° corner exceeds threshold → label dropped (no draw)', () => {
    const { stage, captured } = makeStage()
    stage.beginFrame()
    stage.addCurvedLineLabel(litValue('AB'), {}, cornerPx(), cornerPy(), CENTER, curvedDef({ maxAngle: 45 }))
    stage.prepare()
    expect(captured.length).toBe(1)
    expect(captured[0]!.length).toBe(0)
  })

  it('DEFAULT (maxAngle unset): same 90° corner still places — historical no-clamp behaviour', () => {
    const { stage, captured } = makeStage()
    stage.beginFrame()
    stage.addCurvedLineLabel(litValue('AB'), {}, cornerPx(), cornerPy(), CENTER, curvedDef())
    stage.prepare()
    const draw = captured[0]!.find(d => d.glyphRotations !== undefined)
    expect(draw, 'curved draw should still be emitted when maxAngle is unset').toBeDefined()
    expect(draw!.glyphs.length).toBe(2)
  })

  it('maxAngle 120: 90° corner is within threshold → label still placed', () => {
    const { stage, captured } = makeStage()
    stage.beginFrame()
    stage.addCurvedLineLabel(litValue('AB'), {}, cornerPx(), cornerPy(), CENTER, curvedDef({ maxAngle: 120 }))
    stage.prepare()
    const draw = captured[0]!.find(d => d.glyphRotations !== undefined)
    expect(draw, 'label within the angle threshold should place').toBeDefined()
  })

  it('maxAngle 45 on a STRAIGHT line → no deflection, label places (gate only drops kinks)', () => {
    const { stage, captured } = makeStage()
    const px = new Float32Array([0, 1000])
    const py = new Float32Array([100, 100])
    stage.beginFrame()
    stage.addCurvedLineLabel(litValue('AB'), {}, px, py, 500, curvedDef({ maxAngle: 45 }))
    stage.prepare()
    const draw = captured[0]!.find(d => d.glyphRotations !== undefined)
    expect(draw, 'straight-line label must not be dropped by the angle gate').toBeDefined()
  })
})
