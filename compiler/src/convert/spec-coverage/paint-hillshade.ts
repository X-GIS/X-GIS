import type { CoverageEntry } from './types'

// #777 Phase II — rendered end-to-end: the converter (paint-hillshade.ts)
// lowers each axis, the DSL fs_hillshade shades via the full MapLibre v5
// method set (standard / basic / combined / igor / multidirectional, up to 4
// averaged light sources), and the HillshadeRenderer/HillshadePass draw it on
// both backends. Constant forms only (zoom-interp / data-driven hillshade
// paint warns + drops — same bar the supported raster colour axes use);
// `resampling: linear` decoded-height smoothing stays the documented partial.
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
    note: 'linear (spec default) / nearest DEM sampling. The MVP single-pass fragment renders the nearest 3×3 field (byte-parity with MapLibre nearest); linear decoded-height smoothing is the documented two-pass upgrade.',
  },
]
