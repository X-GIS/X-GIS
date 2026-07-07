// ═══ @xgis/shader-dsl example — fp64 deep-zoom Mandelbrot ═══
//
// THE classic double-float demo (the df64 technique traces back to the NVIDIA
// CUDA SDK Mandelbrot sample): at a zoom span of ~1e-7 on a filament of the
// needle spike (x ≈ −1.749, where ulp_f32 ≈ 2.4e-7 is WIDER than the whole
// window), f32 cannot distinguish ANY pixel — the LEFT half (plain f32, the
// center explicitly narrowed with toF32) collapses flat, while the RIGHT half
// iterates the SAME formula on the f64 type and shows the filament structure.
// The center is a vec2<f64> uniform (the emulated-double VECTOR type — one
// DF64Vec2 hi/lo-plane slot), and the per-pixel offset is added in extended
// precision.
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
  f64,
  pow,
  cos,
  log2,
  max,
  mix,
  step,
  toF32,
  toF64,
  toU32,
  f32T,
  f64T,
  u32T,
  vec2fT,
  vec4fT,
  vec2f64T,
  If,
  Loop,
  Var,
  Let,
  u32,
  ioStruct,
  builtin,
  location,
  uniformStruct,
} from '../src/index.ts'
import type { ShaderExample } from './_shared.ts'

// A filament point on the needle spike — a period-3 minibrot neighbourhood
// that stays mid-frame at every zoom (centered on the real axis, y = 0). At
// shallow zoom the escape times sit under ~96 iterations, but zooming toward
// the df64 floor grows them, so the iteration budget is a live uniform
// (`max_iter`, wired to the slider) instead of a baked constant — crank it
// past 96 to keep the deep filament structure resolved.
const CENTER_X = -1.7490368500591793
const CENTER_Y = 0
const DEFAULT_ITER = 256

const U = uniformStruct(
  'Uniforms',
  { group: 0, binding: 0, as: 'u' },
  {
    center: vec2f64T, // one DF64Vec2 slot — host packs [hi.x, hi.y, lo.x, lo.y]
    resolution: vec2fT,
    zoom_exp: f32T, // view span = 10^-zoom_exp complex units
    fp64: f32T, // toggle: 1 = split-screen f32 | f64 (canonical), 0 = all-f32
    max_iter: f32T, // dynamic escape-time budget; loop bound = toU32(max_iter)
  },
)

// ── Escape-time iterate — the f32 and f64 twins ────────────────────────────
// Both run the IDENTICAL z ← z² + c recurrence; the ONLY difference is the
// working precision (double or not — that IS the demo), so the fragment
// shader's split is a clean f32-fn vs f64-fn if/else instead of two inline
// loops. `iters` is the dynamic budget (from `max_iter`); the loop bound is no
// longer baked. Each returns vec2(it, |z|²@escape) so the smooth colouring
// reads both twins through one path.
//
// The DSL types its arithmetic per CONCRETE scalar (`ArithArg<K>` is a
// conditional type that doesn't reduce over an unresolved type param), so the
// shared body can't collapse into one generic fn — the twins are spelled out
// and kept line-for-line in sync, differing only in the scalar type, the zero
// literal, and the final f32 narrow.
const escapeF32 = fn(
  'escape_f32',
  { cx: f32T, cy: f32T, iters: u32T },
  vec2fT,
  ({ cx, cy, iters }) => {
    const zx = Var(f32(0))
    const zy = Var(f32(0))
    const it = Var(f32(0))
    Loop(
      u32(0),
      (j) => j.lt(iters),
      () => {
        If(zx.mul(zx).add(zy.mul(zy)).le(16.0), () => {
          const nzx = Let(zx.mul(zx).sub(zy.mul(zy)).add(cx))
          zy.assign(zx.mul(zy).mul(2.0).add(cy))
          zx.assign(nzx)
          it.assign(it.add(1.0))
        })
      },
    )
    // |z|² is already f32 — no narrow needed.
    return vec2(it, zx.mul(zx).add(zy.mul(zy)))
  },
)
const escapeF64 = fn(
  'escape_f64',
  { cx: f64T, cy: f64T, iters: u32T },
  vec2fT,
  ({ cx, cy, iters }) => {
    const zx = Var(f64(0))
    const zy = Var(f64(0))
    const it = Var(f32(0))
    Loop(
      u32(0),
      (j) => j.lt(iters),
      () => {
        If(zx.mul(zx).add(zy.mul(zy)).le(16.0), () => {
          const nzx = Let(zx.mul(zx).sub(zy.mul(zy)).add(cx))
          zy.assign(zx.mul(zy).mul(2.0).add(cy))
          zx.assign(nzx)
          it.assign(it.add(1.0))
        })
      },
    )
    // Narrow the f64 |z|² to f32 for the shared colouring.
    return vec2(it, toF32(zx.mul(zx).add(zy.mul(zy))))
  },
)

const VsOut = ioStruct('VsOut', {
  pos: builtin('position', vec4fT),
  uv: location(0, vec2fT),
})

const vsFull = fn(
  'vs_full',
  { idx: builtin('vertex_index', u32T) },
  (p) => {
    const pos = vec2(-1, -1)
    If(p.idx.eq(1), () => {
      pos.assign(vec2(3, -1))
    }).elif(p.idx.eq(2), () => {
      pos.assign(vec2(-1, 3))
    })
    return VsOut.construct({
      pos: vec4(pos, 0, 1),
      uv: vec2(pos.x.add(1).mul(0.5), pos.y.add(1).mul(0.5)),
    })
  },
  { stage: 'vertex' },
)

