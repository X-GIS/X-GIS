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

  zoom_building_color: {
    name: 'Buildings by Zoom',
    tag: 'style',
    description:
      'MapLibre example port (#1192): "Change building color based on zoom level" — protomaps buildings whose fill-[interpolate(zoom, …)] ramps parchment → terracotta as you zoom from city overview (z15) to street level (z17). Opens over lower Manhattan.',
    source: load('zoom-building-color.xgis'),
    zoom: 15.5,
    center: [-74.006, 40.712],
  },
}
