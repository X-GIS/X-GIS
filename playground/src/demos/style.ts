// ═══ Demo Definitions — CSS-like named styles + per-feature filters. ═══
// Faithful per-category fragment of the single DEMOS record (assembled in
// ../demos.ts, which preserves the original insertion order). Demo .xgis
// sources load via the shared loader; ids are unchanged (URL nav depends on
// them). Append-only: a new demo in this category is added HERE.

import { load, type Demo } from './loader'

export const DEMOS_STYLE: Record<string, Demo> = {
  styled_world: {
    name: 'Styled World',
    tag: 'style',
    description: 'Named styles, CSS properties, and per-feature filters on Natural Earth data',
    source: load('styled-world.xgis'),
  },

  filter_gdp: {
    name: 'GDP Filter',
    tag: 'style',
    description: 'Filter countries by GDP — only high-GDP countries are rendered',
    source: load('filter-gdp.xgis'),
  },

  layer_below_labels: {
    name: 'Layer Below Labels',
    tag: 'style',
    description:
      'MapLibre "Add a new layer below labels" port — a translucent lake overlay stacks above the land fill while city labels stay on top (label stage composites over every fill, no beforeId needed)',
    source: load('layer-below-labels.xgis'),
  },
}
