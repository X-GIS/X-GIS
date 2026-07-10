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
import { overrideQuality } from './override-quality.ts'
import { computeReduction } from './compute-reduction.ts'
import { fp64DeepZoom } from './fp64-deep-zoom.ts'
import { fp64Mandelbrot } from './fp64-mandelbrot.ts'
import { fp64CheckerPlane } from './fp64-checker-plane.ts'
import { fp64Loran } from './fp64-loran.ts'
import { fp64MercatorTiles } from './fp64-mercator-tiles.ts'
import { fp64Rtc } from './fp64-rtc.ts'
import { fp64Julia } from './fp64-julia.ts'
import { fp64BurningShip } from './fp64-burning-ship.ts'
import { fp64Newton } from './fp64-newton.ts'
import { fp64MandelbrotDe } from './fp64-mandelbrot-de.ts'
import { fp64Clock } from './fp64-clock.ts'
import { fp64Cancellation } from './fp64-cancellation.ts'
import type { ShaderExample } from './_shared.ts'

export type { ShaderExample, Control } from './_shared.ts'
export {
  graticule,
  hillshade,
  fp64DeepZoom,
  fp64CheckerPlane,
  fp64Loran,
  fp64MercatorTiles,
  fp64Rtc,
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
  fp64Mandelbrot,
  fp64Julia,
  fp64BurningShip,
  fp64Newton,
  fp64MandelbrotDe,
  fp64Clock,
  fp64Cancellation,
  gradient,
  overrideQuality,
  computeReduction,
}

/** All examples, cartographic first (they belong on a map site), then generic, then compute. */
export const examples: readonly ShaderExample[] = [
  graticule,
  hillshade,
  fp64DeepZoom,
  fp64CheckerPlane,
  fp64Loran,
  fp64MercatorTiles,
  fp64Rtc,
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
  fp64Mandelbrot,
  fp64Julia,
  fp64BurningShip,
  fp64Newton,
  fp64MandelbrotDe,
  fp64Clock,
  fp64Cancellation,
  gradient,
  overrideQuality,
  computeReduction,
]
