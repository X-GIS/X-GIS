// ═══ @xgis/shader-dsl examples — registry ═══
//
// The single import surface for the examples: the CLI printer (print.ts) and the site's
// interactive /shader-dsl page both consume `examples` from here. Each entry carries its
// built DSL `module` (emit WGSL/GLSL + reflect from it) plus the metadata the site needs
// to render + control it. This file is runtime-free and browser-safe (no console / node).

import { graticule } from './graticule.ts'
import { hillshade } from './hillshade.ts'
import { colorRamp } from './color-ramp.ts'
import { plasma } from './shadertoy-plasma.ts'
import { voronoi } from './voronoi.ts'
import { julia } from './julia.ts'
import { mandelbrot } from './mandelbrot.ts'
import { fbmClouds } from './fbm-clouds.ts'
import { domainWarp } from './domain-warp.ts'
import { raymarchSphere } from './raymarch-sphere.ts'
import { raymarchBoxes } from './raymarch-boxes.ts'
import { tunnel } from './tunnel.ts'
import { metaballs } from './metaballs.ts'
import { ocean } from './ocean.ts'
import { starfield } from './starfield.ts'
import { truchet } from './truchet.ts'
import { kaleidoscope } from './kaleidoscope.ts'
import { heart } from './heart.ts'
import { gradient } from './gradient-pass.ts'
import { computeReduction } from './compute-reduction.ts'
import type { ShaderExample } from './_shared.ts'

export type { ShaderExample, Control } from './_shared.ts'
export {
  graticule,
  hillshade,
  colorRamp,
  plasma,
  voronoi,
  julia,
  mandelbrot,
  fbmClouds,
  domainWarp,
  raymarchSphere,
  raymarchBoxes,
  tunnel,
  metaballs,
  ocean,
  starfield,
  truchet,
  kaleidoscope,
  heart,
  gradient,
  computeReduction,
}

/** All examples, cartographic first (they belong on a map site), then generic, then compute. */
export const examples: readonly ShaderExample[] = [
  graticule,
  hillshade,
  colorRamp,
  plasma,
  voronoi,
  julia,
  mandelbrot,
  fbmClouds,
  domainWarp,
  raymarchSphere,
  raymarchBoxes,
  tunnel,
  metaballs,
  ocean,
  starfield,
  truchet,
  kaleidoscope,
  heart,
  gradient,
  computeReduction,
]
