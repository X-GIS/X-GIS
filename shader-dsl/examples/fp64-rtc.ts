// ═══ @xgis/shader-dsl example — fp64 relative-to-center rendering ═══
//
// THE technique every planet-scale engine ships (RTC / relative-to-eye,
// Cesium & co.): a survey marker sits at world (10⁸+3.7, 5×10⁷+2.3), and the
// only value the shader ever needs is delta = marker − eye — a SMALL number
// that f32 carries perfectly, PROVIDED the subtraction happens in extended
// precision FIRST. The f64 right half subtracts in df64 and narrows the
// result: a crisp reticle. The f32 left half narrows first and subtracts
// after — both operands quantize to ulp(10⁸) = 8 world units, the delta
// comes out in 8-unit steps, and the reticle snaps to a coarse grid, sits
// visibly OFF the true position, and squares off (drag to feel it jump).
// This is the same subtract-then-narrow discipline as the map package's
// extended-precision tile origins — demoted to a single reticle.
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
  fract,
  abs,
  min,
  max,
  mix,
  length,
  smoothstep,
  exp,
  toF32,
  toF64,
  f32T,
  vec2fT,
  vec2f64T,
  Let,
  uniformStruct,
} from '../src/index.ts'
import { VsOut, vs } from './_fullscreen.ts'
import type { ShaderExample } from './_shared.ts'

// The marker's world position — the fractional offsets (3.7, 2.3) are exactly
// what f32 cannot see at this magnitude (ulp = 8).
const MARK_X = 1e8 + 3.7
const MARK_Y = 5e7 + 2.3
// Default camera: on round numbers so ALL error on the left half comes from
// the narrowed marker + per-pixel world reconstruction.
const EYE_X = 1e8
const EYE_Y = 5e7

const U = uniformStruct(
  'Uniforms',
  { group: 0, binding: 0, as: 'u' },
  {
    center: vec2f64T, // camera/eye — one DF64Vec2 slot [hi.x, hi.y, lo.x, lo.y]
    resolution: vec2fT,
    zoom_exp: f32T, // view span = 10^-zoom_exp world units (negative = zoom out)
    fp64: f32T, // toggle: 1 = split-screen f32 | f64 (canonical), 0 = all-f32
  },
)

const fsRtc = fn(
  'fs_rtc',
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
    // f64 path — subtract FIRST (df64, exact by Sterbenz-style cancellation),
    // narrow the small result after. The pixel's world position is
    // eye + offset; delta = (eye + offset) − marker.
    const ex64 = Let(toF32(U.field.center.x.add(toF64(dx)).sub(f64(MARK_X))))
    const ey64 = Let(toF32(U.field.center.y.add(toF64(dy)).sub(f64(MARK_Y))))
    // f32 twin — narrow FIRST, subtract after: both operands live on the
    // 8-unit ulp grid of 10⁸, so the delta is quantized to 8-unit steps.
    const ex32 = Let(toF32(U.field.center.x).add(dx).sub(f32(MARK_X)))
    const ey32 = Let(toF32(U.field.center.y).add(dy).sub(f32(MARK_Y)))
    const ex = Let(isF32.select(ex32, ex64))
    const ey = Let(isF32.select(ey32, ey64))

    // Radar-style reticle in world units, everything scaled by the span so the
    // picture is zoom-invariant: rings every span/8, a crosshair, a hot dot.
    const rw = Let(span.mul(0.125)) // ring spacing
    const r = Let(length(vec2(ex, ey)))
    const pixw = Let(span.div(U.field.resolution.x.mul(0.5)))
    const tri = Let(
      abs(fract(r.div(rw)).sub(0.5))
        .neg()
        .add(0.5)
        .mul(rw),
    ) // dist to ring
    const ring = Let(f32(1).sub(smoothstep(f32(0), pixw.mul(1.6).add(1e-9), tri)))
    const cross = Let(
      f32(1).sub(smoothstep(f32(0), pixw.mul(1.4).add(1e-9), min(abs(ex), abs(ey)))),
    )
    const dotGlow = Let(exp(r.div(pixw.mul(6.0).add(1e-9)).neg()))
    const vignette = Let(max(f32(0), f32(1).sub(r.div(span.mul(0.75)))))

    const bg = Let(mix(vec3(0.01, 0.04, 0.02), vec3(0.02, 0.09, 0.045), vignette))
    const rgb = bg
      .add(vec3(0.1, 0.75, 0.3).mul(ring.mul(0.8)))
      .add(vec3(0.12, 0.9, 0.4).mul(cross.mul(0.55)))
      .add(vec3(1.0, 0.45, 0.25).mul(dotGlow))
    return vec4(rgb, f32(1))
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

// `_fp64` guard lands at (group 0, binding 1) automatically.
const fp64RtcModule = module({
  funcs: [vs, fsRtc],
  uses: [U, VsOut],
})

export const fp64Rtc: ShaderExample = {
  id: 'fp64-rtc',
  title: 'fp64 relative-to-center',
  blurb:
    'Why planet-scale engines render relative-to-eye: a reticle marks a survey point at world (10⁸+3.7, 5·10⁷+2.3). The f64 right half subtracts eye from marker in extended precision FIRST and narrows the small delta — crisp rings, dead centre. The f32 left half narrows first: both operands land on the 8-unit ulp grid of 10⁸, the delta quantizes, and the reticle sits off-target and snaps in 8-unit jumps as you drag. Wheel to zoom, flip the fp64 toggle to compare.',
  category: 'cartographic',
  file: 'fp64-rtc.ts',
  module: fp64RtcModule,
  renderable: true,
  splitLabels: ['f32', 'f64 (emulated)'],
  controls: {
    center: {
      kind: 'pan2d',
      value: [EYE_X, EYE_Y],
      zoomExpField: 'zoom_exp',
      unitsPerWidth: 2,
    },
    resolution: { kind: 'resolution' },
    // Span ~24 world units by default; df64 keeps sub-ulp deltas at 10⁸ down
    // to spans of ~1e-5 (exp ≈ 5), where the emulation floor appears.
    zoom_exp: {
      kind: 'slider',
      label: 'Zoom 10^-x',
      min: -2,
      max: 5,
      step: 0.05,
      value: -1.4,
      wheel: true,
    },
    fp64: { kind: 'toggle', label: 'fp64 emulation', value: true },
  },
}
