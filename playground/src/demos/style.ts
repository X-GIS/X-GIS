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

  color_switcher: {
    name: 'Color Switcher',
    tag: 'style',
    description:
      'MapLibre "Change a layer\'s color with buttons" port — action buttons drive the runtime setPaintProperty API on the mounted scene',
    source: load('color-switcher.xgis'),
    actions: [
      { label: 'Rose fill', run: (m) => m.setPaintProperty('countries', 'fill-color', '#f43f5e') },
      { label: 'Amber fill', run: (m) => m.setPaintProperty('countries', 'fill-color', '#f59e0b') },
      { label: 'Sky fill', run: (m) => m.setPaintProperty('countries', 'fill-color', '#0ea5e9') },
      { label: 'White line', run: (m) => m.setPaintProperty('countries', 'line-color', '#ffffff') },
    ],
  },

  fly_to: {
    name: 'Fly To',
    tag: 'style',
    description:
      'MapLibre "Fly to a location" port — action buttons call map.flyTo({center, zoom}) at runtime',
    source: load('fly-to.xgis'),
    actions: [
      { label: 'Seoul', run: (m) => m.flyTo({ center: [126.978, 37.5665], zoom: 8 }) },
      { label: 'Paris', run: (m) => m.flyTo({ center: [2.3522, 48.8566], zoom: 8 }) },
      { label: 'World', run: (m) => m.flyTo({ center: [0, 0], zoom: 0.5 }) },
    ],
  },
}
