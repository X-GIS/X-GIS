// ═══ @xgis/shader-dsl example — fp64 catastrophic cancellation ═══
//
// The numerics-textbook figure, live on the GPU: (x−1)⁷ EVALUATED IN EXPANDED
// FORM (x⁷ − 7x⁶ + 21x⁵ − 35x⁴ + 35x³ − 21x² + 7x − 1) near x = 1. The terms
// are all ~1 while the true value is ~w⁷ ≈ 10⁻⁹ — eight ~1-sized numbers must
// cancel to nine digits, which f32 (7 digits) cannot do AT ALL: its result is
// ±5×10⁻⁶ NOISE, thousands of times the whole plot range (CPU-verified:
// 7300× signal). The df64 side (~14 digits) hugs the true curve. The thin
// reference line is the FACTORED form ((x−1)⁷ — subtract first, no
// cancellation), which even f32 evaluates cleanly: the fix is always to
// restructure the math, and fp64 is for when you can't.
//
// Narrow the half-width slider and even df64 starts to fray (w⁷ sinks toward
// its ~14-digit floor) — the same budget wall, two decades further out.
//
// The `_fp64` guard uniform is auto-injected by the lowering; the render
// harnesses bind it to 1.0f by probing the program for the Fp64Guard block.

import {
  fn,
  module,
  vec3,
  vec4,
  f32,
  f64,
  pow,
  fract,
  abs,
  min,
  mix,
  step,
  smoothstep,
  toF32,
  toF64,
  f32T,
  vec2fT,
  Let,
  uniformStruct,
} from '../src/index.ts'
import { VsOut, vs } from './_fullscreen.ts'
import type { ShaderExample } from './_shared.ts'

const U = uniformStruct(
  'Uniforms',
  { group: 0, binding: 0, as: 'u' },
  {
    resolution: vec2fT,
    half_width: f32T, // plot spans x ∈ [1−w, 1+w]
    fp64: f32T, // toggle: 1 = split-screen f32 | f64 (canonical), 0 = all-f32
  },
)

