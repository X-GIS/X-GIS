// ═══ @xgis/shader-dsl example — choropleth colour ramp ═══
//
// A cartographic shader: the data-driven colour ramp a thematic map uses to paint a value
// field. A reusable `ramp()` DSL function maps a normalised value [0,1] through a 5-stop
// sequential palette; the fragment samples an animated value field, colours it, and overlays
// anti-aliased contour isolines whose count is a live uniform.

import {
  fn,
  module,
  uniformStruct,
  ioStruct,
  u32,
  toF32,
  vec2,
  vec3,
  vec4,
  sin,
  fract,
  smoothstep,
  min,
  clamp,
  fwidth,
  mix,
  f32,
  location,
  builtin,
  f32T,
  vec2fT,
  vec4fT,
  u32T,
} from '../src/index.ts'
import type { ShaderExample } from './_shared.ts'

const U = uniformStruct(
  'Uniforms',
  { group: 0, binding: 0, as: 'U' },
  {
    time: f32T,
    resolution: vec2fT,
    bands: f32T,
  },
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

// 5-stop sequential ramp (light yellow → deep red), a classic choropleth legend.
const ramp = fn('ramp', { x: f32T }, ({ x }) => {
  const c0 = vec3(0.99, 0.95, 0.74)
  const c1 = vec3(0.99, 0.8, 0.45)
  const c2 = vec3(0.96, 0.5, 0.24)
  const c3 = vec3(0.84, 0.19, 0.15)
  const c4 = vec3(0.5, 0.0, 0.05)
  const a = mix(c0, c1, smoothstep(0, 0.25, x))
  const b = mix(a, c2, smoothstep(0.25, 0.5, x))
  const d = mix(b, c3, smoothstep(0.5, 0.75, x))
  return mix(d, c4, smoothstep(0.75, 1, x))
})

const fs = fn(
  'fs',
  { vo: VsOut },
  ({ vo }) => {
    const uv = vo.uv
    const t = U.field.time
    const bands = U.field.bands

    // Animated data field in [0,1].
    const val = clamp(
      sin(uv.x.mul(6.2832).add(t.mul(0.5)))
        .mul(0.3)
        .add(0.5)
        .add(sin(uv.y.mul(6.2832).sub(t.mul(0.35))).mul(0.2)),
      0,
      1,
    )

    const col = ramp({ x: val })

    // Contour isolines at evenly spaced value levels, screen-constant width via fwidth.
    const e = fract(val.mul(bands))
    const dd = min(e, f32(1).sub(e))
    const lineMask = f32(1).sub(smoothstep(0, fwidth(val.mul(bands)).mul(1.2), dd))
    const enabled = smoothstep(0.5, 1.5, bands) // disables the overlay when bands ≈ 0
    const contour = clamp(lineMask.mul(enabled), 0, 1)

    return vec4(mix(col, col.mul(0.2), contour), 1)
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

// `ramp` is called via its handle in `fs`, so module() collects it transitively — funcs lists only the entry points.
const colorRampModule = module({
  structs: [U.struct, VsOut.decl],
  bindings: [U.binding],
  funcs: [vs, fs],
})

export const colorRamp: ShaderExample = {
  id: 'color-ramp',
  title: 'Colour ramp',
  blurb:
    'The data-driven choropleth ramp: a reusable ramp() function maps a value field through a 5-stop palette, with anti-aliased contour isolines. Set how many bands to draw.',
  category: 'cartographic',
  file: 'color-ramp.ts',
  module: colorRampModule,
  renderable: true,
  controls: {
    time: { kind: 'time' },
    resolution: { kind: 'resolution' },
    bands: { kind: 'slider', label: 'Contour bands', min: 0, max: 12, step: 1, value: 6 },
  },
}