const fsMandel = fn(
  'fs_mandel',
  { vo: VsOut },
  (p) => {
    const span = Let(pow(f32(10.0), U.field.zoom_exp.neg()))
    // Each half maps its own 0..1 sub-range onto the SAME complex window.
    // Panning lives on the HOST (the pan2d control drags `center` itself, in
    // full double precision) — the shader only ever sees per-pixel offsets,
    // which f32 carries fine at ~span magnitude; the extended-precision add
    // against `center` below is where f64 wins.
    const half = Let(p.vo.uv.x.mul(2.0))
    const sx = Let(half.sub(p.vo.uv.x.lt(0.5).select(0.0, 1.0)))
    const dx = Let(sx.sub(0.5).mul(span))
    const dy = Let(
      p.vo.uv.y.sub(0.5).mul(span).mul(U.field.resolution.y.div(U.field.resolution.x).mul(2.0)),
    )

    // The live iteration budget, truncated once to the u32 loop bound both
    // twins share (the slider hands us an f32).
    const iters = Let(toU32(U.field.max_iter))
    const esc = Var(vec2(0, 0)) // (it, |z|²@escape) — filled by whichever twin runs
    // fp64 toggle off → BOTH halves take the f32 branch: the right half
    // collapses flat in place, making the emulation's contribution tangible.
    If(p.vo.uv.x.lt(0.5).or(U.field.fp64.lt(0.5)), () => {
      // f32 twin — the center narrowed to f32: at deep zoom cx/cy quantize to
      // f32 ulps and whole pixel columns collapse.
      const cx = Let(toF32(U.field.center.x).add(dx))
      const cy = Let(toF32(U.field.center.y).add(dy))
      esc.assign(escapeF32({ cx, cy, iters }))
    }).else(() => {
      // f64 — the extended-precision add against the vec2<f64> center is where
      // the emulation earns its keep.
      const cx = Let(U.field.center.x.add(toF64(dx)))
      const cy = Let(U.field.center.y.add(toF64(dy)))
      esc.assign(escapeF64({ cx, cy, iters }))
    })
    const it = Let(esc.x)
    const m2 = Let(esc.y) // |z|² at escape (frozen once the guard fails)

    // Smooth escape-time colouring (log₂ log₂ |z|² kills the discrete bands —
    // same treatment as mandelbrot.ts) so zooming reads as a continuous dive
    // instead of strobing colour bands; a LOW-contrast cosine shimmer over the
    // smooth count keeps the iso-contour structure readable without the churn.
    // Interior (never escaped) stays black.
    const sn = Let(it.sub(log2(max(log2(max(m2, 1.0001)), 0.0001))).add(1.0))
    const inside = Let(step(U.field.max_iter.sub(0.5), it))
    const s = Let(sn.div(U.field.max_iter))
    const shade = Let(f32(0.82).add(cos(sn.mul(0.55)).mul(0.18)))
    const rgb = mix(vec3(0.03, 0.05, 0.12), vec3(1.0, 0.83, 0.36), s)
      .mul(shade)
      .mul(f32(1).sub(inside))
    return vec4(rgb, f32(1))
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

// `_fp64` guard lands at (group 0, binding 1) automatically.
const fp64MandelbrotModule = module({
  funcs: [escapeF32, escapeF64, vsFull, fsMandel],
  uses: [U, VsOut],
})

// DF64Vec2 std140 buffer order is PLANE-major: [hi.x, hi.y, lo.x, lo.y]
// (hi vec2 at offset 0, lo vec2 at offset 8) — NOT lane-major pairs. The
// pan2d host does this packing (via splitF64) every frame as drags move the
// double-precision camera.

export const fp64Mandelbrot: ShaderExample = {
  id: 'fp64-mandelbrot',
  title: 'fp64 Mandelbrot',
  blurb:
    'The classic double-float demo: a Mandelbrot needle-spike filament zoomed to a ~1e-7 span — narrower than one f32 ulp, so the plain-f32 left half collapses flat while the emulated-double f64 right half keeps the structure. Drag to pan and wheel to zoom, map-style — the camera accumulates in full double precision and lands in the vec2<f64> center uniform, so the f64 half stays sharp all the way to the df64 floor (~1e-13) while the f32 half died six orders of magnitude earlier. Raise the iterations slider past the old 96 to keep deep-zoom filaments resolved, or flip the fp64 toggle to collapse the right half in place.',
  category: 'generic',
  file: 'fp64-mandelbrot.ts',
  module: fp64MandelbrotModule,
  renderable: true,
  splitLabels: ['f32', 'f64 (emulated)'],
  controls: {
    // Drag pans the center in full double precision; a full-canvas-width drag
    // moves 2 × span (each half maps span across half the width).
    center: {
      kind: 'pan2d',
      value: [CENTER_X, CENTER_Y],
      zoomExpField: 'zoom_exp',
      unitsPerWidth: 2,
    },
    resolution: { kind: 'resolution' },
    // Wheel-zoomable, open past the f32 floor (~7.5) down to where even the
    // df64 emulation runs out of bits (~13) — the collapse IS the demo.
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
    // Escape-time budget — open well past the old baked 96 so deep-zoom
    // filaments stay resolved as the escape times grow toward the df64 floor.
    max_iter: {
      kind: 'slider',
      label: 'Iterations',
      min: 32,
      max: 1024,
      step: 16,
      value: DEFAULT_ITER,
    },
  },
}
