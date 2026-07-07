// ═══ @xgis/shader-dsl example — fp64 deep-zoom Julia set ═══
//
// The Julia twin of fp64-mandelbrot.ts: the SEED is fixed (c = −0.8 + 0.156i)
// and the PIXEL becomes z₀, so the precision-critical value is the per-pixel
// starting point itself — exactly the extended-precision `center + offset` add
// that df64 exists for. The camera parks on a Julia-set point BESIDE the
// repelling fixed point z* = (1 + √(1−4c))/2 (repelling fixed points lie ON
// the set, and its neighbourhood keeps escape times low and self-similar to
// any depth), bisected along the horizontal line y = toF32(Im z*) so that the
// center's y survives f32 narrowing EXACTLY: the plain-f32 left half then
// collapses to horizontal escape BANDS (the x axis dies first — same
// signature as fp64-mandelbrot's thin-line left half) instead of vanishing
// into a solid interior fill.
//
// The `_fp64` guard uniform is auto-injected by the lowering; the render
// harnesses bind it to 1.0f by probing the program for the Fp64Guard block.

import {
  fn,
  module,
  vec3,
  vec4,
  f32,
  pow,
  cos,
  log2,
  max,
  mix,
  step,
  toF32,
  toF64,
  f32T,
  vec2fT,
  vec2f64T,
  If,
  Loop,
  Var,
  Let,
  u32,
  uniformStruct,
} from '../src/index.ts'
import { VsOut, vs } from './_fullscreen.ts'
import type { ShaderExample } from './_shared.ts'

// Seed of the Julia set; both components are exactly f32-representable, so the
// f32 half degrades ONLY through the pixel coordinate — the cleanest A/B.
const C_RE = -0.8
const C_IM = 0.156
// On the Julia set beside the repelling fixed point (|2z*| ≈ 3.06 > 1):
// y is EXACTLY f32-representable (toF32(Im z*)), x is CPU-bisected onto the
// escape boundary along that line — verified to keep 44+ distinct escape
// bands per 40² window down to a 1e-12 span, with ~7 surviving row bands on
// the narrowed f32 side.
const CENTER_X = 1.5255044073468653
const CENTER_Y = -0.07591217756271362
const ITER = 128

const U = uniformStruct(
  'Uniforms',
  { group: 0, binding: 0, as: 'u' },
  {
    center: vec2f64T, // one DF64Vec2 slot — host packs [hi.x, hi.y, lo.x, lo.y]
    resolution: vec2fT,
    zoom_exp: f32T, // view span = 10^-zoom_exp complex units
    fp64: f32T, // toggle: 1 = split-screen f32 | f64 (canonical), 0 = all-f32
  },
)

const fsJulia = fn(
  'fs_julia',
  { vo: VsOut },
  (p) => {
    const span = Let(pow(f32(10.0), U.field.zoom_exp.neg()))
    // Each half maps its own 0..1 sub-range onto the SAME complex window
    // (pan lives on the HOST in full double precision — see fp64-mandelbrot.ts).
    const half = Let(p.vo.uv.x.mul(2.0))
    const sx = Let(half.sub(p.vo.uv.x.lt(0.5).select(0.0, 1.0)))
    const dx = Let(sx.sub(0.5).mul(span))
    const dy = Let(
      p.vo.uv.y.sub(0.5).mul(span).mul(U.field.resolution.y.div(U.field.resolution.x).mul(2.0)),
    )

    const it = Var(f32(0))
    const m2 = Var(f32(0)) // |z|² at escape (frozen once the guard fails)
    If(p.vo.uv.x.lt(0.5).or(U.field.fp64.lt(0.5)), () => {
      // f32 twin — z₀ built from the narrowed center: at deep zoom the pixel
      // coordinate quantizes to f32 ulps and whole columns collapse.
      const zx = Var(toF32(U.field.center.x).add(dx))
      const zy = Var(toF32(U.field.center.y).add(dy))
      Loop(
        u32(0),
        (j) => j.lt(u32(ITER)),
        () => {
          If(zx.mul(zx).add(zy.mul(zy)).le(16.0), () => {
            const nzx = Let(zx.mul(zx).sub(zy.mul(zy)).add(C_RE))
            zy.assign(zx.mul(zy).mul(2.0).add(C_IM))
            zx.assign(nzx)
            it.assign(it.add(1.0))
          })
        },
      )
      m2.assign(zx.mul(zx).add(zy.mul(zy)))
    }).else(() => {
      // f64 — identical authoring; z₀ keeps its extended-precision position.
      const zx = Var(U.field.center.x.add(toF64(dx)))
      const zy = Var(U.field.center.y.add(toF64(dy)))
      Loop(
        u32(0),
        (j) => j.lt(u32(ITER)),
        () => {
          If(zx.mul(zx).add(zy.mul(zy)).le(16.0), () => {
            const nzx = Let(zx.mul(zx).sub(zy.mul(zy)).add(C_RE))
            zy.assign(zx.mul(zy).mul(2.0).add(C_IM))
            zx.assign(nzx)
            it.assign(it.add(1.0))
          })
        },
      )
      m2.assign(toF32(zx.mul(zx).add(zy.mul(zy))))
    })

    // Smooth escape time (same log₂ log₂ treatment as fp64-mandelbrot.ts)
    // through a cool cosine palette; interior stays black.
    const sn = Let(it.sub(log2(max(log2(max(m2, 1.0001)), 0.0001))).add(1.0))
    const inside = Let(step(f32(ITER).sub(0.5), it))
    const s = Let(sn.div(ITER))
    const ph = vec3(0.0, 0.25, 0.6)
    const rgb = vec3(0.5)
      .add(cos(ph.add(s.mul(5.5)).add(2.2)).mul(0.5))
      .mul(mix(f32(0.35), f32(1.0), s))
      .mul(f32(1).sub(inside))
    return vec4(rgb, f32(1))
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

// `_fp64` guard lands at (group 0, binding 1) automatically.
const fp64JuliaModule = module({
  funcs: [vs, fsJulia],
  uses: [U, VsOut],
})

export const fp64Julia: ShaderExample = {
  id: 'fp64-julia',
  title: 'fp64 Julia set',
  blurb:
    'The Julia-set face of the double-float technique: the seed c is fixed and the PIXEL becomes z₀, so precision lives entirely in the starting coordinate. The camera parks on a repelling fixed point — a point that is ON the Julia set at every scale — and dives: the plain-f32 left half collapses flat past a ~1e-7 span while the emulated-double right half keeps spiralling to the df64 floor. Drag to pan, wheel to zoom, flip the fp64 toggle to collapse the right half in place.',
  category: 'generic',
  file: 'fp64-julia.ts',
  module: fp64JuliaModule,
  renderable: true,
  splitLabels: ['f32', 'f64 (emulated)'],
  controls: {
    center: {
      kind: 'pan2d',
      value: [CENTER_X, CENTER_Y],
      zoomExpField: 'zoom_exp',
      unitsPerWidth: 2,
    },
    resolution: { kind: 'resolution' },
    zoom_exp: {
      kind: 'slider',
      label: 'Zoom 10^-x',
      min: 1,
      max: 14,
      step: 0.05,
      value: 7,
      wheel: true,
    },
    fp64: { kind: 'toggle', label: 'fp64 emulation', value: true },
  },
}
