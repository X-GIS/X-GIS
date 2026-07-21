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

  animate_point_route: {
    name: 'Animate Point Along Route',
    tag: 'event',
    description:
      'MapLibre "Animate a point along a route" port (#1192) — Start slides the marker along the inlined SF→DC great-circle arc by pushing the interpolated position through map.setSourceData() every animation frame (the original\'s getSource().setData() loop). Stop pauses in place.',
    source: load('animate-point-route.xgis'),
    zoom: 3.4,
    center: [-99, 39],
    actions: (() => {
      // The inlined route vertices from animate-point-route.xgis — the host
      // loop interpolates between them; keep the two lists in sync.
      const ROUTE: Array<[number, number]> = [
        [-122.41, 37.78],
        [-121.07, 38.08],
        [-119.72, 38.36],
        [-118.35, 38.63],
        [-116.98, 38.89],
        [-115.6, 39.12],
        [-114.2, 39.35],
        [-112.8, 39.55],
        [-111.39, 39.74],
        [-109.98, 39.91],
        [-108.55, 40.06],
        [-107.12, 40.2],
        [-105.69, 40.32],
        [-104.25, 40.42],
        [-102.81, 40.5],
        [-101.36, 40.56],
        [-99.91, 40.61],
        [-98.46, 40.64],
        [-97.01, 40.65],
        [-95.56, 40.64],
        [-94.11, 40.61],
        [-92.66, 40.57],
        [-91.21, 40.51],
        [-89.77, 40.43],
        [-88.33, 40.33],
        [-86.89, 40.21],
        [-85.46, 40.08],
        [-84.04, 39.93],
        [-82.62, 39.76],
        [-81.21, 39.57],
        [-79.81, 39.37],
        [-78.42, 39.15],
        [-77.03, 38.91],
      ]
      const DURATION_MS = 10_000
      let raf = 0
      let t = 0 // route progress in [0, 1), survives Stop → Start resume
      const stop = (): void => {
        if (raf) cancelAnimationFrame(raf)
        raf = 0
      }
      return [
        {
          label: 'Start',
          run: (m) => {
            stop()
            // Bar is rebuilt on demo switch — die with the button (no ghost
            // rAF holding the destroyed map alive).
            const marker = document.querySelector('#demo-actions button')
            let last = performance.now()
            const tick = (now: number): void => {
              if (marker && !marker.isConnected) return stop()
              // The first rAF timestamp can precede the performance.now()
              // captured in the click handler — a negative delta would send
              // t below 0 and index ROUTE[-1], killing the loop on frame 1.
              t = (t + Math.max(0, now - last) / DURATION_MS) % 1
              last = now
              const f = t * (ROUTE.length - 1)
              const i = Math.floor(f)
              const a = ROUTE[i]
              const b = ROUTE[Math.min(i + 1, ROUTE.length - 1)]
              const k = f - i
              // setSourceData over updateFeature — the MapLibre original is
              // a getSource().setData() loop, so this is the faithful shape.
              // (Since #1235 gap 2, updateFeature CAN patch a .xgis-declared
              // source through its seeded FC; both forms work here.)
              m.setSourceData('marker', {
                type: 'FeatureCollection',
                features: [
                  {
                    type: 'Feature',
                    id: 1,
                    properties: {},
                    geometry: {
                      type: 'Point',
                      coordinates: [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k],
                    },
                  },
                ],
              })
              raf = requestAnimationFrame(tick)
            }
            raf = requestAnimationFrame(tick)
          },
        },
        { label: 'Stop', run: () => stop() },
      ]
    })(),
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
