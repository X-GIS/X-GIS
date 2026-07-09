// ═══ @xgis/shader-dsl example — fp64 deep-zoom precision stripes ═══
//
// The emulated-double (f64) surface in one screen: a world coordinate near
// 1e8 (where f32's ulp is 8 — every sub-integer detail is gone) is swept
// across the screen and rendered as fract() stripes. The LEFT half computes in
// plain f32 (the origin explicitly narrowed with toF32) and collapses to a
// flat field; the RIGHT half runs the SAME formula on the f64 type and shows
// clean stripes. Note the authoring surface is identical — `.add/.mul/fract`
// — only the declared uniform type differs; fp64Lower rewrites the f64 side
// into df64_* calls against the injected emulation library.
//
// f64 lowering auto-injects the `_fp64` guard uniform (the anti-fast-math
// guard, see core/fp64/df64-lib.ts) — nothing to declare; the render
// harnesses bind 1.0f into it by probing the program for the Fp64Guard block
// (it is injected at LOWERING, so it is absent from the authored reflect()).
// The numeric real-GPU gate for fp64 is playground/e2e/_fp64-known-answer.spec.ts.

import {
  fn,
  module,
  vec2,
  vec4,
  fract,
  toF32,
  toF64,
  f32T,
  f64T,
  u32T,
  vec2fT,
  vec4fT,
  If,
  ioStruct,
  builtin,
  location,
  uniformStruct,
} from '../src/index.ts'
import type { ShaderExample } from './_shared.ts'

const U = uniformStruct(
  'Uniforms',
  { group: 0, binding: 0, as: 'u' },
  {
    origin: f64T, // occupies one vec2<f32> slot — host packs splitF64(ORIGIN)
    span: f32T, // world units swept across the screen
    fp64: f32T, // toggle: 1 = split-screen f32 | f64 (canonical), 0 = all-f32
  },
)

const VsOut = ioStruct('VsOut', {
  pos: builtin('position', vec4fT),
  uv: location(0, vec2fT),
})

// Oversized fullscreen triangle (same pattern as gradient-pass.ts).
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

const fsStripes = fn(
  'fs_stripes',
  { vo: VsOut },
  (p) => {
    const sweep = p.vo.uv.x.mul(U.field.span)
    // f64 path: the full-precision world coordinate keeps its fraction.
    const stripes64 = toF32(fract(U.field.origin.add(toF64(sweep))))
    // f32 twin — SAME formula, origin narrowed: the fraction is unrepresentable.
    const stripes32 = fract(toF32(U.field.origin).add(sweep))
    // fp64 toggle off → the WHOLE screen takes the f32 path: the right half
    // collapses flat in place, making the emulation's contribution tangible.
    const v = p.vo.uv.x.lt(0.5).or(U.field.fp64.lt(0.5)).select(stripes32, stripes64)
    return vec4(v, v, v, 1.0)
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

// The `_fp64` guard binding lands at (group 0, binding 1) automatically —
// first free slot past `u` at binding 0.
const fp64DeepZoomModule = module({
  funcs: [vsFull, fsStripes],
  uses: [U, VsOut],
})

export const fp64DeepZoom: ShaderExample = {
  id: 'fp64-deep-zoom',
  title: 'fp64 deep zoom',
  blurb:
    'Emulated double precision (two-f32 df64): a world coordinate rendered as fract() stripes. Drag the DISTANCE slider out from the origin — near 10⁶ both halves stripe cleanly, but past ~10⁷·² one f32 ulp swallows a whole stripe and the plain-f32 left half collapses flat, while the f64 right half keeps the stripes to 10⁹, identical authoring syntax. Flip the fp64 toggle off to watch the right half collapse too. The auto-injected _fp64 guard uniform must be set to 1.0.',
  category: 'cartographic',
  file: 'fp64-deep-zoom.ts',
  module: fp64DeepZoomModule,
  renderable: true,
  splitLabels: ['f32', 'f64 (emulated)'],
  controls: {
    // Sweep the coordinate's distance from the origin through the f32 threshold.
    origin: { kind: 'logmag1d', magField: 'mag', base: 1, offset: 0.3 },
    mag: {
      kind: 'slider',
      label: 'Distance from origin 10^x',
      min: 4,
      max: 9,
      step: 0.02,
      value: 6,
      wheel: true,
    },
    span: { kind: 'slider', label: 'World span', min: 1, max: 8, step: 0.5, value: 4 },
    fp64: { kind: 'toggle', label: 'fp64 emulation', value: true },
  },
}
