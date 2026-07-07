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

// Master / secondary stations and the default observer, all ~10⁷ world units
// out (ulp_f32(2.3e7) = 2 — coarser than a whole hyperbolic band).
const ST_A_X = 1.2e7
const ST_A_Y = 3.4e7
const ST_B_X = 1.9e7
const ST_B_Y = 2.6e7
const OBS_X = 2.31e7 + 0.13
const OBS_Y = 3.07e7 + 0.57
const LAMBDA_H = 4 // hyperbolic band spacing (world units of d₁−d₂)
const LAMBDA_E = 16 // elliptic band spacing (world units of d₁+d₂)

const U = uniformStruct(
  'Uniforms',
  { group: 0, binding: 0, as: 'u' },
  {
    center: vec2f64T, // one DF64Vec2 slot — host packs [hi.x, hi.y, lo.x, lo.y]
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
    const d1 = Let(distance(pos, vec2f64(ST_A_X, ST_A_Y)))
    const d2 = Let(distance(pos, vec2f64(ST_B_X, ST_B_Y)))
    const th64 = Let(toF32(fract(d1.sub(d2).mul(1 / LAMBDA_H))))
    const te64 = Let(toF32(fract(d1.add(d2).mul(1 / LAMBDA_E))))
    // f32 twin — SAME formulas, everything narrowed first: d₁, d₂ quantize to
    // ~2-unit ulps and the band phase is garbage at any zoom.
    const pos32 = Let(vec2(toF32(U.field.center.x).add(dx), toF32(U.field.center.y).add(dy)))
    const d1f = Let(length(pos32.sub(vec2(ST_A_X, ST_A_Y))))
    const d2f = Let(length(pos32.sub(vec2(ST_B_X, ST_B_Y))))
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
    'A LORAN-style chart grid: cyan hyperbolae of constant d₁−d₂ to two stations 10⁷ units away, amber ellipses of constant d₁+d₂. The signal is the DIFFERENCE of two nearly-equal distances followed by fract() — catastrophic cancellation plus phase recovery, both beyond f32 at this coordinate scale. The vec64 distance reduction keeps the right half a clean chart while the plain-f32 left half is quantized garbage at every zoom. Drag to pan, wheel to zoom, flip the fp64 toggle to compare.',
  category: 'cartographic',
  file: 'fp64-loran.ts',
  module: fp64LoranModule,
  renderable: true,
  splitLabels: ['f32', 'f64 (emulated)'],
  controls: {
    center: {
      kind: 'pan2d',
      value: [OBS_X, OBS_Y],
      zoomExpField: 'zoom_exp',
      unitsPerWidth: 2,
    },
    resolution: { kind: 'resolution' },
    // 10^1.6 ≈ 40 world units (≈ 10 hyperbolic bands) across each half by
    // default; zooming out packs more bands in, zooming in past exp ≈ 0.8
    // leaves less than one band.
    zoom_exp: {
      kind: 'slider',
      label: 'Zoom 10^-x',
      min: -2.4,
      max: 0.8,
      step: 0.05,
      value: -1.6,
      wheel: true,
    },
    fp64: { kind: 'toggle', label: 'fp64 emulation', value: true },
  },
}