const fsCancel = fn(
  'fs_cancel',
  { vo: VsOut },
  (p) => {
    const w = Let(U.field.half_width)
    const halfUv = Let(p.vo.uv.x.mul(2.0))
    const sx = Let(halfUv.sub(p.vo.uv.x.lt(0.5).select(0.0, 1.0)))
    const u = Let(sx.sub(0.5).mul(w.mul(2.0))) // x − 1 ∈ [−w, w]

    const isF32 = Let(p.vo.uv.x.lt(0.5).or(U.field.fp64.lt(0.5)))
    // f64 — the expanded polynomial, every term in extended precision; only
    // the ~w⁷-sized RESULT narrows (small values narrow harmlessly: f32
    // precision is relative).
    const xd = Let(f64(1).add(toF64(u)))
    const x2 = Let(xd.mul(xd))
    const x3 = Let(x2.mul(xd))
    const x4 = Let(x2.mul(x2))
    const x5 = Let(x4.mul(xd))
    const x6 = Let(x3.mul(x3))
    const x7 = Let(x6.mul(xd))
    const p64 = Let(
      toF32(
        x7
          .sub(x6.mul(7.0))
          .add(x5.mul(21.0))
          .sub(x4.mul(35.0))
          .add(x3.mul(35.0))
          .sub(x2.mul(21.0))
          .add(xd.mul(7.0))
          .sub(1.0),
      ),
    )
    // f32 twin — SAME expanded polynomial: eight ~1-sized terms, seven digits.
    const xf = Let(f32(1).add(u))
    const f2 = Let(xf.mul(xf))
    const f3 = Let(f2.mul(xf))
    const f4 = Let(f2.mul(f2))
    const f5 = Let(f4.mul(xf))
    const f6 = Let(f3.mul(f3))
    const f7 = Let(f6.mul(xf))
    const p32 = Let(
      f7
        .sub(f6.mul(7.0))
        .add(f5.mul(21.0))
        .sub(f4.mul(35.0))
        .add(f3.mul(35.0))
        .sub(f2.mul(21.0))
        .add(xf.mul(7.0))
        .sub(1.0),
    )
    const pv = Let(isF32.select(p32, p64))

    // Plot in units of the true amplitude w⁷ (the picture is w-invariant).
    const yscale = Let(pow(w, f32(7)).mul(1.3))
    const v = Let(pv.div(yscale)) // computed curve, ±0.77 at the edges
    const u2 = Let(u.mul(u))
    const truth = Let(u2.mul(u2).mul(u2).mul(u).div(yscale)) // factored (x−1)⁷ — no cancellation
    const py = Let(p.vo.uv.y.sub(0.5).mul(2.0))
    const px = Let(f32(2).div(U.field.resolution.y)) // plot-units per pixel

    // Graph-paper styling: parchment with a pale grid (10 columns per half,
    // 0.2-plot-unit rows), ink axes.
    const gxf = Let(fract(sx.mul(10.0)))
    const gyf = Let(fract(py.add(1.0).mul(5.0)))
    const dgx = Let(min(gxf, f32(1).sub(gxf))) // distance to column line, in cells
    const dgy = Let(min(gyf, f32(1).sub(gyf)))
    const aaCx = Let(f32(30).div(U.field.resolution.x)) // ~1.5 px in cell units
    const aaCy = Let(f32(15).div(U.field.resolution.y))
    const grid = Let(
      f32(1)
        .sub(smoothstep(f32(0), aaCx, dgx))
        .add(f32(1).sub(smoothstep(f32(0), aaCy, dgy))),
    )
    const paper = vec3(0.96, 0.94, 0.88)
    const rgb0 = Let(mix(paper, vec3(0.72, 0.78, 0.86), min(grid, f32(1)).mul(0.45)))

    // Fill below the computed curve — its BOUNDARY is the visible verdict:
    // a smooth odd curve on the f64 side, a full-height noise barcode on f32.
    const fill = Let(step(py, v))
    const rgb1 = Let(mix(rgb0, vec3(0.62, 0.74, 0.9), fill.mul(0.5)))
    // Ink the computed curve where it is on-screen and locally flat enough.
    const ink = Let(f32(1).sub(smoothstep(px.mul(1.2), px.mul(3.0), abs(v.sub(py)))))
    const rgb2 = Let(mix(rgb1, vec3(0.13, 0.16, 0.3), ink.mul(0.85)))
    // The factored-form reference in warm red — clean on BOTH halves.
    const ref = Let(f32(1).sub(smoothstep(px.mul(0.8), px.mul(2.2), abs(truth.sub(py)))))
    const rgb3 = Let(mix(rgb2, vec3(0.8, 0.25, 0.2), ref.mul(0.65)))
    // Axes: y = 0 and x = 1 (the cancellation point).
    const axis = Let(
      min(
        smoothstep(f32(0), px.mul(1.5), abs(py)),
        smoothstep(f32(0), px.mul(1.5), abs(sx.sub(0.5)).mul(2.0)),
      ),
    )
    const rgb = Let(mix(vec3(0.35, 0.33, 0.3), rgb3, axis))
    return vec4(rgb, f32(1))
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

// `_fp64` guard lands at (group 0, binding 1) automatically.
const fp64CancellationModule = module({
  funcs: [vs, fsCancel],
  uses: [U, VsOut],
})

export const fp64Cancellation: ShaderExample = {
  id: 'fp64-cancellation',
  title: 'fp64 catastrophic cancellation',
  blurb:
    'The numerics-textbook plot on a GPU: (x−1)⁷ evaluated in EXPANDED form near x = 1 — eight ~1-sized terms must cancel to nine digits. f32 (left) returns pure noise thousands of times the plot range; emulated f64 (right) hugs the true curve. The thin red reference is the FACTORED form, which even f32 nails — restructure the math when you can, reach for fp64 when you can’t. Narrow the width slider and watch df64 hit its own wall two decades later.',
  category: 'generic',
  file: 'fp64-cancellation.ts',
  module: fp64CancellationModule,
  renderable: true,
  splitLabels: ['f32 expanded', 'f64 expanded'],
  controls: {
    resolution: { kind: 'resolution' },
    half_width: {
      kind: 'slider',
      label: 'Half-width w',
      min: 0.012,
      max: 0.12,
      step: 0.002,
      value: 0.05,
      wheel: true,
    },
    fp64: { kind: 'toggle', label: 'fp64 emulation', value: true },
  },
}
