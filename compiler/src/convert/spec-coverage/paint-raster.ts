import type { CoverageEntry } from './types'

export const PAINT_RASTER: readonly CoverageEntry[] = [
  { name: 'raster-opacity',         status: 'supported', note: 'Constant + interpolate-by-zoom + data-driven (all PropertyShape kinds) routed through the global RasterRenderer opacity uniform. Single raster show per scene is supported; multi-raster styles fall back to the first declared show.', source: 'paint.ts:38' },
  { name: 'raster-hue-rotate',      status: 'supported', note: 'Constant degrees. Rotates the sampled texel hue (MapLibre spinWeights) in the raster fragment shader. Default 0 is a no-op.', source: 'paint-raster.ts' },
  { name: 'raster-brightness-min',  status: 'supported', note: 'Constant 0..1. Lower bound of the fragment brightness remap (mix(min,max,rgb)). Default 0 is a no-op.', source: 'paint-raster.ts' },
  { name: 'raster-brightness-max',  status: 'supported', note: 'Constant 0..1. Upper bound of the fragment brightness remap. Default 1 is a no-op.', source: 'paint-raster.ts' },
  { name: 'raster-saturation',      status: 'supported', note: 'Constant -1..1. HSL saturation multiplier applied in the raster fragment shader (MapLibre saturation factor). Default 0 is a no-op.', source: 'paint-raster.ts' },
  { name: 'raster-contrast',        status: 'supported', note: 'Constant -1..1. Fragment contrast scale (MapLibre contrast factor about 0.5). Default 0 is a no-op.', source: 'paint-raster.ts' },
  { name: 'raster-fade-duration',   status: 'unsupported', impact: 'low', note: 'Crossfade between zoom levels. X-GIS swaps tiles atomically; no fade.' },
  { name: 'raster-resampling',      status: 'supported', note: 'linear (default) vs nearest. nearest selects a nearest-filtered GPUSampler (pixel-art / DEM staircase). Default linear is byte-identical to the historical fixed-linear sampler.', source: 'paint-raster.ts' },
  { name: 'resampling',             status: 'supported', note: 'MapLibre v3 alias for raster-resampling — same value space + same nearest-sampler path. raster-resampling wins if both are present.', source: 'paint-raster.ts' },
]
