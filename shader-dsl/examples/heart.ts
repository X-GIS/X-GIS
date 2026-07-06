// ═══ @xgis/shader-dsl example — beating heart (implicit curve) ═══
//
// The sextic heart curve (x² + y² − 1)³ − x²y³ = 0, filled where the implicit
// function goes negative, anti-aliased with `fwidth` on the field itself, and
// scaled by a sharpened-sine heartbeat. A different shading recipe from the
// SDF examples: implicit-function sign fill + field-driven inner gradient +
// exponential outer glow synced to the beat. WGSL (WebGPU) + GLSL ES 3.00.

import {
  fn,
  module,
  uniformStruct,
  ioStruct,
  u32,
  f32,
  toF32,
  vec2,
  vec3,
  vec4,
  sin,
  abs,
  pow,
  max,
  mix,
  exp,
  clamp,
  smoothstep,
  fwidth,
  location,
  builtin,
  Let,
  f32T,
  vec2fT,
  vec4fT,
  u32T,
} from '../src/index.ts'
import type { ShaderExample } from './_shared.ts'

const U = uniformStruct(
  'Uniforms',
  { group: 0, binding: 0, as: 'U' },
  { time: f32T, resolution: vec2fT, beat: f32T },
)

const VsOut = ioStruct('VsOut', { pos: builtin('position', vec4fT), uv: location(0, vec2fT) })

const vs = fn(
  'vs',
  { vi: builtin('vertex_index', u32T) },
  ({ vi }) => {
    const x = toF32(vi.bitAnd(u32(1)))
      .mul(4)
      .sub(1)
    const y = toF32(vi.shr(u32(1)))
      .mul(4)
      .sub(1)
    return VsOut.construct({
      pos: vec4(x, y, 0, 1),
      uv: vec2(x.mul(0.5).add(0.5), y.mul(0.5).add(0.5)),
    })
  },
  { stage: 'vertex' },
)

const fs = fn(
  'fs',
  { vo: VsOut },
  ({ vo }) => {
    const t = U.field.time
    const res = U.field.resolution
    const asp = res.x.div(res.y)
    const p = vec2(vo.uv.x.mul(2).sub(1).mul(asp), vo.uv.y.mul(2).sub(1))
    // heartbeat: |sin|⁸ sharpens the sine into a thump per half-period
    const beat = Let(pow(abs(sin(t.mul(3.14159).mul(U.field.beat))), 8).mul(0.12))
    const s = Let(f32(0.72).add(beat))
    const qx = Let(p.x.mul(1.3).div(s))
    const qy = Let(p.y.add(0.08).mul(1.3).div(s))
    // the sextic heart: (x² + y² − 1)³ − x²·y³
    const xx = Let(qx.mul(qx))
    const k = Let(xx.add(qy.mul(qy)).sub(1))
    const f = Let(k.mul(k).mul(k).sub(xx.mul(qy).mul(qy).mul(qy)))
    // fill where f < 0, anti-aliased on the field's own screen gradient
    const aa = Let(fwidth(f).mul(1.6))
    const fill = f32(1).sub(smoothstep(aa.neg(), aa, f))
    // inside: brighter toward the centre (f is most negative there)
    const heart = mix(vec3(0.55, 0.03, 0.1), vec3(0.95, 0.15, 0.25), clamp(f.neg(), 0, 1))
    // outside: a soft glow that swells with the beat
    const glow = exp(max(f, 0).mul(2.2).neg()).mul(beat.mul(3).add(0.35))
    const bg = vec3(0.05, 0.04, 0.07).mul(f32(1).sub(vo.uv.y.mul(0.35)))
    const col = mix(bg.add(vec3(0.7, 0.08, 0.16).mul(glow)), heart, fill)
    return vec4(col, 1)
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

const heartModule = module({
  structs: [U.struct, VsOut.decl],
  bindings: [U.binding],
  funcs: [vs, fs],
})

export const heart: ShaderExample = {
  id: 'heart',
  title: 'Beating heart',
  blurb:
    'The sextic heart curve (x²+y²−1)³ = x²y³, sign-filled and fwidth-anti-aliased, thumping to a sharpened-sine heartbeat with a beat-synced glow. Beat rate is live.',
  category: 'generic',
  file: 'heart.ts',
  module: heartModule,
  renderable: true,
  controls: {
    time: { kind: 'time' },
    resolution: { kind: 'resolution' },
    beat: { kind: 'slider', label: 'Beat rate', min: 0.2, max: 2, step: 0.1, value: 1 },
  },
}
