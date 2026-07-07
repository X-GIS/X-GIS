// ═══ @xgis/shader-dsl example — graticule (lon/lat grid) ═══
//
// A cartographic shader: the lon/lat graticule every map draws. The fragment maps screen
// UV → longitude/latitude, draws anti-aliased grid lines at a uniform `spacing` (degrees)
// with screen-constant width via `fwidth`, emphasises the equator in gold, and slowly
// pans longitude over `time` so the globe appears to spin. Same DSL → WGSL + WebGL2 GLSL.

import {
  fn,
  module,
  vec3,
  vec4,
  abs,
  fract,
  smoothstep,
  max,
  mix,
  clamp,
  fwidth,
  f32,
  f32T,
} from '../src/index.ts'
import { VsOut, vs, fullscreenUniforms } from './_fullscreen.ts'
import type { ShaderExample } from './_shared.ts'
const U = fullscreenUniforms({ spacing: f32T })

const fs = fn(
  'fs',
  { vo: VsOut },
  ({ vo }) => {
    const uv = vo.uv
    const sp = U.field.spacing
    // UV → lon/lat, with a slow longitudinal pan over time.
    const lon = uv.x.mul(360).sub(180).add(U.field.time.mul(8))
    const lat = uv.y.mul(180).sub(90)

    // Distance (in degrees) to the nearest gridline, for lon and lat.
    const dLon = abs(fract(lon.div(sp).add(0.5)).sub(0.5)).mul(sp)
    const dLat = abs(fract(lat.div(sp).add(0.5)).sub(0.5)).mul(sp)
    // Screen-constant line width: fwidth gives degrees-per-pixel here.
    const gLon = f32(1).sub(smoothstep(0, fwidth(lon).mul(1.5), dLon))
    const gLat = f32(1).sub(smoothstep(0, fwidth(lat).mul(1.5), dLat))
    const grid = max(gLon, gLat)
    // Equator emphasis (fixed — uses the un-panned latitude).
    const eq = f32(1).sub(smoothstep(0, fwidth(lat).mul(3), abs(lat)))

    // Ocean background: deeper toward the poles.
    const ocean = mix(vec3(0.05, 0.13, 0.24), vec3(0.03, 0.07, 0.14), abs(lat).div(90))
    const lineCol = vec3(0.55, 0.72, 0.86)
    const withGrid = mix(ocean, lineCol, clamp(grid, 0, 1))
    const withEq = mix(withGrid, vec3(0.96, 0.84, 0.45), clamp(eq, 0, 1))
    return vec4(withEq, 1)
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

const graticuleModule = module({
  structs: [U.struct, VsOut.decl],
  bindings: [U.binding],
  funcs: [vs, fs],
})

export const graticule: ShaderExample = {
  id: 'graticule',
  title: 'Graticule',
  blurb:
    'The lon/lat grid every map draws — anti-aliased with screen-constant width via fwidth, gold equator, slowly spinning over time. Adjust the spacing in degrees.',
  category: 'cartographic',
  file: 'graticule.ts',
  module: graticuleModule,
  renderable: true,
  controls: {
    time: { kind: 'time' },
    resolution: { kind: 'resolution' },
    spacing: { kind: 'slider', label: 'Spacing (°)', min: 5, max: 45, step: 1, value: 15 },
  },
}
