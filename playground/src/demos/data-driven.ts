// ═══ Demo Definitions — Data-driven styling (match/gradient) + data-driven points/shapes/symbols. ═══
// Faithful per-category fragment of the single DEMOS record (assembled in
// ../demos.ts, which preserves the original insertion order). Demo .xgis
// sources load via the shared loader; ids are unchanged (URL nav depends on
// them). Append-only: a new demo in this category is added HERE.

import { load, type Demo } from './loader'

export const DEMOS_DATA_DRIVEN: Record<string, Demo> = {
  continent_match: {
    name: 'Continent Match',
    tag: 'data-driven',
    description: 'Each continent a distinct color using match() — GPU if-else chain per feature',
    source: load('continent-match.xgis'),
  },

  gdp_gradient: {
    name: 'GDP Gradient',
    tag: 'data-driven',
    description: 'GDP heatmap using gradient() — linear interpolation from blue to red via mix()',
    source: load('gdp-gradient.xgis'),
  },

  income_match: {
    name: 'Income Groups',
    tag: 'data-driven',
    description: 'World Bank income classification using match() — 5 categories with fallback',
    source: load('income-match.xgis'),
  },

  population_gradient: {
    name: 'Population Gradient',
    tag: 'data-driven',
    description: 'Population density gradient — yellow (small) to purple (1.4B) via GPU mix()',
    source: load('population-gradient.xgis'),
  },

  gradient_points: {
    name: 'Gradient Points',
    tag: 'point',
    description:
      'Population tiers — blue (small), amber (medium), rose (mega) with data-driven sizes',
    source: load('gradient-points.xgis'),
  },

  heatmap: {
    name: 'Population Heatmap',
    tag: 'point',
    description:
      'Density heatmap over populated places — Phase R 3-pass GPU (accum Gaussian splat → separable blur → density→colour compose)',
    source: load('heatmap.xgis'),
  },

  inline_data: {
    name: 'Inline GeoJSON',
    tag: 'data-driven',
    description: 'GeoJSON embedded directly in the source via `data: { ... }` — no url fetch',
    source: load('inline-data.xgis'),
  },

  custom_shapes: {
    name: 'Custom Shapes',
    tag: 'point',
    description:
      'Built-in SDF shapes (star, diamond, etc.) via GPU storage buffer — real-time distance field',
    source: load('custom-shapes.xgis'),
  },

  shape_gallery: {
    name: 'Shape Gallery',
    tag: 'point',
    description: 'Multiple shapes by population — star (mega), diamond (large), triangle (small)',
    source: load('shape-gallery.xgis'),
  },

  custom_symbol: {
    name: 'Custom Symbol',
    tag: 'point',
    description: 'User-defined arrow and flag symbols via SVG path in symbol{} blocks',
    source: load('custom-symbol.xgis'),
  },
}
