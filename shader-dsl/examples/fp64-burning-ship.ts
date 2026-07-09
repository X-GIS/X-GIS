// ═══ @xgis/shader-dsl example — fp64 Burning Ship ═══
//
// The Burning Ship (z ← (|Re z| + i·|Im z|)² + c) is the fp64 family's
// showcase for `abs` ON THE f64 TYPE: the fold happens inside the
// extended-precision iteration, not after a narrowing — df64 abs is exact
// (negate both planes), so the fold costs no precision. The camera sits on
// the set's spike at c = −1.748 on the real axis (the axis itself never
// escapes — same real dynamics as the Mandelbrot needle), where the CPU
// check keeps 40–110 distinct escape bands per 48² window from a 1e-5 span
// all the way down to 1e-12. The plain-f32 left half collapses flat once the
// span drops under one ulp of 1.748 (~1e-7).
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
  abs,
  pow,
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

// A spike point with escape structure at every depth (CPU-verified); y = 0
// keeps the never-escaping real axis mid-frame at every zoom.
const CENTER_X = -1.748
const CENTER_Y = 0
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

const fsShip = fn(
  'fs_ship',
  { vo: VsOut },
  (p) => {
    const span = Let(pow(f32(10.0), U.field.zoom_exp.neg()))
    const half = Let(p.vo.uv.x.mul(2.0))
    const sx = Let(half.sub(p.vo.uv.x.lt(0.5).select(0.0, 1.0)))
    const dx = Let(sx.sub(0.5).mul(span))
    const dy = Let(
      p.vo.uv.y.sub(0.5).mul(span).mul(U.field.resolution.y.div(U.field.resolution.x).mul(2.0)),
    )

    const it = Var(f32(0))
    const m2 = Var(f32(0)) // |z|² at escape (frozen once the guard fails)
    If(p.vo.uv.x.lt(0.5).or(U.field.fp64.lt(0.5)), () => {
      // f32 twin — SAME fold-and-square, center narrowed.
      const cx = Let(toF32(U.field.center.x).add(dx))
      const cy = Let(toF32(U.field.center.y).add(dy))
      const zx = Var(f32(0))
      const zy = Var(f32(0))
      Loop(
        u32(0),
        (j) => j.lt(u32(ITER)),
        () => {
          If(zx.mul(zx).add(zy.mul(zy)).le(16.0), () => {
            const nzx = Let(zx.mul(zx).sub(zy.mul(zy)).add(cx))
            zy.assign(abs(zx.mul(zy)).mul(2.0).add(cy))
            zx.assign(nzx)
            it.assign(it.add(1.0))
          })
        },
      )
      m2.assign(zx.mul(zx).add(zy.mul(zy)))
    }).else(() => {
      // f64 — |Re|, |Im| fold in extended precision (2|zx·zy| ≡ the |Im| fold
      // of the squared form: (|zx|+i|zy|)² has Im = 2|zx||zy| = 2|zx·zy|).
      const cx = Let(U.field.center.x.add(toF64(dx)))
      const cy = Let(U.field.center.y.add(toF64(dy)))
      const zx = Var(f64(0))
      const zy = Var(f64(0))
      Loop(
        u32(0),
        (j) => j.lt(u32(ITER)),
        () => {
          If(zx.mul(zx).add(zy.mul(zy)).le(16.0), () => {
            const nzx = Let(zx.mul(zx).sub(zy.mul(zy)).add(cx))
            zy.assign(abs(zx.mul(zy)).mul(2.0).add(cy))
            zx.assign(nzx)
            it.assign(it.add(1.0))
          })
        },
      )
      m2.assign(toF32(zx.mul(zx).add(zy.mul(zy))))
    })

    // Smooth escape time through an ember palette (dark hull → orange flame →
    // pale smoke); interior stays black. Same log₂ log₂ smoothing as
    // fp64-mandelbrot.ts.
    const sn = Let(it.sub(log2(max(log2(max(m2, 1.0001)), 0.0001))).add(1.0))
    const inside = Let(step(f32(ITER).sub(0.5), it))
    const s = Let(sn.div(ITER))
    const ease = Let(s.mul(s).mul(f32(3).sub(s.mul(2)))) // s²(3−2s) ember ramp
    const rgb = mix(
      mix(vec3(0.06, 0.02, 0.05), vec3(0.95, 0.45, 0.08), ease),
      vec3(1.0, 0.93, 0.75),
      s.mul(s),
    ).mul(f32(1).sub(inside))
    return vec4(rgb, f32(1))
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

// `_fp64` guard lands at (group 0, binding 1) automatically.
const fp64BurningShipModule = module({
  funcs: [vs, fsShip],
  uses: [U, VsOut],
})

export const fp64BurningShip: ShaderExample = {
  id: 'fp64-burning-ship',
  title: 'fp64 Burning Ship',
  blurb:
    'The Burning Ship fractal (fold |Re z|, |Im z| before squaring) zoomed onto its needle spike — the fold runs as df64 abs INSIDE the extended-precision iteration, exact by construction. The plain-f32 left half collapses flat past a ~1e-7 span; the emulated-double right half keeps the flame filaments down to the df64 floor. Drag to pan, wheel to zoom, flip the fp64 toggle to collapse the right half in place.',
  category: 'generic',
  file: 'fp64-burning-ship.ts',
  module: fp64BurningShipModule,
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
      min: 0,
      max: 16,
      step: 0.05,
      value: 4,
      wheel: true,
    },
    fp64: { kind: 'toggle', label: 'fp64 emulation', value: true },
  },
}
