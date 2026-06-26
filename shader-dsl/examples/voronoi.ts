// ═══ @xgis/shader-dsl example — animated Voronoi (cellular noise) ═══
//
// The classic ShaderToy cellular pattern: tile the plane into cells, scatter one
// animated feature point per cell, and shade each fragment by the DISTANCE to its
// nearest point (a 3×3 neighbour scan). Showcases the `distance` builtin + the DSL's
// nested `Loop`. One source → WGSL (WebGPU) + GLSL ES 3.00 (WebGL2) + Reflection.

import {
  fn, module, uniformStruct, ioStruct,
  u32, i32, f32, toF32, vec2, vec3, vec4,
  sin, cos, floor, fract, dot, min, distance, location, builtin, Loop, Let,
  f32T, vec2fT, vec3fT, vec4fT, u32T,
} from '../src/index.ts'
import type { ShaderExample } from './_shared.ts'

const U = uniformStruct('Uniforms', { group: 0, binding: 0, as: 'U' }, { time: f32T, resolution: vec2fT, cells: f32T })

const VsOut = ioStruct('VsOut', { pos: builtin('position', vec4fT), uv: location(0, vec2fT) })

// Fullscreen triangle — position from the vertex index, uv in [0,1].
const vs = fn('vs', { vi: builtin('vertex_index', u32T) }, ({ vi }) => {
  const x = toF32(vi.bitAnd(u32(1))).mul(4).sub(1)
  const y = toF32(vi.shr(u32(1))).mul(4).sub(1)
  return VsOut.construct({ pos: vec4(x, y, 0, 1), uv: vec2(x.mul(0.5).add(0.5), y.mul(0.5).add(0.5)) })
}, { stage: 'vertex' })

// Hash a cell coordinate → a stable point in [0,1]² (the per-cell feature seed).
const hash2 = fn('hash2', { c: vec2fT }, ({ c }) => {
  const h = vec2(dot(c, vec2(127.1, 311.7)), dot(c, vec2(269.5, 183.3)))
  return fract(vec2(sin(h.x), sin(h.y)).mul(43758.5453))
})

const fs = fn('fs', { vo: VsOut.type }, ({ vo }) => {
  const uv = VsOut.of(vo).uv
  const p = uv.mul(U.field.cells)
  const cell = floor(p)
  const f = fract(p)
  const md = f32(8) // nearest-point distance accumulator
  // 3×3 neighbour scan — the nearest feature point may live in an adjacent cell.
  Loop(i32(-1), (j) => j.le(1), (j) => {
    Loop(i32(-1), (i) => i.le(1), (i) => {
      const g = Let(vec2(toF32(i), toF32(j)))
      const seed = Let(hash2(cell.add(g))) // materialise once: the loop counters are mutated `var`s, so CSE can't hoist the hash — without Let the 3 `seed.*` reads re-call hash2() per iteration
      // animate each point on a small orbit around its cell so the pattern shimmers
      const pt = g.add(seed.mul(0.5).add(0.25))
        .add(vec2(sin(U.field.time.add(seed.x.mul(6.283))), cos(U.field.time.add(seed.y.mul(6.283)))).mul(0.18))
      md.assign(min(md, distance(f, pt)))
    })
  })
  // tint the distance field: dark cores, cool cell walls
  const c = vec3(md.mul(md)).mul(vec3(0.35, 0.6, 1.0)).add(vec3(0.02, 0.03, 0.06))
  return vec4(c, 1)
}, { stage: 'fragment', retAttr: '@location(0)' })

const voronoiModule = module({ structs: [U.struct, VsOut.decl], bindings: [U.binding], funcs: [hash2, vs, fs] })

export const voronoi: ShaderExample = {
  id: 'voronoi',
  title: 'Voronoi',
  blurb: 'Animated cellular noise — each fragment shaded by the distance to its nearest of a grid of orbiting feature points (a 3×3 neighbour scan). Built on the `distance` builtin + nested loops.',
  category: 'generic',
  file: 'voronoi.ts',
  module: voronoiModule,
  renderable: true,
  controls: {
    time: { kind: 'time' },
    resolution: { kind: 'resolution' },
    cells: { kind: 'slider', label: 'Cell density', min: 2, max: 16, step: 1, value: 6 },
  },
}
