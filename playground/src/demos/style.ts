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

  zoom_building_color: {
    name: 'Buildings by Zoom',
    tag: 'style',
    description:
      'MapLibre example port (#1192): "Change building color based on zoom level" — protomaps buildings whose fill-[interpolate(zoom, …)] ramps parchment → terracotta as you zoom from city overview (z15) to street level (z17). Opens over lower Manhattan.',
    source: load('zoom-building-color.xgis'),
    zoom: 15.5,
    center: [-74.006, 40.712],
  },

  fit_bounds: {
    name: 'Fit Bounds',
    tag: 'style',
    description:
      'MapLibre "Fit a map to a bounding box" port (#1192) — action buttons call map.fitBounds([[west, south], [east, north]]) at runtime',
    source: load('fit-bounds.xgis'),
    actions: [
      {
        label: 'Australia',
        run: (m) =>
          m.fitBounds([
            [112.9, -43.7],
            [153.6, -10.6],
          ]),
      },
      {
        label: 'Western Europe',
        run: (m) =>
          m.fitBounds([
            [-9.5, 36.0],
            [15.0, 55.0],
          ]),
      },
      {
        label: 'World',
        run: (m) =>
          m.fitBounds([
            [-180, -60],
            [180, 75],
          ]),
      },
    ],
  },

  camera_around_point: {
    name: 'Rotating Camera',
    tag: 'style',
    description:
      'MapLibre "Animate map camera around a point" port (#1192) — Start drives map.setBearing() from a requestAnimationFrame loop (~12°/s) over a tilted Mediterranean view; Stop halts it. X-GIS has no rotateTo transition yet, so the host rAF loop IS the animation.',
    source: load('camera-around-point.xgis'),
    zoom: 4.5,
    center: [12.5, 42],
    pitch: 55,
    actions: (() => {
      let raf = 0
      const stop = (): void => {
        if (raf) cancelAnimationFrame(raf)
        raf = 0
      }
      return [
        {
          label: 'Start rotation',
          run: (m) => {
            stop()
            // The bar is rebuilt on demo switch — when this button leaves
            // the DOM, the loop must die with it (no ghost rAF holding the
            // destroyed map alive).
            const marker = document.querySelector('#demo-actions button')
            let last = performance.now()
            const tick = (now: number): void => {
              if (marker && !marker.isConnected) return stop()
              m.setBearing(m.getBearing() + (now - last) * 0.012)
              last = now
              raf = requestAnimationFrame(tick)
            }
            raf = requestAnimationFrame(tick)
          },
        },
        { label: 'Stop rotation', run: () => stop() },
      ]
    })(),
  },

  jump_to_locations: {
    name: 'Jump To Locations',
    tag: 'style',
    description:
      'MapLibre "Jump to a series of locations" port (#1192) — a single action button calls map.jumpTo({center, zoom}) at runtime, cycling through a fixed list of world cities',
    source: load('jump-to-locations.xgis'),
    actions: [
      {
        label: 'Jump to next city',
        run: (() => {
          const cities: Array<{ name: string; center: [number, number]; zoom: number }> = [
            { name: 'Seoul', center: [126.978, 37.5665], zoom: 10 },
            { name: 'Cairo', center: [31.2357, 30.0444], zoom: 10 },
            { name: 'Rio de Janeiro', center: [-43.1729, -22.9068], zoom: 10 },
            { name: 'Sydney', center: [151.2093, -33.8688], zoom: 10 },
            { name: 'New York', center: [-74.006, 40.7128], zoom: 10 },
          ]
          let idx = 0
          return (m) => {
            const city = cities[idx % cities.length]
            idx++
            m.jumpTo({ center: city.center, zoom: city.zoom })
          }
        })(),
      },
    ],
  },
}
