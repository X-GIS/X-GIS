// Mapbox `symbol-placement: ["step", ["zoom"], v0, z1, v1, …]` →
// layer-split converter. Pre-fix the literal-string-only path picked
// the wrong placement at all zooms (always "point" since the array
// shape didn't match a known string). OFM Bright's three highway-
// shield layers use exactly this form so their road-shield labels
// rendered as static points instead of following the road at high
// zoom.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('symbol-placement step expansion', () => {
  it('expands ["step", ["zoom"], "point", 11, "line"] into two layers', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'highway-shield',
        type: 'symbol',
        source: 'v',
        'source-layer': 'transportation_name',
        layout: {
          'text-field': ['get', 'ref'],
          'symbol-placement': ['step', ['zoom'], 'point', 11, 'line'],
        },
        paint: { 'text-color': '#000' },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    expect(xgis).toMatch(/layer highway_shield_0\s*{[^}]*maxzoom: 11/)
    expect(xgis).toMatch(/layer highway_shield_1\s*{[^}]*minzoom: 11/)
    // First segment uses default "point" → no label-along-path utility.
    // Second segment uses "line" → label-along-path emitted.
    expect(xgis).toMatch(/highway_shield_1[\s\S]*?label-along-path/)
  })

  it('collapses adjacent same-value segments', () => {
    // OFM Bright us-interstate uses: ["step", ["zoom"], "point", 7, "line", 8, "line"].
    // The 7→line and 8→line segments collapse into one layer covering
    // minzoom 7..∞; the pre-step segment covers ..7 as "point".
    const style = {
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'us-interstate',
        type: 'symbol',
        source: 'v',
        'source-layer': 'transportation_name',
        layout: {
          'text-field': ['get', 'ref'],
          'symbol-placement': ['step', ['zoom'], 'point', 7, 'line', 8, 'line'],
        },
        paint: { 'text-color': '#000' },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    const matches = xgis.match(/layer us_interstate_\d+ \{/g) ?? []
    expect(matches.length).toBe(2)
    expect(xgis).toMatch(/layer us_interstate_0\s*{[^}]*maxzoom: 7/)
    expect(xgis).toMatch(/layer us_interstate_1\s*{[^}]*minzoom: 7/)
  })

  it('intersects step ranges with the outer layer minzoom/maxzoom', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'bounded-shield',
        type: 'symbol',
        source: 'v',
        'source-layer': 'transportation_name',
        minzoom: 9,
        maxzoom: 18,
        layout: {
          'text-field': ['get', 'ref'],
          'symbol-placement': ['step', ['zoom'], 'point', 11, 'line'],
        },
        paint: { 'text-color': '#000' },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    // Segment 0 (..11 default "point") should clamp minzoom to 9 (layer),
    // maxzoom to 11 (step boundary).
    expect(xgis).toMatch(/layer bounded_shield_0\s*{[^}]*minzoom: 9[^}]*maxzoom: 11/)
    // Segment 1 (11..∞ "line") should clamp maxzoom to 18 (layer).
    expect(xgis).toMatch(/layer bounded_shield_1\s*{[^}]*minzoom: 11[^}]*maxzoom: 18/)
  })

  it('literal-string placement still works (no split)', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'road-name',
        type: 'symbol',
        source: 'v',
        'source-layer': 'transportation_name',
        layout: {
          'text-field': ['get', 'name'],
          'symbol-placement': 'line',
        },
        paint: { 'text-color': '#000' },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    expect(xgis).toMatch(/layer road_name\s*{/)
    expect(xgis).not.toMatch(/road_name_0|road_name_1/)
    expect(xgis).toMatch(/label-along-path/)
  })

  it('non-zoom step input falls back to single layer (no split)', () => {
    // ["step", ["get", "rank"], …] — input isn't zoom so it's not a
    // layer-split candidate. The literal-string path still doesn't
    // match, so the placement effectively falls through to default
    // (point) — same as Mapbox's spec.
    const style = {
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'odd',
        type: 'symbol',
        source: 'v',
        'source-layer': 'X',
        layout: {
          'text-field': ['get', 'name'],
          'symbol-placement': ['step', ['get', 'rank'], 'point', 3, 'line'],
        },
        paint: { 'text-color': '#000' },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    expect(xgis).toMatch(/layer odd\s*{/)
    expect(xgis).not.toMatch(/odd_0|odd_1/)
  })
})
