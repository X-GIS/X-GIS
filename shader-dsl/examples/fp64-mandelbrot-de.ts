// ═══ @xgis/shader-dsl example — fp64 Mandelbrot distance estimate ═══
//
// MIXED precision on purpose: the ORBIT (z) iterates in f64 — its absolute
// position is what deep zoom destroys — while the DERIVATIVE (dz ← 2·z·dz + 1)
// iterates in plain f32 from a per-step narrowed z, because the distance
// estimate d = ½·|z|·ln|z| / |dz| only ever needs |dz| to a few digits.
// Precision goes where it pays: the classic df64 discipline (opt in per VALUE,
// not per shader). The boundary distance, normalised by the view span, shades
// glowing filaments that stay crisp at any depth on the f64 side — the f32
// left half collapses past a ~1e-7 span. Camera on a needle filament of the
// period-3 minibrot neighbourhood (CPU-verified: 8–10 distinct distance
// buckets per 40² window from 1e-5 down to 1e-12 spans).
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
  sqrt,
  log,
  exp,
  min,
  max,
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

// A needle filament beside the period-3 minibrot (x ≈ −1.749); y = 0 keeps
// the never-escaping real axis (and so the set's boundary) mid-frame forever.
const CENTER_X = -1.7489
const CENTER_Y = 0
const ITER = 160
const ESCAPE_M2 = 1e6 // large escape radius tightens the distance estimate

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

const fsDe = fn(
  'fs_de',
  { vo: VsOut },
  (p) => {
    const span = Let(pow(f32(10.0), U.field.zoom_exp.neg()))
    const half = Let(p.vo.uv.x.mul(2.0))
    const sx = Let(half.sub(p.vo.uv.x.lt(0.5).select(0.0, 1.0)))
    const dx = Let(sx.sub(0.5).mul(span))
    const dy = Let(
      p.vo.uv.y.sub(0.5).mul(span).mul(U.field.resolution.y.div(U.field.resolution.x).mul(2.0)),
    )

    const m2f = Var(f32(0)) // |z|² when the orbit stopped (≤ ESCAPE_M2 = interior)
    const dm2 = Var(f32(1)) // |dz|² at that moment
    If(p.vo.uv.x.lt(0.5).or(U.field.fp64.lt(0.5)), () => {
      // f32 twin — orbit AND derivative in f32, center narrowed.
      const cx = Let(toF32(U.field.center.x).add(dx))
      const cy = Let(toF32(U.field.center.y).add(dy))
      const zx = Var(f32(0))
      const zy = Var(f32(0))
      const ux = Var(f32(0)) // dz
      const uy = Var(f32(0))
      Loop(
        u32(0),
        (j) => j.lt(u32(ITER)),
        () => {
          If(zx.mul(zx).add(zy.mul(zy)).le(ESCAPE_M2), () => {
            const nux = Let(zx.mul(ux).sub(zy.mul(uy)).mul(2.0).add(1.0))
            uy.assign(zx.mul(uy).add(zy.mul(ux)).mul(2.0))
            ux.assign(nux)
            const nzx = Let(zx.mul(zx).sub(zy.mul(zy)).add(cx))
            zy.assign(zx.mul(zy).mul(2.0).add(cy))
            zx.assign(nzx)
          })
        },
      )
      m2f.assign(zx.mul(zx).add(zy.mul(zy)))
      dm2.assign(ux.mul(ux).add(uy.mul(uy)))
    }).else(() => {
      // f64 orbit / f32 derivative — z narrowed once per step for the dz twin.
      const cx = Let(U.field.center.x.add(toF64(dx)))
      const cy = Let(U.field.center.y.add(toF64(dy)))
      const zx = Var(f64(0))
      const zy = Var(f64(0))
      const ux = Var(f32(0))
      const uy = Var(f32(0))
      Loop(
        u32(0),
        (j) => j.lt(u32(ITER)),
        () => {
          If(toF32(zx.mul(zx).add(zy.mul(zy))).le(ESCAPE_M2), () => {
            const zx32 = Let(toF32(zx))
            const zy32 = Let(toF32(zy))
            const nux = Let(zx32.mul(ux).sub(zy32.mul(uy)).mul(2.0).add(1.0))
            uy.assign(zx32.mul(uy).add(zy32.mul(ux)).mul(2.0))
            ux.assign(nux)
            const nzx = Let(zx.mul(zx).sub(zy.mul(zy)).add(cx))
            zy.assign(zx.mul(zy).mul(2.0).add(cy))
            zx.assign(nzx)
          })
        },
      )
      m2f.assign(toF32(zx.mul(zx).add(zy.mul(zy))))
      dm2.assign(ux.mul(ux).add(uy.mul(uy)))
    })

    // d = ½·|z|·ln|z| / |dz|, normalised by the span → depth-invariant shading.
    const mz = Let(sqrt(max(m2f, 1.0)))
    const de = Let(
      mz
        .mul(log(mz))
        .mul(0.5)
        .div(sqrt(max(dm2, 1e-30))),
    )
    const t = Let(min(de.div(span.mul(0.012)), 40.0))
    // Interior (never escaped) → 0 glow; filaments glow where d/span → 0.
    const escaped = Let(m2f.gt(ESCAPE_M2).select(1.0, 0.0))
    const glow = Let(exp(t.neg().mul(1.2)).mul(escaped))
    const body = Let(exp(t.neg().mul(0.25)).mul(escaped))
    const rgb = vec3(0.02, 0.03, 0.08)
      .add(vec3(0.12, 0.2, 0.42).mul(body))
      .add(vec3(1.0, 0.85, 0.45).mul(glow))
    return vec4(rgb, f32(1))
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

// `_fp64` guard lands at (group 0, binding 1) automatically.
const fp64MandelbrotDeModule = module({
  funcs: [vs, fsDe],
  uses: [U, VsOut],
})

export const fp64MandelbrotDe: ShaderExample = {
  id: 'fp64-mandelbrot-de',
  title: 'fp64 distance estimate',
  blurb:
    'Mandelbrot boundary rendered by DISTANCE ESTIMATE (d = ½·|z|·ln|z|/|dz|) with precision split mid-formula: the orbit z iterates in emulated f64 (its absolute position is what deep zoom destroys) while the derivative dz iterates in plain f32 (the estimate needs |dz| to a few digits only). Filaments keep glowing at any depth on the right; the all-f32 left half collapses past a ~1e-7 span. Drag to pan, wheel to zoom, flip the fp64 toggle to compare.',
  category: 'generic',
  file: 'fp64-mandelbrot-de.ts',
  module: fp64MandelbrotDeModule,
  renderable: true,
  splitLabels: ['f32', 'f64 orbit + f32 dz'],
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
      value: 9,
      wheel: true,
    },
    fp64: { kind: 'toggle', label: 'fp64 emulation', value: true },
  },
}
