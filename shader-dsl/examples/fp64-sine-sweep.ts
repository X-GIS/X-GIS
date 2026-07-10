// ═══ @xgis/shader-dsl example — fp64 sine sweep (df64 sin at large argument) ═══
//
// sin(x) where the argument x is a LARGE base plus a small on-screen sweep. As the
// base grows past ~2²⁴, one f32 ulp of x widens past the sweep window: the plain-f32
// argument `base + sx·span` quantizes to a few discrete steps, so its sine renders
// as a STAIRCASE — the wave the eye expects has dissolved into aliased blocks. The
// df64 side carries the base in extended precision, adds the sweep exactly, and the
// injected df64_sin (3-stage reduction + tabled angle-addition + short Taylor)
// resolves the smooth curve. Drag the BASE slider from 10⁴ (both smooth) up to 10⁸
// (the f32 wave shatters, the f64 wave holds); flip the fp64 toggle to shatter both.
//
// This is the transcendental twin of fp64-cancellation: same graph-paper split, a
// different f32 failure mode (argument-resolution loss, not term cancellation).
//
// The `_fp64` guard uniform is auto-injected by the lowering; the render harnesses
// bind it to 1.0f by probing the program for the Fp64Guard block.

import {
  fn,
  module,
  uniformStruct,
  vec3,
  vec4,
  f32,
  toF64,
  sin,
  fract,
  abs,
  min,
  mix,
  step,
  smoothstep,
  toF32,
  f32T,
  f64T,
  vec2fT,
  Let,
} from '../src/index.ts'
import { VsOut, vs } from './_fullscreen.ts'
import type { ShaderExample } from './_shared.ts'

// Sweep window (radians of argument spanned across one half's width). ~4 cycles
// when the base is small enough to resolve them.
const SPAN = 8 * Math.PI

const Uni = uniformStruct(
  'Uniforms',
  { group: 0, binding: 0, as: 'u' },
  {
    resolution: vec2fT,
    base: f64T, // large argument base (seconds-like), swept 10^4..10^8
    fp64: f32T, // toggle: 1 = split-screen f32 | f64 (canonical), 0 = all-f32
  },
)

const fsSweep = fn(
  'fs_sweep',
  { vo: VsOut },
  (p) => {
    // Position within this half: sx ∈ [0, 1] over each half's width.
    const halfUv = Let(p.vo.uv.x.mul(2.0))
    const sx = Let(halfUv.sub(p.vo.uv.x.lt(0.5).select(0.0, 1.0)))
    const isF32 = Let(p.vo.uv.x.lt(0.5).or(Uni.field.fp64.lt(0.5)))

    // The swept argument = base + sx·SPAN. f64: add in extended precision, then
    // df64_sin. f32: narrow the base first (its ulp swallows the sweep at large base).
    const arg64 = Let(Uni.field.base.add(toF64(sx.mul(SPAN))))
    const y64 = Let(toF32(sin(arg64)))
    const y32 = Let(sin(toF32(Uni.field.base).add(sx.mul(SPAN))))
    const v = Let(isF32.select(y32, y64)) // sine value ∈ [−1, 1]

    // Plot: py ∈ [−1, 1] over the height; the curve is v.
    const py = Let(p.vo.uv.y.sub(0.5).mul(2.0))
    const px = Let(f32(2).div(Uni.field.resolution.y)) // plot-units per pixel

    // Graph-paper: parchment + a pale grid (10 columns per half, 0.25-unit rows).
    const gxf = Let(fract(sx.mul(10.0)))
    const gyf = Let(fract(py.add(1.0).mul(4.0)))
    const dgx = Let(min(gxf, f32(1).sub(gxf)))
    const dgy = Let(min(gyf, f32(1).sub(gyf)))
    const aaCx = Let(f32(30).div(Uni.field.resolution.x))
    const aaCy = Let(f32(20).div(Uni.field.resolution.y))
    const grid = Let(
      f32(1)
        .sub(smoothstep(f32(0), aaCx, dgx))
        .add(f32(1).sub(smoothstep(f32(0), aaCy, dgy))),
    )
    const paper = vec3(0.96, 0.94, 0.88)
    const rgb0 = Let(mix(paper, vec3(0.72, 0.78, 0.86), min(grid, f32(1)).mul(0.45)))

    // Fill under the curve — its boundary reads the verdict at a glance (a smooth
    // sine on f64, a stepped barcode on f32 once the base is large).
    const fill = Let(step(py, v))
    const rgb1 = Let(mix(rgb0, vec3(0.62, 0.74, 0.9), fill.mul(0.4)))
    // Ink the curve.
    const ink = Let(f32(1).sub(smoothstep(px.mul(1.2), px.mul(3.0), abs(v.sub(py)))))
    const rgb2 = Let(mix(rgb1, vec3(0.13, 0.16, 0.3), ink.mul(0.85)))
    // Axes: the midline y = 0 and the half divider.
    const axis = Let(
      min(
        smoothstep(f32(0), px.mul(1.5), abs(py)),
        smoothstep(f32(0), px.mul(1.5), abs(sx.sub(0.5)).mul(2.0)),
      ),
    )
    const rgb = Let(mix(vec3(0.35, 0.33, 0.3), rgb2, axis))
    return vec4(rgb, f32(1))
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

// `_fp64` guard lands at (group 0, binding 1) automatically.
const fp64SineSweepModule = module({
  funcs: [vs, fsSweep],
  uses: [Uni, VsOut],
})

export const fp64SineSweep: ShaderExample = {
  id: 'fp64-sine-sweep',
  title: 'fp64 sine sweep',
  blurb:
    'sin(x) for x = a large base + a small on-screen sweep. Past ~2²⁴ one f32 ulp of the argument grows wider than the sweep window, so the plain-f32 wave (left) collapses into an aliased staircase; the emulated-f64 side (right) carries the base in extended precision and the injected df64_sin — argument reduction + tabled angle-addition + a short Taylor — resolves the smooth curve. Drag BASE from 10⁴ (both smooth) to 10⁸ (only f64 survives); flip the fp64 toggle to shatter both. Correct on backends where the df64 multiply survives fast-math (Apple/Metal collapses it — see AUTHORING §7).',
  category: 'generic',
  file: 'fp64-sine-sweep.ts',
  module: fp64SineSweepModule,
  renderable: true,
  splitLabels: ['f32 sin', 'f64 sin (emulated)'],
  controls: {
    resolution: { kind: 'resolution' },
    base: { kind: 'logmag1d', magField: 'mag', base: 1, offset: 0.123 },
    mag: {
      kind: 'slider',
      label: 'Argument base 10^x',
      min: 4,
      max: 8,
      step: 0.02,
      value: 6,
      wheel: true,
    },
    fp64: { kind: 'toggle', label: 'fp64 emulation', value: true },
  },
}
