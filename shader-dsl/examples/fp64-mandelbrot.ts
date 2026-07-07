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
  sqrt,
  fract,
  mix,
  toF32,
  toF64,
  f32T,
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

// A filament point on the needle spike — escape times stay under ~96
// iterations at deep zoom (a period-3 minibrot neighbourhood), so the
// structure is visible without an expensive iteration budget.
const CENTER_X = -1.7490368500591792
const CENTER_Y = 0.0000000281
const ITER = 96

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

    const it = Var(f32(0))
    // fp64 toggle off → BOTH halves take the f32 branch: the right half
    // collapses flat in place, making the emulation's contribution tangible.
    If(p.vo.uv.x.lt(0.5).or(U.field.fp64.lt(0.5)), () => {
      // f32 twin — the SAME iteration with the center narrowed: at deep zoom
      // cx/cy quantize to f32 ulps and whole pixel columns collapse.
      const cx = Let(toF32(U.field.center.x).add(dx))
      const cy = Let(toF32(U.field.center.y).add(dy))
      const zx = Var(f32(0))
      const zy = Var(f32(0))
      Loop(
        u32(0),
        (j) => j.lt(u32(ITER)),
        () => {
          If(zx.mul(zx).add(zy.mul(zy)).le(4.0), () => {
            const nzx = Let(zx.mul(zx).sub(zy.mul(zy)).add(cx))
            zy.assign(zx.mul(zy).mul(2.0).add(cy))
            zx.assign(nzx)
            it.assign(it.add(1.0))
          })
        },
      )
    }).else(() => {
      // f64 — identical authoring, only the value types differ.
      const cx = Let(U.field.center.x.add(toF64(dx)))
      const cy = Let(U.field.center.y.add(toF64(dy)))
      const zx = Var(f64(0))
      const zy = Var(f64(0))
      Loop(
        u32(0),
        (j) => j.lt(u32(ITER)),
        () => {
          If(zx.mul(zx).add(zy.mul(zy)).le(4.0), () => {
            const nzx = Let(zx.mul(zx).sub(zy.mul(zy)).add(cx))
            zy.assign(zx.mul(zy).mul(2.0).add(cy))
            zx.assign(nzx)
            it.assign(it.add(1.0))
          })
        },
      )
    })

    // Interior (never escaped) stays dark; banded escape time keeps local
    // contrast high across the narrow escape range of a deep-zoom window.
    const esc = Let(it.lt(ITER).select(it, f32(0)))
    const band = Let(fract(esc.mul(0.11)))
    const t = Let(sqrt(esc.div(ITER)).mul(0.35).add(band.mul(0.65)))
    const rgb = mix(vec3(0.02, 0.03, 0.1), vec3(1.0, 0.83, 0.36), t)
    return vec4(rgb, f32(1))
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

// `_fp64` guard lands at (group 0, binding 1) automatically.
const fp64MandelbrotModule = module({
  funcs: [vsFull, fsMandel],
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
    'The classic double-float demo: a Mandelbrot needle-spike filament zoomed to a ~1e-7 span — narrower than one f32 ulp, so the plain-f32 left half collapses flat while the emulated-double f64 right half keeps the structure. Drag to pan and wheel to zoom, map-style — the camera accumulates in full double precision and lands in the vec2<f64> center uniform, so the f64 half stays sharp all the way to the df64 floor (~1e-13) while the f32 half died six orders of magnitude earlier. Flip the fp64 toggle to collapse the right half in place.',
  category: 'generic',
  file: 'fp64-mandelbrot.ts',
  module: fp64MandelbrotModule,
  renderable: true,
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
    zoom_exp: { kind: 'slider', label: 'Zoom 10^-x', min: 1, max: 14, step: 0.05, value: 7, wheel: true },
    fp64: { kind: 'toggle', label: 'fp64 emulation', value: true },
  },
}
