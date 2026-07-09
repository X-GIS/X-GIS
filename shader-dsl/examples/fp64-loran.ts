// ═══ @xgis/shader-dsl example — fp64 hyperbolic navigation (LORAN) ═══
//
// Hyperbolic radio navigation, the pre-GPS chart grid: two stations, and your
// position line is "d₁ − d₂ = const" — a hyperbola. The catch for GPU floats:
// the observer is ~10⁷ units from both stations, the usable signal is the
// DIFFERENCE of two nearly-equal distances (catastrophic cancellation), and
// the band phase needs fract() of a coordinate-scale value — three classic
// f32 killers in one formula. The f64 side runs the whole chain through the
// vec64 `distance` reduction (extended-precision accumulation) and a df64
// fract; the plain-f32 left half renders quantized band garbage at ANY zoom
// (CPU-verified: 17 clean band values vs 6 garbage ones per 48² window).
//
// The `_fp64` guard uniform is auto-injected by the lowering; the render
// harnesses bind it to 1.0f by probing the program for the Fp64Guard block.

import {
  fn,
  module,
  vec2,
  vec3,
  vec4,
  f32,
  pow,
  fract,
  min,
  mix,
  length,
  distance,
  smoothstep,
  fwidth,
  toF32,
  toF64,
  f32T,
  vec2fT,
  vec2f64T,
  vec2f64,
  Let,
  uniformStruct,
} from '../src/index.ts'
import { VsOut, vs } from './_fullscreen.ts'
import type { ShaderExample } from './_shared.ts'

// The observer and both stations are host-supplied df64 uniforms swept out
// from the origin together via the DISTANCE slider (see controls below), so
// there are no hard-coded station coordinates any more — only the band pitches.
const LAMBDA_H = 4 // hyperbolic band spacing (world units of d₁−d₂)
const LAMBDA_E = 16 // elliptic band spacing (world units of d₁+d₂)

const U = uniformStruct(
  'Uniforms',
  { group: 0, binding: 0, as: 'u' },
  {
    center: vec2f64T, // observer — one DF64Vec2 slot [hi.x, hi.y, lo.x, lo.y]
    st_a: vec2f64T, // master station (swept with the observer via the DISTANCE slider)
    st_b: vec2f64T, // secondary station
    resolution: vec2fT,
    zoom_exp: f32T, // view span = 10^-zoom_exp world units (negative = zoom out)
    fp64: f32T, // toggle: 1 = split-screen f32 | f64 (canonical), 0 = all-f32
  },
)

