// ═══ Demo Definitions — Thematic / composition demos (outlines, borders, water hierarchy, megacities, animation). ═══
// Faithful per-category fragment of the single DEMOS record (assembled in
// ../demos.ts, which preserves the original insertion order). Demo .xgis
// sources load via the shared loader; ids are unchanged (URL nav depends on
// them). Append-only: a new demo in this category is added HERE.

import { load, type Demo } from './loader'

export const DEMOS_THEMATIC: Record<string, Demo> = {
  continent_outlines: {
    name: 'Continent Outlines',
    tag: 'thematic',
    description:
      'Each continent colored by match(.CONTINENT) with heavy matching outlines — distinct hue per landmass with a darker halo stroke.',
    source: load('continent-outlines.xgis'),
  },

  dashed_borders: {
    name: 'Dashed Borders',
    tag: 'thematic',
    description:
      'Translucent sky-blue country fill with dashed white borders. Mixes polygon fill with stroke-dasharray-8-4 line styling.',
    source: load('dashed-borders.xgis'),
  },

  coastline_10m: {
    name: 'Coastline 10m',
    tag: '10m',
    description:
      'World coastline at 10m resolution, rendered as two stacked line layers — dark shadow stroke + bright cyan body. No polygon fill. Stress test for dense SDF line vertices.',
    source: load('coastline-10m.xgis'),
  },

  water_hierarchy: {
    name: 'Water Hierarchy',
    tag: '10m',
    description:
      'Three-tier blue gradient for ocean, lakes, and rivers. Glow halos on both lakes and rivers give soft water-body ambience against neutral land.',
    source: load('water-hierarchy.xgis'),
  },

  raster_overlay: {
    name: 'Raster + 10m Borders',
    tag: 'raster',
    description:
      'OpenStreetMap basemap with translucent white 10m state boundaries overlaid. Demonstrates raster + vector composition and offscreen MAX-blend compositing over imagery.',
    source: load('raster-overlay.xgis'),
  },

  hillshade_terrarium: {
    name: 'Hillshade: Grand Canyon',
    tag: 'raster',
    description:
      'Shaded relief from LIVE terrain tiles (#777 Phase II): a raster-dem source streams AWS Terrain Tiles (terrarium encoding, {z}/{x}/{y}) into the HillshadeRenderer with authored paint — NW illumination (315°), 0.6 exaggeration, warm shadow/highlight palette. The real-data sibling of fixture_hillshade_local (the offline deterministic gate).',
    source: load('hillshade-terrarium.xgis'),
    zoom: 11,
    center: [-112.14, 36.1],
  },

  satellite_map: {
    name: 'Satellite Map',
    tag: 'raster',
    description:
      'MapLibre example port (#1192): "Display a satellite map" — Esri World Imagery as a plain raster source (note the ArcGIS {z}/{y}/{x} path order; the tile-URL substitution is order-agnostic). Opens over the Palm Jumeirah, Dubai.',
    source: load('satellite-map.xgis'),
    zoom: 12.5,
    center: [55.138, 25.112],
  },

  bold_borders: {
    name: 'Bold Borders',
    tag: 'thematic',
    description:
      'High-contrast flat country fill with double-stroke outlines: thick black shadow behind, bright amber foreground. Presentation-ready styling.',
    source: load('bold-borders.xgis'),
  },

  megacities: {
    name: 'Megacities',
    tag: 'point',
    description:
      'Populated places filtered by POP_MAX > 5M. Each city shown as a glowing 500 km halo + billboard pin whose size scales linearly up to 30M population.',
    source: load('megacities.xgis'),
  },

  layered_borders: {
    name: 'Layered Borders',
    tag: 'zoom',
    description:
      'Three-tier admin borders: bold countries (always visible), 50m states (fade in at z3), 10m states (fade in at z6). Drillable hierarchy via zoom-opacity modifiers.',
    source: load('layered-borders.xgis'),
  },

  bucket_order: {
    name: 'Bucket Order (regression)',
    tag: 'line',
    description:
      'Translucent yellow coast declared BEFORE opaque country fill. Bucket scheduler must render opaque first and composite the translucent stroke on top, regardless of declaration order.',
    source: load('bucket-order.xgis'),
  },

  animation_pulse: {
    name: 'Animation: pulse (PR 1)',
    tag: 'animation',
    description:
      'Keyframes block + animation-pulse modifier. Amber coastline fades 100 → 30 → 100 every 1.5s with ease-in-out. First landing of the X-GIS animation system.',
    source: load('animation-pulse.xgis'),
  },

  animation_showcase: {
    name: 'Animation: showcase (PR 3)',
    tag: 'animation',
    description:
      'Full property coverage — fill/stroke color morph, dash-offset marching, cross-property keyframes. Countries heat up, coastline marches, land outline cycles amber↔sky.',
    source: load('animation-showcase.xgis'),
  },

  coverage_bathymetry: {
    name: 'S-100 Coverage: bathymetry (#1158)',
    tag: 'thematic',
    description:
      'S-100 gridded-coverage (.xgcov) — a synthetic 32×32 bathymetry grid at 50-58°N with a north→south depth ramp, a nodata hole, and 4 known corner cells. The GPU colour-ramp draw is the INC-A gate-3 (headed) item; getCoverage(...).valueAt already returns the exact positive-down value CPU-side.',
    source: load('coverage-bathymetry.xgis'),
  },
}
