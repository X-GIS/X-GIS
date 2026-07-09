// ═══ @xgis/shader-dsl example — fp64 long-uptime clock ═══
//
// The "shader time" bug every long-running app ships eventually: animate with
// `fract(t)` when t has grown large and f32 time stops moving — at t ≈ 10⁸
// seconds (a bit over 3 years) ulp_f32 = 8 s, so every sub-8-second phase is
// GONE. Here the epoch base 10⁸+0.123 s lives as an f64 literal (split
// losslessly at build time), the live `time` uniform is added IN extended
// precision, and only the fract() phase — a sub-unit value — narrows to f32
// to drive the dial. The right clock sweeps smoothly; the plain-f32 left
// clock (base narrowed with toF32 before the add) is frozen solid. Flip the
// fp64 toggle and the right one freezes too.
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
  fract,
  abs,
  min,
  mix,
  length,
  atan2,
  smoothstep,
  exp,
  step,
  toF32,
  toF64,
  f32T,
  f64T,
  Let,
} from '../src/index.ts'
import { VsOut, vs, fullscreenUniforms, screenCoords } from './_fullscreen.ts'
import type { ShaderExample } from './_shared.ts'

const TAU = 6.283185307179586

const U = fullscreenUniforms({
  epoch: f64T, // mission-time base seconds (swept 10^4..10^9 via the DISTANCE slider)
  speed: f32T, // dial revolutions per second
  fp64: f32T, // toggle: 1 = split-screen f32 | f64 (canonical), 0 = all-f32
})

const fsClock = fn(
  'fs_clock',
  { vo: VsOut },
  (p) => {
    // Absolute mission time = epoch + live seconds; the ADD runs in df64 on
    // the right (exact) and in plain f32 on the left (the +time vanishes
    // under ulp(10⁸) = 8 s). Only the sub-unit phase ever narrows.
    const phase64 = Let(toF32(fract(U.field.epoch.add(toF64(U.field.time)).mul(U.field.speed))))
    // f32 twin: the epoch narrowed to a plain f32 — once its ulp grows past a
    // second, `time` is absorbed and the dial only lurches when the sum crosses an ulp.
    const phase32 = Let(fract(toF32(U.field.epoch).add(U.field.time).mul(U.field.speed)))

    const isF32 = Let(p.vo.uv.x.lt(0.5).or(U.field.fp64.lt(0.5)))
    const phase = Let(isF32.select(phase32, phase64))

    // Each half gets its own dial: remap the half's uv to centred isotropic
    // coords (y ±1 over the height, x ±half-aspect over the half's width).
    const halfUv = Let(p.vo.uv.x.mul(2.0))
    const sx = Let(halfUv.sub(p.vo.uv.x.lt(0.5).select(0.0, 1.0)))
    const c = Let(
      screenCoords(vec2(sx, p.vo.uv.y), vec2(U.field.resolution.x.mul(0.5), U.field.resolution.y)),
    )
    const r = Let(length(c))
    // Angle as a 0..1 turn, 12-o'clock = 0, clockwise — matches the phase.
    const a01 = Let(fract(f32(0.25).sub(atan2(c.y, c.x).div(TAU))))

    // Dial face: outer bezel ring, 12 tick marks, sweep hand + decay trail.
    const px = Let(f32(2).div(U.field.resolution.y)) // isotropic px size
    const bezel = Let(f32(1).sub(smoothstep(px.mul(1.5), px.mul(3.0), abs(r.sub(0.82)).sub(0.012))))
    const tickA = Let(
      abs(fract(a01.mul(12.0)).sub(0.5))
        .neg()
        .add(0.5),
    ) // 0 at each tick
    const tick = Let(
      f32(1)
        .sub(smoothstep(f32(0.0), f32(0.035), tickA))
        .mul(smoothstep(f32(0.62), f32(0.66), r))
        .mul(f32(1).sub(smoothstep(f32(0.78), f32(0.8), r))),
    )
    // Angular distance BEHIND the hand (0 at the hand, growing clockwise-past).
    const behind = Let(fract(phase.sub(a01).add(1.0)))
    const hand = Let(
      f32(1)
        .sub(smoothstep(f32(0.0), f32(0.006), min(behind, f32(1).sub(behind))))
        .mul(step(r, f32(0.6)))
        .mul(smoothstep(f32(0.05), f32(0.1), r)),
    )
    const trail = Let(
      exp(behind.mul(-5.0))
        .mul(0.35)
        .mul(step(r, f32(0.58))),
    )
    const hub = Let(f32(1).sub(smoothstep(px.mul(2.0), px.mul(5.0), r)))

    const face = Let(mix(vec3(0.03, 0.045, 0.08), vec3(0.05, 0.075, 0.12), r))
    const rgb = face
      .add(vec3(0.85, 0.9, 1.0).mul(bezel.mul(0.35)))
      .add(vec3(0.8, 0.85, 0.95).mul(tick.mul(0.5)))
      .add(vec3(1.0, 0.72, 0.2).mul(hand))
      .add(vec3(1.0, 0.6, 0.15).mul(trail))
      .add(vec3(1.0, 0.85, 0.5).mul(hub))
    return vec4(rgb, f32(1))
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

// `_fp64` guard lands at (group 0, binding 1) automatically.
const fp64ClockModule = module({
  funcs: [vs, fsClock],
  uses: [U, VsOut],
})

export const fp64Clock: ShaderExample = {
  id: 'fp64-clock',
  title: 'fp64 long-uptime clock',
  blurb:
    'The long-uptime animation bug: fract(t) where t is the epoch base plus live seconds. Drag the UPTIME slider — near 10⁴ s both dials sweep, but past ~10⁷·² one f32 ulp grows wider than a second, the +time vanishes into it, and the plain-f32 left dial freezes (it only lurches when the sum crosses an ulp) while the f64 right dial, adding the live time in extended precision, keeps sweeping to 10⁹ s (30+ years). Speed is live; flip the fp64 toggle to freeze the right dial too.',
  category: 'generic',
  file: 'fp64-clock.ts',
  module: fp64ClockModule,
  renderable: true,
  splitLabels: ['f32', 'f64 (emulated)'],
  controls: {
    time: { kind: 'time' },
    // Sweep the mission-time epoch through the f32 threshold (seconds → the dial
    // freezes past ~10^7·² where one ulp exceeds a second).
    epoch: { kind: 'logmag1d', magField: 'mag', base: 1, offset: 0.123 },
    mag: {
      kind: 'slider',
      label: 'Uptime 10^x seconds',
      min: 4,
      max: 9,
      step: 0.02,
      value: 6,
      wheel: true,
    },
    resolution: { kind: 'resolution' },
    speed: { kind: 'slider', label: 'Rev / s', min: 0.05, max: 1, step: 0.05, value: 0.25 },
    fp64: { kind: 'toggle', label: 'fp64 emulation', value: true },
  },
}
