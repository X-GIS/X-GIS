// Mapbox style → xgis converter. Smoke covers the common shapes
// (sources, simple fill/line/extrude layers, expressions).
//
// We assert two layers of correctness:
//   1. The emitted output PARSES (the Lexer + Parser don't choke).
//   2. Specific structures land where expected (extrude utility,
//      filter shape, source kind).

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'

function parses(src: string): boolean {
  try {
    const tokens = new Lexer(src).tokenize()
    new Parser(tokens).parse()
    return true
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('parse fail:', (e as Error).message, '\n---\n', src)
    return false
  }
}

describe('Mapbox → xgis converter', () => {
  it('converts background color', () => {
    const out = convertMapboxStyle({
      version: 8,
      name: 'demo',
      sources: {},
      layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#eef' } }],
    })
    expect(out).toContain('background { fill: #eef }')
  })

  it('converts a vector source pointing at .pmtiles', () => {
    const out = convertMapboxStyle({
      version: 8,
      sources: { osm: { type: 'vector', url: 'https://x.example/v4.pmtiles' } },
      layers: [],
    })
    expect(out).toContain('source osm {')
    expect(out).toContain('type: pmtiles')
    expect(out).toContain('url: "https://x.example/v4.pmtiles"')
  })

  it('converts a vector source pointing at a TileJSON URL (no extension) → type: tilejson', () => {
    // Common shape — Mapbox-style URL points at a TileJSON manifest
    // (e.g., https://tiles.openfreemap.org/planet) without a file
    // extension. Used to emit `type: pmtiles  // TODO`, which the
    // runtime then fell through into the GeoJSON fetch path and
    // crashed. Now declares `tilejson` so the runtime routes through
    // attachPMTilesSource.
    const out = convertMapboxStyle({
      version: 8,
      sources: { om: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } },
      layers: [],
    })
    expect(out).toContain('type: tilejson')
    expect(out).toContain('url: "https://tiles.openfreemap.org/planet"')
    // Old failure mode — TODO comment polluting the source — must be gone.
    expect(out).not.toContain('// TODO: verify')
  })

  it('converts a simple fill layer with filter', () => {
    const out = convertMapboxStyle({
      version: 8,
      sources: { s: { type: 'vector', url: 'a.pmtiles' } },
      layers: [{
        id: 'parks', type: 'fill', source: 's', 'source-layer': 'landuse',
        filter: ['==', 'kind', 'park'],
        paint: { 'fill-color': '#cfe7c1' },
      }],
    })
    expect(out).toContain('layer parks {')
    expect(out).toContain('source: s')
    expect(out).toContain('sourceLayer: "landuse"')
    expect(out).toContain('filter: .kind == "park"')
    expect(out).toContain('fill-#cfe7c1')
    expect(parses(out)).toBe(true)
  })

  it('converts a line layer with width + dasharray', () => {
    const out = convertMapboxStyle({
      version: 8,
      sources: { s: { type: 'vector', url: 'a.pmtiles' } },
      layers: [{
        id: 'rail', type: 'line', source: 's', 'source-layer': 'roads',
        filter: ['==', 'kind', 'rail'],
        paint: { 'line-color': '#888', 'line-width': 1.5, 'line-dasharray': [4, 2] },
      }],
    })
    expect(out).toContain('stroke-#888')
    expect(out).toContain('stroke-1.5')
    expect(out).toContain('stroke-dasharray-4-2')
  })

  it('converts fill-extrusion with [get,height] → fill-extrusion-height-[.height]', () => {
    const out = convertMapboxStyle({
      version: 8,
      sources: { s: { type: 'vector', url: 'a.pmtiles' } },
      layers: [{
        id: 'b', type: 'fill-extrusion', source: 's', 'source-layer': 'buildings',
        paint: {
          'fill-extrusion-color': '#ddd',
          'fill-extrusion-height': ['get', 'height'],
          'fill-extrusion-base': ['get', 'min_height'],
        },
      }],
    })
    expect(out).toContain('fill-extrusion-height-[.height]')
    expect(out).toContain('fill-extrusion-base-[.min_height]')
  })

  it('converts coalesce → ??', () => {
    const out = convertMapboxStyle({
      version: 8,
      sources: { s: { type: 'vector', url: 'a.pmtiles' } },
      layers: [{
        id: 'b', type: 'fill-extrusion', source: 's', 'source-layer': 'buildings',
        paint: {
          'fill-extrusion-height': ['coalesce', ['get', 'height'], 50],
        },
      }],
    })
    expect(out).toContain('fill-extrusion-height-[.height ?? 50]')
  })

  it('converts ["match", get(kind), …] to xgis match()', () => {
    const out = convertMapboxStyle({
      version: 8,
      sources: { s: { type: 'vector', url: 'a.pmtiles' } },
      layers: [{
        id: 'land', type: 'fill', source: 's', 'source-layer': 'landuse',
        paint: {
          'fill-color': ['match', ['get', 'kind'],
            'park', '#cfe7c1',
            'water', '#a4c8d5',
            '#dadada',
          ],
        },
      }],
    })
    // Mapbox `match` to colour is a non-trivial mapping; converter
    // currently warns rather than emit. Verify the warning surface.
    expect(out).toMatch(/Color expression not converted|match\(/)
  })

  it('skips unsupported layer types with a comment', () => {
    const out = convertMapboxStyle({
      version: 8,
      sources: {},
      layers: [{ id: 'labels', type: 'symbol' }],
    })
    expect(out).toContain('// SKIPPED layer "labels" type="symbol"')
  })

  it('drops $type pseudo-field from filter (legacy form)', () => {
    const out = convertMapboxStyle({
      version: 8,
      sources: { s: { type: 'vector', url: 'a.pmtiles' } },
      layers: [{
        id: 'roads', type: 'line', source: 's', 'source-layer': 'roads',
        filter: ['all', ['==', '$type', 'LineString'], ['==', 'kind', 'highway']],
        paint: { 'line-color': '#888' },
      }],
    })
    // $type only allowed inside the trailing /* Conversion notes */ block.
    const filterLine = out.split('\n').find(l => l.trim().startsWith('filter:')) ?? ''
    expect(filterLine).not.toContain('$type')
    expect(out).toContain('.kind == "highway"')
    expect(parses(out)).toBe(true)
  })

  it('drops ["geometry-type"] pseudo-accessor (expression form)', () => {
    const out = convertMapboxStyle({
      version: 8,
      sources: { s: { type: 'vector', url: 'a.pmtiles' } },
      layers: [{
        id: 'water', type: 'fill', source: 's', 'source-layer': 'water',
        filter: ['all',
          ['==', ['geometry-type'], 'Polygon'],
          ['==', ['get', 'kind'], 'lake'],
        ],
        paint: { 'fill-color': '#a4c8d5' },
      }],
    })
    const filterLine = out.split('\n').find(l => l.trim().startsWith('filter:')) ?? ''
    expect(filterLine).not.toContain('geometry-type')
    expect(out).toContain('.kind == "lake"')
    expect(parses(out)).toBe(true)
  })

  it('handles legacy !in', () => {
    const out = convertMapboxStyle({
      version: 8,
      sources: { s: { type: 'vector', url: 'a.pmtiles' } },
      layers: [{
        id: 'misc', type: 'fill', source: 's', 'source-layer': 'landuse',
        filter: ['!in', 'kind', 'park', 'forest'],
        paint: { 'fill-color': '#eee' },
      }],
    })
    expect(out).toContain('.kind != "park"')
    expect(out).toContain('.kind != "forest"')
    expect(parses(out)).toBe(true)
  })

  it('lowers boolean ["match"] in filter to OR chain', () => {
    const out = convertMapboxStyle({
      version: 8,
      sources: { s: { type: 'vector', url: 'a.pmtiles' } },
      layers: [{
        id: 'land', type: 'fill', source: 's', 'source-layer': 'landuse',
        // Standard "is one of" idiom: match returns boolean.
        filter: ['match', ['get', 'class'],
          ['neighbourhood', 'residential'], true,
          false,
        ],
        paint: { 'fill-color': '#eee' },
      }],
    })
    expect(out).toContain('.class == "neighbourhood" || .class == "residential"')
    expect(out).not.toContain('match(.class)')
    expect(parses(out)).toBe(true)
  })

  it('lowers boolean ["match"] with default=true to AND-of-not chain', () => {
    const out = convertMapboxStyle({
      version: 8,
      sources: { s: { type: 'vector', url: 'a.pmtiles' } },
      layers: [{
        id: 'r', type: 'fill', source: 's', 'source-layer': 'roads',
        filter: ['match', ['get', 'kind'], 'rail', false, true],
        paint: { 'fill-color': '#eee' },
      }],
    })
    expect(out).toContain('.kind != "rail"')
    expect(parses(out)).toBe(true)
  })

  it('resolves CSS hsla() colours to hex so utility names parse', () => {
    const out = convertMapboxStyle({
      version: 8,
      sources: { s: { type: 'vector', url: 'a.pmtiles' } },
      layers: [{
        id: 'commercial', type: 'fill', source: 's', 'source-layer': 'landuse',
        paint: { 'fill-color': 'hsla(0,60%,87%,0.23)' },
      }],
    })
    // Should not contain the raw `fill-hsla(...)` form (parens are
    // not valid in xgis utility names).
    expect(out).not.toMatch(/fill-hsla/)
    expect(out).toMatch(/fill-#[0-9a-f]+/)
    expect(parses(out)).toBe(true)
  })

  it('lowers ["interpolate", ["linear"], ["zoom"], …] line-width to z<n>:stroke-<v>', () => {
    const out = convertMapboxStyle({
      version: 8,
      sources: { s: { type: 'vector', url: 'a.pmtiles' } },
      layers: [{
        id: 'rd', type: 'line', source: 's', 'source-layer': 'roads',
        paint: {
          'line-color': '#888',
          'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1, 19, 2.5],
        },
      }],
    })
    expect(out).toContain('z11:stroke-1')
    expect(out).toContain('z19:stroke-2.5')
    expect(parses(out)).toBe(true)
  })

  it('lowers interpolate fill-color to per-zoom fill stops', () => {
    const out = convertMapboxStyle({
      version: 8,
      sources: { s: { type: 'vector', url: 'a.pmtiles' } },
      layers: [{
        id: 'b', type: 'fill', source: 's', 'source-layer': 'building',
        paint: {
          'fill-color': ['interpolate', ['linear'], ['zoom'], 15, '#f2eae2', 16, '#dfdbd7'],
        },
      }],
    })
    expect(out).toContain('z15:fill-#f2eae2')
    expect(out).toContain('z16:fill-#dfdbd7')
    expect(parses(out)).toBe(true)
  })

  it('preserves fractional zoom stops (parser supports z15.5:)', () => {
    // The lexer + parser were extended to accept fractional zoom
    // modifiers — the lexer still splits `z15.5:` into four tokens
    // (Identifier Dot Number Colon) but parseUtilityItem stitches
    // them back. Stops survive verbatim.
    const out = convertMapboxStyle({
      version: 8,
      sources: { s: { type: 'vector', url: 'a.pmtiles' } },
      layers: [{
        id: 'b', type: 'fill', source: 's', 'source-layer': 'building',
        paint: {
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0, 15.5, 1],
        },
      }],
    })
    expect(out).toContain('z13:opacity-0')
    expect(out).toContain('z15.5:opacity-100')
    expect(parses(out)).toBe(true)
  })

  it('lowers interpolate fill-extrusion-height to per-zoom extrude stops', () => {
    const out = convertMapboxStyle({
      version: 8,
      sources: { s: { type: 'vector', url: 'a.pmtiles' } },
      layers: [{
        id: 'b', type: 'fill-extrusion', source: 's', 'source-layer': 'building',
        paint: {
          'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14, 0, 14.5, ['get', 'render_height']],
        },
      }],
    })
    expect(out).toContain('z14:fill-extrusion-height-0')
    expect(out).toContain('fill-extrusion-height-[.render_height]')
    expect(parses(out)).toBe(true)
  })

  it('emits parseable output for a multi-layer style', () => {
    const out = convertMapboxStyle({
      version: 8,
      name: 'multi',
      sources: { osm: { type: 'vector', url: 'a.pmtiles' } },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#fafafa' } },
        {
          id: 'water', type: 'fill', source: 'osm', 'source-layer': 'water',
          paint: { 'fill-color': '#a4c8d5' },
        },
        {
          id: 'roads', type: 'line', source: 'osm', 'source-layer': 'roads',
          filter: ['==', 'kind', 'highway'],
          paint: { 'line-color': '#cc8800', 'line-width': 2 },
        },
        {
          id: 'b', type: 'fill-extrusion', source: 'osm', 'source-layer': 'buildings',
          paint: {
            'fill-extrusion-color': '#dddddd',
            'fill-extrusion-height': ['coalesce', ['get', 'height'], 50],
            'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0],
          },
        },
      ],
    })
    expect(parses(out)).toBe(true)
  })
})