const fsLoran = fn(
  'fs_loran',
  { vo: VsOut },
  (p) => {
    const span = Let(pow(f32(10.0), U.field.zoom_exp.neg()))
    const half = Let(p.vo.uv.x.mul(2.0))
    const sx = Let(half.sub(p.vo.uv.x.lt(0.5).select(0.0, 1.0)))
    const dx = Let(sx.sub(0.5).mul(span))
    const dy = Let(
      p.vo.uv.y.sub(0.5).mul(span).mul(U.field.resolution.y.div(U.field.resolution.x).mul(2.0)),
    )

    const isF32 = Let(p.vo.uv.x.lt(0.5).or(U.field.fp64.lt(0.5)))
    // f64 chain — vec64 distance accumulates through the scalar df64 chain,
    // the subtraction cancels EXACTLY, and only the band phase narrows.
    const pos = Let(vec2f64(U.field.center.x.add(toF64(dx)), U.field.center.y.add(toF64(dy))))
    const d1 = Let(distance(pos, U.field.st_a))
    const d2 = Let(distance(pos, U.field.st_b))
    const th64 = Let(toF32(fract(d1.sub(d2).mul(1 / LAMBDA_H))))
    const te64 = Let(toF32(fract(d1.add(d2).mul(1 / LAMBDA_E))))
    // f32 twin — SAME formulas, everything narrowed first: once the coordinate
    // ulp exceeds a band, d₁, d₂ quantize and the band phase becomes garbage.
    const pos32 = Let(vec2(toF32(U.field.center.x).add(dx), toF32(U.field.center.y).add(dy)))
    const d1f = Let(length(pos32.sub(vec2(toF32(U.field.st_a.x), toF32(U.field.st_a.y)))))
    const d2f = Let(length(pos32.sub(vec2(toF32(U.field.st_b.x), toF32(U.field.st_b.y)))))
    const th32 = Let(fract(d1f.sub(d2f).mul(1 / LAMBDA_H)))
    const te32 = Let(fract(d1f.add(d2f).mul(1 / LAMBDA_E)))

    const th = Let(isF32.select(th32, th64))
    const te = Let(isF32.select(te32, te64))

    // Distance to the nearest band line (triangle fold — continuous across the
    // fract seam, which is exactly where the line sits).
    const dh = Let(min(th, f32(1).sub(th)))
    const de = Let(min(te, f32(1).sub(te)))
    const aaH = Let(fwidth(dh).mul(1.2).add(1e-4))
    const aaE = Let(fwidth(de).mul(1.2).add(1e-4))
    const lineH = Let(f32(1).sub(smoothstep(f32(0), aaH, dh)))
    const lineE = Let(f32(1).sub(smoothstep(f32(0), aaE, de)))

    // Chart styling: deep sea, cyan hyperbolae (the position lines), faint
    // amber ellipses (the range net), a soft band tint to keep the field alive.
    const sea = Let(mix(vec3(0.02, 0.07, 0.13), vec3(0.04, 0.12, 0.2), p.vo.uv.y))
    const rgb = sea
      .add(vec3(0.0, 0.06, 0.08).mul(th)) // band tint
      .add(vec3(0.25, 0.95, 0.95).mul(lineH.mul(0.9)))
      .add(vec3(0.95, 0.7, 0.25).mul(lineE.mul(0.35)))
    return vec4(rgb, f32(1))
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

// `_fp64` guard lands at (group 0, binding 1) automatically.
const fp64LoranModule = module({
  funcs: [vs, fsLoran],
  uses: [U, VsOut],
})

export const fp64Loran: ShaderExample = {
  id: 'fp64-loran',
  title: 'fp64 hyperbolic navigation',
  blurb:
    'A LORAN-style chart grid: cyan hyperbolae of constant d₁−d₂ to two stations, amber ellipses of constant d₁+d₂. The signal is the DIFFERENCE of two nearly-equal distances followed by fract() — catastrophic cancellation plus phase recovery. Drag the DISTANCE slider to push the whole station triangle out from the origin: near 10⁶ both halves are a clean chart, but past ~10⁷·² the coordinate ulp grows wider than a band, d₁ and d₂ quantize, and the plain-f32 left half dissolves into blocky garbage — while the vec64 distance reduction keeps the right half sharp to 10⁹. Wheel drives the distance; flip the fp64 toggle to compare.',
  category: 'cartographic',
  file: 'fp64-loran.ts',
  module: fp64LoranModule,
  renderable: true,
  splitLabels: ['f32', 'f64 (emulated)'],
  controls: {
    // Observer and both stations sweep together: coord = base·10^mag (+offset for
    // the observer's sub-unit detail). At mag = 7 this is the classic ~10⁷ view.
    center: { kind: 'logmag2d', magField: 'mag', base: [2.31, 3.07], offset: [0.13, 0.57] },
    st_a: { kind: 'logmag2d', magField: 'mag', base: [1.2, 3.4], offset: [0, 0] },
    st_b: { kind: 'logmag2d', magField: 'mag', base: [1.9, 2.6], offset: [0, 0] },
    resolution: { kind: 'resolution' },
    mag: {
      kind: 'slider',
      label: 'Distance from origin 10^x',
      min: 4,
      max: 9,
      step: 0.02,
      value: 6,
      wheel: true,
    },
    // View span across each half (10^-zoom_exp world units ≈ number of bands).
    zoom_exp: { kind: 'slider', label: 'Zoom 10^-x', min: -3.0, max: 3.0, step: 0.05, value: -1.6 },
    fp64: { kind: 'toggle', label: 'fp64 emulation', value: true },
  },
}
