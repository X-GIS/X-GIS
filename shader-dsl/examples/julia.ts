// ═══ @xgis/shader-dsl example — animated Julia set (escape-time fractal) ═══
//
// Iterate z ← z² + c per pixel until |z| escapes, then colour by the (smoothed)
// iteration count through a cosine palette. `c` orbits slowly so the fractal morphs.
// Showcases the DSL's `Loop` + early `Break` + a mutable `var` accumulator, typed
// ioStruct fn-params, and scalar×vector broadcast (the palette), all emitted to
// both WGSL (WebGPU) and GLSL ES 3.00 (WebGL2).

import {
  fn, module, uniformStruct, ioStruct,
  u32, f32, toF32, vec2, vec3, vec4,
  sin, cos, dot, location, builtin, Loop, If, Break, Var,
  f32T, vec2fT, vec4fT, u32T,
} from '../src/index.ts'
import type { ShaderExample } from './_shared.ts'

const U = uniformStruct('Uniforms', { group: 0, binding: 0, as: 'U' }, { time: f32T, resolution: vec2fT, zoom: f32T })

const VsOut = ioStruct('VsOut', { pos: builtin('position', vec4fT), uv: location(0, vec2fT) })

const vs = fn('vs', { vi: builtin('vertex_index', u32T) }, ({ vi }) => {
  const x = toF32(vi.bitAnd(u32(1))).mul(4).sub(1)
  const y = toF32(vi.shr(u32(1))).mul(4).sub(1)
  return VsOut.construct({ pos: vec4(x, y, 0, 1), uv: vec2(x.mul(0.5).add(0.5), y.mul(0.5).add(0.5)) })
}, { stage: 'vertex' })

// Iridescent cosine palette: 0.5 + 0.5·cos(2π(t + phase)).
const palette = fn('palette', { t: f32T }, ({ t }) => {
  const ph = vec3(0.0, 0.33, 0.67)
  // scalar t broadcasts over the phase vector; cos() is component-wise.
  return vec3(0.5).add(cos(t.add(ph).mul(6.283)).mul(0.5))
})

const fs = fn('fs', { vo: VsOut }, ({ vo }) => {
  const uv = vo.uv
  // centre the plane, scale by the zoom uniform
  const z = Var(vec2(uv.x.mul(2).sub(1), uv.y.mul(2).sub(1)).mul(U.field.zoom))
  // the orbiting Julia constant
  const c = vec2(cos(U.field.time.mul(0.31)).mul(0.39).sub(0.4), sin(U.field.time.mul(0.41)).mul(0.39))
  const it = Var(f32(0))
  Loop(u32(0), (i) => i.lt(u32(96)), (i) => {
    If(dot(z, z).gt(4), () => { Break() }) // escaped
    z.assign(vec2(z.x.mul(z.x).sub(z.y.mul(z.y)).add(c.x), z.x.mul(z.y).mul(2).add(c.y)))
    it.assign(it.add(1))
  })
  // outside points (never escaped) → black core; escaped → palette by iteration
  const col = palette({ t: it.div(96).add(U.field.time.mul(0.05)) })
  return vec4(col.mul(it.div(96)), 1)
}, { stage: 'fragment', retAttr: '@location(0)' })

// `palette` is called via its handle in `fs`, so module() collects it transitively — funcs lists only the entry points.
const juliaModule = module({ structs: [U.struct, VsOut.decl], bindings: [U.binding], funcs: [vs, fs] })

export const julia: ShaderExample = {
  id: 'julia',
  title: 'Julia set',
  blurb: 'Escape-time Julia fractal — z ← z² + c iterated per pixel, coloured by iteration count through a cosine palette. The constant c orbits over time so the set morphs. Built on Loop + Break.',
  category: 'generic',
  file: 'julia.ts',
  module: juliaModule,
  renderable: true,
  controls: {
    time: { kind: 'time' },
    resolution: { kind: 'resolution' },
    zoom: { kind: 'slider', label: 'Zoom', min: 0.4, max: 2.0, step: 0.05, value: 1.4 },
  },
}
