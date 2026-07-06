// ═══ @xgis/shader-dsl example — truchet tiles (hash-flipped arc maze) ═══
//
// The truchet construction: tile the plane with ONE tile — two quarter-circle
// arcs joining edge midpoints — and let a per-cell hash mirror half the tiles.
// The arcs connect across every cell boundary by construction, so a single bit
// per cell yields an endless woven maze. Anti-aliased with `fwidth`
// (screen-constant line width), energy pulsing along the arcs by angle.
// WGSL (WebGPU) + GLSL ES 3.00 (WebGL2).

import {
  fn,
  module,
  f32,
  vec2,
  vec3,
  vec4,
  sin,
  cos,
  floor,
  fract,
  dot,
  mix,
  min,
  abs,
  step,
  length,
  atan2,
  smoothstep,
  fwidth,
  Let,
  f32T,
  vec2fT,
} from '../src/index.ts'
import { VsOut, vs, fullscreenUniforms } from './_fullscreen.ts'
import type { ShaderExample } from './_shared.ts'
const U = fullscreenUniforms({ tiles: f32T })

// scalar hash of a lattice point → [0,1)
const hash = fn('hash', { p: vec2fT }, ({ p }) =>
  fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)),
)

const palette = fn('palette', { t: f32T }, ({ t }) => {
  const ph = vec3(0.0, 0.33, 0.67)
  return vec3(0.5).add(cos(t.add(ph).mul(6.283)).mul(0.5))
})

const fs = fn(
  'fs',
  { vo: VsOut },
  ({ vo }) => {
    const t = U.field.time
    const res = U.field.resolution
    const asp = res.x.div(res.y)
    const q = vec2(vo.uv.x.mul(asp), vo.uv.y).mul(U.field.tiles)
    const cell = Let(floor(q))
    const f = Let(fract(q))
    const h = Let(hash({ p: cell }))
    // one hash bit mirrors the tile — arcs still meet across every edge
    const fx = mix(f.x, f32(1).sub(f.x), step(0.5, h))
    const g = Let(vec2(fx, f.y))
    // distance to the two quarter-circle arcs (radius ½, centred on
    // opposite tile corners)
    const d1 = abs(length(g).sub(0.5))
    const d2 = abs(length(g.sub(vec2(1, 1))).sub(0.5))
    const d = Let(min(d1, d2))
    // screen-constant stroke via fwidth
    const aa = Let(fwidth(d).mul(1.4))
    const mask = f32(1).sub(smoothstep(f32(0.13).sub(aa), f32(0.13).add(aa), d))
    // energy flowing along the arc: parametrise by angle around whichever
    // corner owns the nearer arc
    const a1 = atan2(g.y, g.x)
    const a2 = atan2(g.y.sub(1), g.x.sub(1))
    const an = mix(a2, a1, step(d1, d2))
    const flow = sin(an.mul(6).add(t.mul(2.5)))
      .mul(0.35)
      .add(0.65)
    // per-cell hue drifting slowly
    const col = palette({
      t: hash({ p: cell.add(vec2(7.7, 3.1)) })
        .mul(0.4)
        .add(t.mul(0.05)),
    })
    const bg = vec3(0.04, 0.05, 0.09)
    return vec4(mix(bg, col.mul(flow), mask), 1)
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

const truchetModule = module({
  structs: [U.struct, VsOut.decl],
  bindings: [U.binding],
  funcs: [vs, fs],
})

export const truchet: ShaderExample = {
  id: 'truchet',
  title: 'Truchet tiles',
  blurb:
    'One tile — two quarter-circle arcs — mirrored per cell by a hash bit, and the plane weaves itself into an endless maze. fwidth keeps the strokes screen-constant; energy pulses along the arcs. Tile count is live.',
  category: 'generic',
  file: 'truchet.ts',
  module: truchetModule,
  renderable: true,
  controls: {
    time: { kind: 'time' },
    resolution: { kind: 'resolution' },
    tiles: { kind: 'slider', label: 'Tiles', min: 4, max: 18, step: 1, value: 9 },
  },
}
