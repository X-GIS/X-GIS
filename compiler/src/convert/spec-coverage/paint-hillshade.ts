import type { CoverageEntry } from './types'

// #777 Phase II — rendered end-to-end: the converter (paint-hillshade.ts)
// lowers each axis, the DSL fs_hillshade shades via the full MapLibre v5
// method set (standard / basic / combined / igor / multidirectional, up to 4
// averaged light sources), and the HillshadeRenderer/HillshadePass draw it on
// both backends. Constant forms only (zoom-interp / data-driven hillshade
// paint warns + drops — same bar the supported raster colour axes use);
// `resampling: linear` (a smoother relief under magnification) stays the
// documented partial.
export const PAINT_HILLSHADE: readonly CoverageEntry[] = [
  {
    name: 'hillshade-illumination-direction',
    status: 'supported',
    note: 'Light azimuth(s), deg from N (numberArray). Single source + multidirectional arrays up to 4 sources (MapLibre repeat-last padding; >4 truncates with a warning). Sources 2..4 emit as hillshade-illumination-direction2..4 utilities.',
    source: 'paint-hillshade.ts',
  },
  {
    name: 'hillshade-illumination-altitude',
    status: 'supported',
    note: 'Light elevation(s), 0–90° (numberArray). Single source + multidirectional arrays up to 4 sources; used by the basic / combined / multidirectional models.',
    source: 'paint-hillshade.ts',
  },
  {
    name: 'hillshade-illumination-anchor',
    status: 'supported',
    note: 'map / viewport — viewport (default) folds the camera bearing into every light azimuth per frame; map anchors the light(s) to data space.',
    source: 'paint-hillshade.ts',
  },
  {
    name: 'hillshade-exaggeration',
    status: 'supported',
    note: 'Vertical-relief multiplier (constant). Non-constant (zoom-interp / data-driven) forms warn + drop.',
    source: 'paint-hillshade.ts',
  },
  {
    name: 'hillshade-shadow-color',
    status: 'supported',
    note: 'Shadow-side colour(s) (colorArray). Single colour + multidirectional arrays up to 4 sources (premultiplied at pack time).',
    source: 'paint-hillshade.ts',
  },
  {
    name: 'hillshade-highlight-color',
    status: 'supported',
    note: 'Lit-side colour(s) (colorArray). Single colour + multidirectional arrays up to 4 sources (premultiplied at pack time).',
    source: 'paint-hillshade.ts',
  },
  {
    name: 'hillshade-accent-color',
    status: 'supported',
    note: 'Accent tint (single colour) — used by the standard model (MapLibre parity). Constant lowered (premultiplied); non-constant warns + drops.',
    source: 'paint-hillshade.ts',
  },
  {
    name: 'hillshade-method',
    status: 'supported',
    note: 'All five MapLibre v5 models implemented in fs_hillshade: standard (default), basic (GDAL-Lambert), combined, igor, multidirectional (up to 4 averaged Lambert sources).',
    source: 'paint-hillshade.ts',
  },
  {
    name: 'resampling',
    status: 'partial',
    impact: 'low',
    note: 'linear (spec default) is authored but never rendered. TWO facts, conflated in the row this replaces (#2218 review): (a) the DEM sampler is nearest BY CONSTRUCTION — the RGB-packed height is decoded in the fragment, so bilinear over the packed bytes corrupts the decode, and the hillshade draper binds exactly one nearest sampler; (b) `resampling` does NOT select that sampler, in EITHER engine — MapLibre binds its DEM nearest for BOTH values and applies the flag to the texture filter on the Sobel-derivative output of its prepare pass instead (maplibre-gl 5.24.0, dist/maplibre-gl-dev.js lines 64424 / 64443 / 64453). So `linear` means: smooth the relief where a DEM tile is magnified. X-GIS shades SINGLE-PASS — the 3×3 Sobel is evaluated per fragment from the nearest-sampled DEM, so the relief is flat across each DEM texel, which is exactly the MapLibre `nearest` look. Reaching `linear` means bilinearly blending the DECODED neighbour heights before the Sobel (#2215); that is equivalent to filtering the derivative, because the Sobel is a linear convolution at integer texel offsets, and it stays single-pass. Since #2166 an EXPLICITLY authored linear warns at convert time (an omitted one stays silent, like every other default this converter carries). `nearest` converts end to end — utility, binding, render node, resamplingNearest on the emitted show — and reaches no runtime reader at all: the landed compiler half of a two-half feature, not wiring.',
    source: 'paint-hillshade.ts',
  },
]
