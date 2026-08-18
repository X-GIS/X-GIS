// ═══ @xgis/shader-dsl examples — registry ═══
//
// GENERATED — DO NOT EDIT.
// Regenerate with: bun scripts/gen-example-registry.ts > shader-dsl/examples/index.ts
//
// The single import surface for the examples: the CLI printer (print.ts) and the site's
// interactive /shader-dsl page both consume `examples` from here. Each entry carries its
// built DSL `module` (emit WGSL/GLSL + reflect from it) plus the metadata the site needs
// to render + control it. This file is runtime-free and browser-safe (no console / node).
//
// The ORDER is curated, not discovered — edit `_order.ts`, then regenerate. Adding an
// example is: write the file, add its id to `_order.ts`, run the command above.

import { graticule } from './graticule.js'
import { hillshade } from './hillshade.js'
import { fp64DeepZoom } from './fp64-deep-zoom.js'
import { fp64CheckerPlane } from './fp64-checker-plane.js'
import { fp64Loran } from './fp64-loran.js'
import { fp64MercatorTiles } from './fp64-mercator-tiles.js'
import { fp64Rtc } from './fp64-rtc.js'
import { colorRamp } from './color-ramp.js'
import { plasma } from './shadertoy-plasma.js'
import { voronoi } from './voronoi.js'
import { julia } from './julia.js'
import { mandelbrot } from './mandelbrot.js'
import { fbmClouds } from './fbm-clouds.js'
import { domainWarp } from './domain-warp.js'
import { raymarchSphere } from './raymarch-sphere.js'
import { raymarchBoxes } from './raymarch-boxes.js'
import { tunnel } from './tunnel.js'
import { metaballs } from './metaballs.js'
import { ocean } from './ocean.js'
import { starfield } from './starfield.js'
import { truchet } from './truchet.js'
import { kaleidoscope } from './kaleidoscope.js'
import { heart } from './heart.js'
import { fp64Mandelbrot } from './fp64-mandelbrot.js'
import { fp64Julia } from './fp64-julia.js'
import { fp64BurningShip } from './fp64-burning-ship.js'
import { fp64Newton } from './fp64-newton.js'
import { fp64MandelbrotDe } from './fp64-mandelbrot-de.js'
import { fp64Clock } from './fp64-clock.js'
import { fp64Cancellation } from './fp64-cancellation.js'
import { fp64SineSweep } from './fp64-sine-sweep.js'
import { gradient } from './gradient-pass.js'
import { overrideQuality } from './override-quality.js'
import { textureArrayLod } from './texture-array-lod.js'
import { computeReduction } from './compute-reduction.js'
import type { ShaderExample } from './_shared.js'

export type { ShaderExample, Control } from './_shared.js'
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
  fp64SineSweep,
  gradient,
  overrideQuality,
  textureArrayLod,
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
  fp64SineSweep,
  gradient,
  overrideQuality,
  textureArrayLod,
  computeReduction,
]
