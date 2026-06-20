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
}
