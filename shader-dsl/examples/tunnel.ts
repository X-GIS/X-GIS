// ═══ @xgis/shader-dsl example — the classic tunnel (polar remap) ═══
//
// The demoscene / ShaderToy staple: remap the screen into polar coordinates
// (angle around the bore, 1/radius into the depth) so a flat checker pattern
// reads as an endless tunnel flying past. Showcases `atan2` (the divergent
// WGSL/GLSL spelling the intrinsic registry unifies), `length`, and
// screen-space fog. One DSL source → WGSL (WebGPU) + GLSL ES 3.00 (WebGL2).

import {
  fn,
  module,
  f32,
  vec2,
  vec3,
  vec4,
  sin,
  atan2,
  length,
  max,
  mix,
  clamp,
  smoothstep,
  Let,
  f32T,
} from '../src/index.ts'
import { VsOut, vs, fullscreenUniforms } from './_fullscreen.ts'
import type { ShaderExample } from './_shared.ts'
const U = fullscreenUniforms({ twist: f32T })

const fs = fn(
  'fs',
  { vo: VsOut },
  ({ vo }) => {
    const t = U.field.time
    const res = U.field.resolution
    // centred, aspect-corrected plane
    const asp = res.x.div(res.y)
    const p = vec2(vo.uv.x.mul(2).sub(1).mul(asp), vo.uv.y.mul(2).sub(1))
    const r = Let(length(p))
    const a = atan2(p.y, p.x)
    // tunnel-surface coordinates: 1/r is the distance into the bore, the
    // angle wraps around it. Adding time to the depth flies the camera forward;
    // the twist uniform shears the angle by depth so the bore corkscrews.
    const depth = Let(f32(0.3).div(max(r, 0.001)).add(t.mul(1.4)))
    const ang = a.div(3.14159265).add(depth.mul(U.field.twist).mul(0.08))
    // checkerboard walls: two perpendicular square-ish waves
    const cw = sin(ang.mul(12.566)).mul(sin(depth.mul(9.4248)))
    const shade = smoothstep(-0.6, 0.6, cw).mul(0.55).add(0.35)
    // warm→cool tint cycling with depth, then fog toward the far centre
    const tint = mix(
      vec3(1.0, 0.62, 0.28),
      vec3(0.42, 0.3, 0.55),
      sin(depth.mul(0.9)).mul(0.5).add(0.5),
    )
    const fog = smoothstep(0.0, 0.55, r)
    const vig = clamp(f32(1.15).sub(r.mul(0.35)), 0, 1)
    return vec4(tint.mul(shade).mul(fog).mul(vig), 1)
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

const tunnelModule = module({
  structs: [U.struct, VsOut.decl],
  bindings: [U.binding],
  funcs: [vs, fs],
})

export const tunnel: ShaderExample = {
  id: 'tunnel',
  title: 'Tunnel',
  blurb:
    'The demoscene tunnel — the screen remapped to polar coordinates (angle around, 1/radius into the depth) so a checker pattern flies past forever. atan2 + length + fog, with a live twist control.',
  category: 'generic',
  file: 'tunnel.ts',
  module: tunnelModule,
  renderable: true,
  controls: {
    time: { kind: 'time' },
    resolution: { kind: 'resolution' },
    twist: { kind: 'slider', label: 'Twist', min: 0, max: 3, step: 0.1, value: 1 },
  },
}
