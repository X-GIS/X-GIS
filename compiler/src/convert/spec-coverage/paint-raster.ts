import type { CoverageEntry } from './types'

export const PAINT_RASTER: readonly CoverageEntry[] = [
  { name: 'raster-opacity',         status: 'supported', note: 'Constant + interpolate-by-zoom + data-driven (all PropertyShape kinds) routed through the global RasterRenderer opacity uniform. Single raster show per scene is supported; multi-raster styles fall back to the first declared show.', source: 'paint.ts:38' },
  { name: 'raster-hue-rotate',      status: 'unsupported', impact: 'low', note: 'Rotate raster hue in HSL. Would need a fragment HSL-rotate pass.' },
  { name: 'raster-brightness-min',  status: 'unsupported', impact: 'low', note: 'Lower bound of raster brightness remap. Fragment-shader linear contrast adjust.' },
  { name: 'raster-brightness-max',  status: 'unsupported', impact: 'low', note: 'Upper bound of raster brightness remap.' },
  { name: 'raster-saturation',      status: 'unsupported', impact: 'low', note: 'HSL saturation multiplier on raster sample.' },
  { name: 'raster-contrast',        status: 'unsupported', impact: 'low', note: 'Fragment-shader contrast scale.' },
  { name: 'raster-fade-duration',   status: 'unsupported', impact: 'low', note: 'Crossfade between zoom levels. X-GIS swaps tiles atomically; no fade.' },
  { name: 'raster-resampling',      status: 'unsupported', impact: 'low', note: 'linear (default) vs nearest. Sampler is fixed to linear; per-show override would need a separate sampler binding. Iter 17 added spec-default suppression + iter 18 generic SPEC_DEFAULT_NO_WARN helper so authoring `linear` (matches X-GIS) is silent; `nearest` warns explicitly.' },
  { name: 'resampling',             status: 'unsupported', impact: 'low', note: 'MapLibre v3 alias for raster-resampling — same semantic.' },
]
