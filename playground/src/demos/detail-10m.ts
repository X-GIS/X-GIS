// ═══ Demo Definitions — 10m-detail Natural Earth tier (physical/states/rivers/zoom-LOD/places/night). ═══
// Faithful per-category fragment of the single DEMOS record (assembled in
// ../demos.ts, which preserves the original insertion order). Demo .xgis
// sources load via the shared loader; ids are unchanged (URL nav depends on
// them). Append-only: a new demo in this category is added HERE.

import { load, type Demo } from './loader'

export const DEMOS_DETAIL_10M: Record<string, Demo> = {
  physical_map_10m: {
    name: 'Physical Map 10m',
    tag: '10m',
    description:
      'Finest-grain Natural Earth physical map: 10m ocean, land, rivers, lakes. Capillary river network, every major bay and lake — zoom in to see the difference against 50m.',
    source: load('physical-map-10m.xgis'),
  },

  states_10m: {
    name: 'States 10m',
    tag: '10m',
    description:
      '10m admin-1 boundaries with per-country categorical fill. Sharper state borders than 50m — useful for detailed views of US, Brazil, India, Australia.',
    source: load('states-10m.xgis'),
  },

  rivers_10m: {
    name: 'Rivers 10m',
    tag: '10m',
    description:
      'Full 10m river network over dark land. Major basins resolve into hundreds of named tributaries at high zoom. Thick cyan strokes against deep green land.',
    source: load('rivers-10m.xgis'),
  },

  zoom_lod: {
    name: 'Zoom LOD',
    tag: 'zoom',
    description:
      'Progressive level-of-detail: 110m coastline at low zoom, 50m land + major rivers at mid zoom, full 10m land + river network at high zoom. Opacity modifiers cross-fade between tiers.',
    source: load('zoom-lod.xgis'),
  },

  populated_places: {
    name: 'Populated Places',
    tag: 'point',
    description:
      'World cities over 10m states background. Pin size scales with POP_MAX via gradient(). Uses the populated-places Point dataset (bulk tiler now produces point-only tiles correctly).',
    source: load('populated-places.xgis'),
  },

  night_map: {
    name: 'Night Map',
    tag: '10m',
    description:
      'Dark indigo land with warm amber rivers and lakes. Two-layer glow + body stroke gives each river a soft halo. Demonstrates how color + opacity choices produce distinct visual identities from the same geometry.',
    source: load('night-map.xgis'),
  },
}
