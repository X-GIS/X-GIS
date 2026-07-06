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
import { fbmClouds } from './fbm-clouds.ts'
import { raymarchSphere } from './raymarch-sphere.ts'
import { gradient } from './gradient-pass.ts'
import { computeReduction } from './compute-reduction.ts'
import { fp64DeepZoom } from './fp64-deep-zoom.ts'
import { fp64Mandelbrot } from './fp64-mandelbrot.ts'
import type { ShaderExample } from './_shared.ts'

export type { ShaderExample, Control } from './_shared.ts'
export {
  graticule,
  hillshade,
  fp64DeepZoom,
  colorRamp,
  plasma,
  voronoi,
  julia,
  fbmClouds,
  raymarchSphere,
  gradient,
  computeReduction,
}

/** All examples, cartographic first (they belong on a map site), then generic, then compute. */
export const examples: readonly ShaderExample[] = [
  graticule,
  hillshade,
  fp64DeepZoom,
  colorRamp,
  plasma,
  voronoi,
  julia,
  fbmClouds,
  raymarchSphere,
  fp64Mandelbrot,
  gradient,
  computeReduction,
]
