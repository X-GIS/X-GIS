import type { CoverageEntry } from './types'

export const PAINT_RASTER: readonly CoverageEntry[] = [
  {
    name: 'raster-opacity',
    status: 'supported',
    note: 'Constant and interpolate-by-zoom resolve per frame into the global RasterRenderer opacity uniform, and so does the input-dependent form — a binding that reads a declared `input` but no feature field, which is a per-frame constant. That last form used to render at 1: the opaque pass called resolveNumberShape WITHOUT the live input store, so the authored value was dropped on frame one and setInput moved nothing (fixed #2166; the DEM-relief path had the same drop). A genuinely per-feature form is not authorable here — the pinned oracle marks raster-opacity data-constant, a raster tile carrying no features — and such a shape still resolves to 1. Single raster show per scene is supported; multi-raster styles fall back to the first declared show.',
    source: 'paint.ts:38',
  },
  {
    name: 'raster-hue-rotate',
    status: 'supported',
    note: "Constant degrees. Rotates the sampled texel hue in the raster fragment shader (MapLibre's spin-weights matrix, mirrored by `rasterSpinWeights` in shaders/dsl/raster-color.ts). Default 0 is a no-op.",
    source: 'paint-raster.ts',
  },
  {
    name: 'raster-brightness-min',
    status: 'supported',
    note: 'Constant 0..1. Lower bound of the fragment brightness remap (mix(min,max,rgb)). Default 0 is a no-op.',
    source: 'paint-raster.ts',
  },
  {
    name: 'raster-brightness-max',
    status: 'supported',
    note: 'Constant 0..1. Upper bound of the fragment brightness remap. Default 1 is a no-op.',
    source: 'paint-raster.ts',
  },
  {
    name: 'raster-saturation',
    status: 'supported',
    note: 'Constant -1..1. HSL saturation multiplier applied in the raster fragment shader (MapLibre saturation factor). Default 0 is a no-op.',
    source: 'paint-raster.ts',
  },
  {
    name: 'raster-contrast',
    status: 'supported',
    note: 'Constant -1..1. Fragment contrast scale (MapLibre contrast factor about 0.5). Default 0 is a no-op.',
    source: 'paint-raster.ts',
  },
  {
    name: 'raster-fade-duration',
    status: 'partial',
    impact: 'low',
    note: 'Constant-only (#1257). Emits raster-fade-duration-<ms> → paintShapes.raster.fadeDurationMs, overriding the per-tile cross-fade duration (RasterRenderer, runtime default 300ms / XGISMapOptions.rasterFadeDuration) for the authored layer. Zoom-interp / data-driven forms warn and drop. Closing that residual is four-part, not one: the converter has only a constant arm (addRasterFadeDuration), the utility grammar carries a single scalar-prefix entry where a zoom form needs the two-entry pattern `opacity` uses, fadeDurationMs is a bare number rather than a PropertyShape like its five raster-colour siblings, and the value is pushed ONCE at layer rebuild — nothing resolves it per frame, so a PropertyShape alone would still never be sampled. It also needs a semantics decision first: the per-tile ramp divides elapsed time by the duration, so a duration that moves mid-fade is non-monotone in time and a tile visibly un-fades. The intended fix stamps the duration beside firstShownMs when the ramp is armed, so an in-flight fade completes at the duration in force when it started and only new fades adopt a new one.',
    source: 'paint-raster.ts',
  },
  {
    name: 'raster-resampling',
    status: 'supported',
    note: 'linear (default) vs nearest. nearest selects a nearest-filtered GPUSampler (pixel-art / DEM staircase). Default linear is byte-identical to the historical fixed-linear sampler.',
    source: 'paint-raster.ts',
  },
  {
    name: 'resampling',
    status: 'supported',
    note: 'MapLibre v3 alias for raster-resampling — same value space + same nearest-sampler path. raster-resampling wins if both are present.',
    source: 'paint-raster.ts',
  },
]
