// ═══ Demo Definitions — Core demos: basic styling, raster, zoom, multi-layer, picking, categorical, and vector-tile / PMTiles / Mapbox-import sources. ═══
// Faithful per-category fragment of the single DEMOS record (assembled in
// ../demos.ts, which preserves the original insertion order). Demo .xgis
// sources load via the shared loader; ids are unchanged (URL nav depends on
// them). Append-only: a new demo in this category is added HERE.

import { load, type Demo } from './loader'

export const DEMOS_CORE: Record<string, Demo> = {
  minimal: {
    name: 'Minimal',
    tag: 'basic',
    description: 'One source, one layer — the simplest X-GIS program',
    source: load('minimal.xgis'),
  },

  dark: {
    name: 'Dark Theme',
    tag: 'basic',
    description: 'Dark fill with bright cyan borders',
    source: load('dark.xgis'),
  },

  raster: {
    name: 'Raster + Borders',
    tag: 'raster',
    description: 'OpenStreetMap tile layer with translucent country borders',
    source: load('raster.xgis'),
  },

  zoom: {
    name: 'Zoom Styles',
    tag: 'zoom',
    description: 'Opacity changes by zoom level — zoom in and out to see the effect',
    source: load('zoom.xgis'),
  },

  multi_layer: {
    name: 'Multi-Layer',
    tag: 'layer',
    description: 'Two layers from the same source with different styles, stacked over raster tiles',
    source: load('multi-layer.xgis'),
  },

  picking_demo: {
    name: 'Picking + Events',
    tag: 'event',
    description:
      'Hover (desktop) or tap (mobile) a country to see its name, coordinate, and feature ID. Demonstrates layer.addEventListener.',
    source: load('picking-demo.xgis'),
    picking: true,
  },

  mouse_position: {
    name: 'Mouse Position',
    tag: 'event',
    description:
      'MapLibre "Get coordinates of the mouse pointer" port (#1192) — a badge tracks the live lon/lat under the cursor via map.unproject() on every pointermove, independent of hovering a feature.',
    source: load('mouse-position.xgis'),
    mousePosition: true,
  },

  measure_distances: {
    name: 'Measure Distances',
    tag: 'event',
    description:
      'MapLibre "Measure distances" port (#1192 / #1235) — click to drop measurement points (click a point to remove it); the host pushes measure_pts / measure_path via setSourceData and a badge totals the haversine distance.',
    source: load('measure-distances.xgis'),
    measure: true,
  },

  categorical: {
    name: 'Categorical Colors',
    tag: 'per-feature',
    description: 'Each country colored by name — 20 GPU-assigned colors via storage buffer',
    source: load('categorical.xgis'),
  },

  vector_categorical: {
    name: 'Categorical (Countries)',
    tag: 'natural-earth',
    description: 'Per-feature categorical colors on Natural Earth 110m country borders',
    source: load('vector-categorical.xgis'),
  },

  pmtiles_source: {
    name: 'PMTiles (MVT)',
    tag: 'vector-tiles',
    description: 'MVT-in-PMTiles archive — drop sample.pmtiles into playground/public to render',
    source: load('pmtiles-source.xgis'),
  },

  pmtiles_labels: {
    name: 'PMTiles labels',
    tag: 'vector-tiles',
    description:
      'SDF text labels from MVT places — `label-["{.name}"]` on a vector-tile source-layer',
    source: load('pmtiles-labels.xgis'),
  },

  import_mapbox_style: {
    name: 'import "mapbox-style-url"',
    tag: 'vector-tiles',
    description:
      'One-line splice import: runtime fetches OpenFreeMap Bright style.json, runs convertMapboxStyle, prepends the converted xgis. Zero JS glue.',
    source: load('import-mapbox-style.xgis'),
  },

  import_mapbox_inline_geojson: {
    name: 'import "mapbox-style" — inline GeoJSON',
    tag: 'vector-tiles',
    description:
      'Mapbox style.json with an inline FeatureCollection in source.data. The importer captures the data via the inlineGeoJSON collector and auto-pushes it via setSourceData after run() — no host glue. Two red boxes (Korea + Tokyo) confirm the features rendered. Open #3.5/37/132 to frame both.',
    source: load('import-mapbox-inline-geojson.xgis'),
  },

  import_maplibre_demo: {
    name: 'import "maplibre-demo-style"',
    tag: 'vector-tiles',
    description:
      'Canonical MapLibre demo style (https://demotiles.maplibre.org/style.json). Mapbox v8 schema, ~33 layers, vector tiles via TileJSON. Verifies X-GIS imports the wider MapLibre ecosystem (Versatiles, OpenFreeMap Liberty/Positron/Dark, MapTiler open styles) which all share this shape.',
    source: load('import-maplibre-demo.xgis'),
  },

  along_path_roads: {
    name: 'Along-path road labels',
    tag: 'vector-tiles',
    description:
      'symbol-placement: line — label-along-path rotates each road name to match its segment tangent, so streets read along their geometry instead of horizontally.',
    source: load('along-path-roads.xgis'),
  },

  step_and_concat: {
    name: 'step + concat (Batch 6)',
    tag: 'basic',
    description:
      'N-stop step expression sizes / colors city dots into 4 population tiers; concat composes "City, Country (NNN k)" labels with round() for rounded thousands. Demonstrates the full Mapbox math + string operator surface.',
    source: load('step-and-concat.xgis'),
  },

  multiline_labels: {
    name: 'Multiline labels',
    tag: 'basic',
    description: 'Long city names wrap at label-max-width with line-height + justify-center',
    source: load('multiline-labels.xgis'),
  },

  pmtiles_v4: {
    name: 'PMTiles — protomaps v4',
    tag: 'vector-tiles',
    description: 'Production protomaps daily world basemap (~6 GB, 176M tiles, z=0..15)',
    source: load('pmtiles-protomaps-v4.xgis'),
  },

  pmtiles_layered: {
    name: 'PMTiles — per-layer styling',
    tag: 'vector-tiles',
    description:
      'Same v4 archive split into water/landuse/roads/buildings, each styled independently. Navigate to a city: #14/35.68/139.76 (Tokyo)',
    source: load('pmtiles-layered.xgis'),
  },

  openfreemap_bright: {
    name: 'OpenFreeMap — Bright (live import)',
    tag: 'vector-tiles',
    description:
      'Live one-line `import "…/styles/bright"` — the runtime fetches the OpenFreeMap "bright" Mapbox style and converts it in full, including the place/POI/road-name/shield labels (the old static snapshot dropped every symbol layer). OpenMapTiles schema. Use this to stress-test pitched / panned views against a real-world style. Navigate to a city: #14/35.68/139.76 (Tokyo), #14/40.78/-73.97 (Manhattan).',
    source: load('openfreemap-bright.xgis'),
  },

  pmtiles_only_landuse: {
    name: 'PMTiles — landuse only (diag)',
    tag: 'vector-tiles',
    description:
      'Diagnostic — single MVT layer (landuse) rendered alone in green. Used to isolate stripe artefacts.',
    source: load('pmtiles-only-landuse.xgis'),
  },

  osm_style: {
    name: 'OSM-style cartography',
    tag: 'vector-tiles',
    description:
      'Richer cartographic rendering on protomaps v4: per-kind landuse + road hierarchy (minor/secondary/primary/highway/rail) + buildings. Navigate to a city: #14/35.68/139.76 (Tokyo), #14/40.78/-73.97 (Manhattan).',
    source: load('osm-style.xgis'),
  },

  pitch_bearing: {
    name: 'Pitch & Bearing',
    tag: 'core',
    description:
      'MapLibre example port (#1192): "Set pitch and bearing" — a plain countries basemap opened with a tilted, rotated camera (pitch 60°, bearing −45°) over the Italian peninsula via the Demo.pitch/Demo.bearing camera-pose metadata.',
    source: load('pitch-bearing.xgis'),
    zoom: 5.5,
    center: [12.5, 42],
    pitch: 60,
    bearing: -45,
  },
}
