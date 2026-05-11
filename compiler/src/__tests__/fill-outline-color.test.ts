// Mapbox `paint.fill-outline-color` → xgis stroke utilities on the
// same fill layer. The xgis polygon renderer paints fill + outline in
// the same pass, so Mapbox's "fill + 1px outline" semantic maps 1:1.
// Pre-fix the converter silently dropped the property — OFM Bright's
// `landcover-wood`, `building-top`, and `highway-area` lost their
// declared outlines.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('fill-outline-color conversion', () => {
  it('constant outline color emits stroke-<color> + stroke-1', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'wood',
        type: 'fill',
        source: 'v',
        'source-layer': 'landcover',
        paint: {
          'fill-color': '#cfe7c1',
          'fill-outline-color': '#5c8c4a',
        },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    expect(xgis).toContain('fill-#cfe7c1')
    expect(xgis).toContain('stroke-#5c8c4a')
    expect(xgis).toContain('stroke-1')
  })

  it('absent outline does NOT emit a stroke utility (no implicit outline)', () => {
    // Mapbox technically defaults outline to fill-color when fill-
    // antialias is true, but most real basemaps want no outline by
    // default. Emitting one implicitly would clutter every polygon.
    const style = {
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'park',
        type: 'fill',
        source: 'v',
        'source-layer': 'landuse',
        paint: { 'fill-color': '#e0e8d4' },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    expect(xgis).toContain('fill-#e0e8d4')
    expect(xgis).not.toMatch(/stroke-/)
  })

  it('interpolate-by-zoom outline color → bracket form + stroke-1', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'building',
        type: 'fill',
        source: 'v',
        'source-layer': 'building',
        paint: {
          'fill-color': '#d4d4d4',
          'fill-outline-color': ['interpolate', ['linear'], ['zoom'],
            13, '#999',
            18, '#555'],
        },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    expect(xgis).toMatch(/stroke-\[interpolate\(zoom, 13, #999, 18, #555\)\]/)
    expect(xgis).toContain('stroke-1')
  })

  it('OFM Bright "highway-area" pattern: fill + outline both present', () => {
    // Mirror the real OFM Bright layer shape. Both colour AND outline
    // expected on the output.
    const style = {
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'highway-area',
        type: 'fill',
        source: 'v',
        'source-layer': 'transportation',
        filter: ['==', ['get', 'class'], 'service'],
        paint: {
          'fill-color': '#f9f5ed',
          'fill-outline-color': '#dfdbd0',
        },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    expect(xgis).toContain('fill-#f9f5ed')
    expect(xgis).toContain('stroke-#dfdbd0')
    expect(xgis).toContain('stroke-1')
  })

  it('fill-extrusion does NOT pick up fill-outline-color', () => {
    // fill-extrusion paint property in Mapbox doesn't have an outline
    // concept — only fill layers do. Sanity that our switch keeps the
    // distinction.
    const style = {
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'building3d',
        type: 'fill-extrusion',
        source: 'v',
        'source-layer': 'building',
        paint: {
          'fill-extrusion-color': '#d4d4d4',
          // Hypothetical author error — Mapbox spec doesn't accept this
          // on fill-extrusion; we still shouldn't pick it up.
          'fill-outline-color': '#000',
        },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    expect(xgis).not.toMatch(/stroke-/)
  })
})
