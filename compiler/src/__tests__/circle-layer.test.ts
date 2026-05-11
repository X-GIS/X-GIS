// Mapbox `circle` layer → xgis point layer (the runtime's
// PointRenderer paints SDF disks natively). Pre-fix the converter
// SKIPPED every circle layer with a "use a point layer once point
// converter lands" warning — but the point converter HAS been here
// for a while. This wires Mapbox's paint properties onto the
// existing point-render path so circle styles convert end-to-end.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('circle layer conversion', () => {
  it('basic circle with radius + color emits size + fill', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'geojson', data: 'x.geojson' } },
      layers: [{
        id: 'cities',
        type: 'circle',
        source: 'v',
        paint: {
          'circle-radius': 6,
          'circle-color': '#ff5500',
        },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    expect(xgis).toContain('layer cities {')
    expect(xgis).toContain('size-6')
    expect(xgis).toContain('fill-#ff5500')
    expect(xgis).not.toContain('SKIPPED')
  })

  it('circle layer with stroke emits stroke-<color> + stroke-N', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'geojson', data: 'x.geojson' } },
      layers: [{
        id: 'cities',
        type: 'circle',
        source: 'v',
        paint: {
          'circle-radius': 5,
          'circle-color': '#fff',
          'circle-stroke-color': '#000',
          'circle-stroke-width': 1.5,
        },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    expect(xgis).toContain('size-5')
    expect(xgis).toContain('fill-#fff')
    expect(xgis).toContain('stroke-#000')
    expect(xgis).toContain('stroke-1.5')
  })

  it('absent radius falls back to Mapbox spec default (5)', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'geojson', data: 'x.geojson' } },
      layers: [{
        id: 'dots',
        type: 'circle',
        source: 'v',
        paint: { 'circle-color': '#369' },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    expect(xgis).toContain('size-5')
    expect(xgis).toContain('fill-#369')
  })

  it('absent color falls back to Mapbox spec default (#000)', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'geojson', data: 'x.geojson' } },
      layers: [{
        id: 'dots',
        type: 'circle',
        source: 'v',
        paint: { 'circle-radius': 3 },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    expect(xgis).toContain('fill-#000')
  })

  it('interpolate-by-zoom radius lowers to bracket form', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'geojson', data: 'x.geojson' } },
      layers: [{
        id: 'pop',
        type: 'circle',
        source: 'v',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'],
            0, 2,
            10, 12],
          'circle-color': '#c00',
        },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    expect(xgis).toMatch(/size-\[interpolate\(zoom, 0, 2, 10, 12\)\]/)
  })

  it('per-feature data-driven radius lowers to bracket form', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'geojson', data: 'x.geojson' } },
      layers: [{
        id: 'pop',
        type: 'circle',
        source: 'v',
        paint: {
          'circle-radius': ['get', 'magnitude'],
          'circle-color': '#c00',
        },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    expect(xgis).toMatch(/size-\[\.magnitude\]/)
  })

  it('opacity 0..1 scales to 0..100 (matching addOpacity)', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'geojson', data: 'x.geojson' } },
      layers: [{
        id: 'dots',
        type: 'circle',
        source: 'v',
        paint: {
          'circle-radius': 4,
          'circle-color': '#000',
          'circle-opacity': 0.5,
        },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    expect(xgis).toContain('opacity-50')
  })

  it('preserves filter + minzoom + maxzoom + source-layer', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'poi',
        type: 'circle',
        source: 'v',
        'source-layer': 'poi',
        minzoom: 12,
        maxzoom: 22,
        filter: ['==', ['get', 'class'], 'cafe'],
        paint: {
          'circle-radius': 3,
          'circle-color': '#a40',
        },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    expect(xgis).toContain('source: v')
    expect(xgis).toContain('sourceLayer: "poi"')
    expect(xgis).toContain('minzoom: 12')
    expect(xgis).toContain('maxzoom: 22')
    expect(xgis).toContain('filter: .class == "cafe"')
  })

  it('unsupported properties surface as warnings', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'geojson', data: 'x.geojson' } },
      layers: [{
        id: 'fancy',
        type: 'circle',
        source: 'v',
        paint: {
          'circle-radius': 5,
          'circle-color': '#000',
          'circle-blur': 0.5,
          'circle-translate': [2, -3],
        },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    // Conversion notes trailer should mention the dropped props.
    expect(xgis).toMatch(/circle-blur/)
    expect(xgis).toMatch(/circle-translate/)
  })
})
