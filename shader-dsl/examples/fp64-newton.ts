// ═══ @xgis/shader-dsl example — fp64 Newton fractal (z³ = 1) ═══
//
// The fp64 family's DIVISION showcase: Newton's method z ← z − (z³−1)/(3z²)
// runs a full complex division every iteration, and the f64 side does it with
// df64_div (the long-division EFT) — the one emulated op an add/mul-only demo
// never touches. The camera sits on a basin boundary of the three cube roots;
// the boundary is the Julia set of the Newton map and has the Wada property
// (every boundary point touches ALL THREE basins), so any zoom depth shows the
// three colours interleaved — CPU-verified to 50+ distinct (root, steps) cells
// per 48² window down to a 1e-11 span. The plain-f32 left half collapses once
// the span drops under one ulp of the center (~1e-7).
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
  mix,
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

// A boundary point between the basins of 1 and e^{2πi/3} (CPU bisection to
// ~1e-19, so the window straddles the boundary at every reachable zoom).
const CENTER_X = 0.17616732990860245
const CENTER_Y = 0.7111381151066305
const ITER = 48
// Cube roots of unity (exactly representable enough for f32 CLASSIFICATION —
// the roots are attracting, so classification is precision-insensitive).
const R_IM = 0.8660254037844386 // √3/2

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

const fsNewton = fn(
  'fs_newton',
  { vo: VsOut },
  (p) => {
    const span = Let(pow(f32(10.0), U.field.zoom_exp.neg()))
    const half = Let(p.vo.uv.x.mul(2.0))
    const sx = Let(half.sub(p.vo.uv.x.lt(0.5).select(0.0, 1.0)))
    const dx = Let(sx.sub(0.5).mul(span))
    const dy = Let(
      p.vo.uv.y.sub(0.5).mul(span).mul(U.field.resolution.y.div(U.field.resolution.x).mul(2.0)),
    )

    // Iterate to convergence; hand the FINAL z (narrowed) + step count out.
    const fx = Var(f32(0)) // final Re z
    const fy = Var(f32(0)) // final Im z
    const it = Var(f32(0)) // steps until the update went sub-epsilon
    If(p.vo.uv.x.lt(0.5).or(U.field.fp64.lt(0.5)), () => {
      // f32 twin — z₀ from the narrowed center: at deep zoom every pixel
      // starts at the SAME quantized point and the basins collapse flat.
      const zx = Var(toF32(U.field.center.x).add(dx))
      const zy = Var(toF32(U.field.center.y).add(dy))
      Loop(
        u32(0),
        (j) => j.lt(u32(ITER)),
        () => {
          const z2x = Let(zx.mul(zx).sub(zy.mul(zy)))
          const z2y = Let(zx.mul(zy).mul(2.0))
          const nx = Let(z2x.mul(zx).sub(z2y.mul(zy)).sub(1.0)) // Re(z³−1)
          const ny = Let(z2x.mul(zy).add(z2y.mul(zx))) // Im(z³−1)
          const gx = Let(z2x.mul(3.0)) // Re(3z²)
          const gy = Let(z2y.mul(3.0))
          const inv = Let(f32(1.0).div(gx.mul(gx).add(gy.mul(gy))))
          const qx = Let(nx.mul(gx).add(ny.mul(gy)).mul(inv))
          const qy = Let(ny.mul(gx).sub(nx.mul(gy)).mul(inv))
          zx.assign(zx.sub(qx))
          zy.assign(zy.sub(qy))
          If(qx.mul(qx).add(qy.mul(qy)).gt(1e-14), () => {
            it.assign(it.add(1.0))
          })
        },
      )
      fx.assign(zx)
      fy.assign(zy)
    }).else(() => {
      // f64 — the SAME Newton step; the quotient runs through df64_div.
      const zx = Var(U.field.center.x.add(toF64(dx)))
      const zy = Var(U.field.center.y.add(toF64(dy)))
      Loop(
        u32(0),
        (j) => j.lt(u32(ITER)),
        () => {
          const z2x = Let(zx.mul(zx).sub(zy.mul(zy)))
          const z2y = Let(zx.mul(zy).mul(2.0))
          const nx = Let(z2x.mul(zx).sub(z2y.mul(zy)).sub(1.0))
          const ny = Let(z2x.mul(zy).add(z2y.mul(zx)))
          const gx = Let(z2x.mul(3.0))
          const gy = Let(z2y.mul(3.0))
          const inv = Let(f64(1.0).div(gx.mul(gx).add(gy.mul(gy))))
          const qx = Let(nx.mul(gx).add(ny.mul(gy)).mul(inv))
          const qy = Let(ny.mul(gx).sub(nx.mul(gy)).mul(inv))
          zx.assign(zx.sub(qx))
          zy.assign(zy.sub(qy))
          If(toF32(qx.mul(qx).add(qy.mul(qy))).gt(1e-14), () => {
            it.assign(it.add(1.0))
          })
        },
      )
      fx.assign(toF32(zx))
      fy.assign(toF32(zy))
    })

    // Classify the landing root (attracting fixed points — f32 suffices) and
    // shade by convergence speed: boundary-hugging pixels stay near-black.
    const d0 = Let(fx.sub(1.0).mul(fx.sub(1.0)).add(fy.mul(fy)))
    const d1 = Let(
      fx
        .add(0.5)
        .mul(fx.add(0.5))
        .add(fy.sub(R_IM).mul(fy.sub(R_IM))),
    )
    const d2 = Let(
      fx
        .add(0.5)
        .mul(fx.add(0.5))
        .add(fy.add(R_IM).mul(fy.add(R_IM))),
    )
    const c0 = vec3(0.91, 0.34, 0.22) // root 1 — vermilion
    const c1 = vec3(0.2, 0.66, 0.88) // root e^{2πi/3} — sky
    const c2 = vec3(0.98, 0.78, 0.22) // root e^{−2πi/3} — gold
    const base = Let(d0.le(d1).and(d0.le(d2)).select(c0, d1.le(d2).select(c1, c2)))
    const speed = Let(f32(1).sub(it.div(ITER)))
    const rgb = base.mul(mix(f32(0.25), f32(1.0), speed))
    return vec4(rgb, f32(1))
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

// `_fp64` guard lands at (group 0, binding 1) automatically.
const fp64NewtonModule = module({
  funcs: [vs, fsNewton],
  uses: [U, VsOut],
})

export const fp64Newton: ShaderExample = {
  id: 'fp64-newton',
  title: 'fp64 Newton fractal',
  blurb:
    'Newton’s method for z³ = 1, colour = which cube root a pixel falls into — a full complex DIVISION per step, running through df64_div on the f64 side. The basin boundary has the Wada property (all three colours touch at every boundary point), so the interleaving persists to any depth: the f32 left half collapses flat past a ~1e-7 span while the emulated-double right half keeps dividing cleanly. Drag to pan, wheel to zoom, flip the fp64 toggle to compare.',
  category: 'generic',
  file: 'fp64-newton.ts',
  module: fp64NewtonModule,
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
      max: 13,
      step: 0.05,
      value: 7,
      wheel: true,
    },
    fp64: { kind: 'toggle', label: 'fp64 emulation', value: true },
  },
}
