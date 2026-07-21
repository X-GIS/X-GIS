import type { CoverageEntry } from './types'

// #777 Phase II. All nine rows are `partial`: the converter (paint-hillshade.ts)
// lowers the single-source constant form of each axis, the DSL fs_hillshade
// shades it (standard + basic models), and the HillshadeRenderer packs it — but
// the end-to-end relief draw is pending the pass wiring + real-GPU A/B (INC-5/6),
// and the multi-source / method / resampling residuals below are genuine gaps.
export const PAINT_HILLSHADE: readonly CoverageEntry[] = [
  {
    name: 'hillshade-illumination-direction',
    status: 'partial',
    impact: 'medium',
    note: 'Light azimuth (numberArray, deg from N). Single-source constant lowered → shader azimuth; a multidirectional (>1) array warns + uses element 0.',
  },
  {
    name: 'hillshade-illumination-altitude',
    status: 'partial',
    impact: 'medium',
    note: 'Light elevation (numberArray, 0–90°). Single-source constant lowered (used by the basic model); multidirectional array warns + uses element 0.',
  },
  {
    name: 'hillshade-illumination-anchor',
    status: 'partial',
    impact: 'low',
    note: 'map / viewport — viewport (default) folds the camera bearing into the light azimuth per frame; map anchors the light to data space. Constant only.',
  },
  {
    name: 'hillshade-exaggeration',
    status: 'partial',
    impact: 'medium',
    note: 'Vertical-relief multiplier (constant). Lowered → shader intensity; non-constant (zoom-interp / data-driven) forms warn + drop.',
  },
  {
    name: 'hillshade-shadow-color',
    status: 'partial',
    impact: 'medium',
    note: 'Shadow-side colour (colorArray). Single-source constant lowered (premultiplied); a multi-source colour array warns + uses element 0.',
  },
  {
    name: 'hillshade-highlight-color',
    status: 'partial',
    impact: 'medium',
    note: 'Lit-side colour (colorArray). Single-source constant lowered (premultiplied); a multi-source colour array warns + uses element 0.',
  },
  {
    name: 'hillshade-accent-color',
    status: 'partial',
    impact: 'low',
    note: 'Accent tint (single colour) — used by the standard model. Constant lowered (premultiplied); non-constant warns + drops.',
  },
  {
    name: 'hillshade-method',
    status: 'partial',
    impact: 'low',
    note: 'standard (default) + basic (GDAL-Lambert) implemented in fs_hillshade; combined / igor / multidirectional warn and approximate via the basic model.',
  },
  {
    name: 'resampling',
    status: 'partial',
    impact: 'low',
    note: 'linear (spec default) / nearest DEM sampling. The MVP single-pass fragment renders the nearest 3×3 field (byte-parity with MapLibre nearest); linear decoded-height smoothing is the documented two-pass upgrade.',
  },
]
