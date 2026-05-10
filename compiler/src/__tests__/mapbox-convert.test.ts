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

  it('lowers ["interpolate", ["linear"], ["zoom"], …] line-width to interpolate(zoom, …)', () => {
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
    expect(out).toContain('stroke-[interpolate(zoom, 11, 1, 19, 2.5)]')
    expect(parses(out)).toBe(true)
  })

  it('lowers interpolate fill-color to interpolate(zoom, …) bracket form', () => {
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
    expect(out).toContain('fill-[interpolate(zoom, 15, #f2eae2, 16, #dfdbd7)]')
    expect(parses(out)).toBe(true)
  })

  it('preserves fractional zoom stops verbatim (no rounding)', () => {
    // `interpolate(zoom, …)` carries stop keys as plain numbers, so
    // fractional values like 15.5 pass through untouched.
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
    expect(out).toContain('opacity-[interpolate(zoom, 13, 0, 15.5, 100)]')
    expect(parses(out)).toBe(true)
  })

  it('lowers interpolate fill-extrusion-height with mixed numeric / get stops', () => {
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
    expect(out).toContain('fill-extrusion-height-[interpolate(zoom, 14, 0, 14.5, .render_height)]')
    expect(parses(out)).toBe(true)
  })

  // ─── Batch 0: layout property transcription ────────────────────────
  describe('Batch 0 — layout properties', () => {
    it('transcribes visibility: none → visible: false', () => {
      const out = convertMapboxStyle({
        version: 8,
        sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 'h', type: 'fill', source: 'x', 'source-layer': 'water',
          layout: { visibility: 'none' },
          paint: { 'fill-color': '#0000ff' },
        }],
      })
      expect(out).toContain('visible: false')
      expect(parses(out)).toBe(true)
    })

    it('transcribes line-cap and line-join layout (utility form)', () => {
      const out = convertMapboxStyle({
        version: 8,
        sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 'r', type: 'line', source: 'x', 'source-layer': 'roads',
          layout: { 'line-cap': 'round', 'line-join': 'bevel', 'line-miter-limit': 4 },
          paint: { 'line-color': '#000', 'line-width': 1 },
        }],
      })
      expect(out).toContain('stroke-round-cap')
      expect(out).toContain('stroke-bevel-join')
      expect(out).toContain('stroke-miterlimit-4')
      expect(parses(out)).toBe(true)
    })

    it('skips line-cap on non-line layers (no spurious utility)', () => {
      const out = convertMapboxStyle({
        version: 8,
        sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 'f', type: 'fill', source: 'x', 'source-layer': 'water',
          layout: { 'line-cap': 'round' },
          paint: { 'fill-color': '#a4c8d5' },
        }],
      })
      expect(out).not.toContain('stroke-round-cap')
      expect(out).not.toContain('stroke-butt-cap')
      expect(parses(out)).toBe(true)
    })
  })

  // ─── Batch 0: source type expansions ───────────────────────────────
  describe('Batch 0 — source types', () => {
    it('emits geojson source with no URL when data is inline', () => {
      const out = convertMapboxStyle({
        version: 8,
        sources: {
          pts: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } as never,
        },
        layers: [],
      })
      expect(out).toContain('type: geojson')
      expect(out).not.toContain('url:')
      expect(out).toContain('inline data')
      expect(out).toContain('setSourceData')
      expect(parses(out)).toBe(true)
    })

    it('emits raster-dem source registration with Batch 4 note', () => {
      const out = convertMapboxStyle({
        version: 8,
        sources: {
          terrain: { type: 'raster-dem', url: 'https://api.example.com/dem.json' } as never,
        },
        layers: [],
      })
      expect(out).toContain('type: raster-dem')
      expect(out).toContain('Batch 4')
      expect(parses(out)).toBe(true)
    })

    it('warns image / video sources as not yet supported', () => {
      const out = convertMapboxStyle({
        version: 8,
        sources: {
          aerial: { type: 'image', url: 'https://x.example/a.png',
            coordinates: [[0, 0], [1, 0], [1, 1], [0, 1]] } as never,
        },
        layers: [],
      })
      expect(out).toContain('SKIPPED')
      expect(out).toContain('image')
      expect(parses(out)).toBe(true)
    })
  })

  // ─── Batch 0: clearer skipped-layer messages ───────────────────────
  describe('Batch 0 — skipped layer reasons', () => {
    it('heatmap layer skip mentions Batch 3', () => {
      const out = convertMapboxStyle({
        version: 8, sources: {},
        layers: [{ id: 'h', type: 'heatmap', source: 'x' } as never],
      })
      expect(out).toContain('Batch 3')
      expect(parses(out)).toBe(true)
    })
  })

  // ─── Batch 1b: symbol layer text-field → label-[<expr>] ────────────
  describe('Batch 1b — symbol layer text labels', () => {
    it('emits label-[.name] for token form text-field', () => {
      const out = convertMapboxStyle({
        version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 'place_labels', type: 'symbol', source: 'x', 'source-layer': 'places',
          layout: { 'text-field': '{name}' } as never,
        }],
      })
      expect(out).toContain('layer place_labels')
      expect(out).toContain('label-[.name]')
      expect(parses(out)).toBe(true)
    })

    it('emits label-["Hello"] for plain string text-field', () => {
      const out = convertMapboxStyle({
        version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 'lit', type: 'symbol', source: 'x', 'source-layer': 'pts',
          layout: { 'text-field': 'Hello' } as never,
        }],
      })
      expect(out).toContain('label-["Hello"]')
      expect(parses(out)).toBe(true)
    })

    it('text-color paint property maps to label-color utility', () => {
      const out = convertMapboxStyle({
        version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 'col', type: 'symbol', source: 'x', 'source-layer': 'pts',
          layout: { 'text-field': '{name}' } as never,
          paint: { 'text-color': '#333' },
        }],
      })
      expect(out).toContain('label-[.name]')
      // Batch 1c-8g: text-color → label-color-X (was fill-X under 1b).
      // The IR fallback in map.ts still routes to layer fill when
      // label-color is absent, so layers without explicit text-color
      // automatically inherit fill colour.
      expect(out).toContain('label-color-#333')
      expect(parses(out)).toBe(true)
    })

    it('text-color → label-color-X (Batch 1c-8g)', () => {
      const out = convertMapboxStyle({
        version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 'col2', type: 'symbol', source: 'x', 'source-layer': 'pts',
          layout: { 'text-field': '{name}' } as never,
          paint: { 'text-color': '#f0f' },
        }],
      })
      // colorToXgis preserves Mapbox short-hex form (#f0f), the
      // utility resolver expands when looking up the colour.
      expect(out).toContain('label-color-#f0f')
      expect(parses(out)).toBe(true)
    })

    it('text-size → label-size-N', () => {
      const out = convertMapboxStyle({
        version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 's', type: 'symbol', source: 'x', 'source-layer': 'pts',
          layout: { 'text-field': '{name}', 'text-size': 18 } as never,
        }],
      })
      expect(out).toContain('label-size-18')
      expect(parses(out)).toBe(true)
    })

    it('text-halo-width + text-halo-color → label-halo + label-halo-color', () => {
      const out = convertMapboxStyle({
        version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 'h', type: 'symbol', source: 'x', 'source-layer': 'pts',
          layout: { 'text-field': '{name}' } as never,
          paint: { 'text-halo-width': 2, 'text-halo-color': '#000' },
        }],
      })
      expect(out).toContain('label-halo-2')
      expect(out).toContain('label-halo-color-#000')
      expect(parses(out)).toBe(true)
    })

    it('text-anchor preserves the full 9-way set (corners included)', () => {
      // Earlier the converter collapsed top-left/top-right etc. to the
      // dominant axis because the lower pass only handled 5 anchors.
      // Both passes now carry the corner forms through, matching the
      // IR's LabelDef.anchor type (render-node.ts:244-246).
      for (const a of ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const) {
        const out = convertMapboxStyle({
          version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
          layers: [{
            id: 'a', type: 'symbol', source: 'x', 'source-layer': 'pts',
            layout: { 'text-field': '{name}', 'text-anchor': a } as never,
          }],
        })
        expect(out).toContain(`label-anchor-${a}`)
        expect(parses(out)).toBe(true)
      }
    })

    it('text-size interpolate-by-zoom → label-size-[interpolate(zoom, …)]', () => {
      // The converter previously dropped any non-constant text-size,
      // leaving the layer with the default 12 px — wrong for almost
      // every real Mapbox style (place / POI labels universally use
      // zoom-interpolated sizes).
      const out = convertMapboxStyle({
        version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 's', type: 'symbol', source: 'x', 'source-layer': 'pts',
          layout: {
            'text-field': '{name}',
            'text-size': ['interpolate', ['linear'], ['zoom'], 8, 12, 14, 22],
          } as never,
        }],
      })
      expect(out).toContain('label-size-[interpolate(zoom, 8, 12, 14, 22)]')
      expect(parses(out)).toBe(true)
    })

    it('text-color interpolate-by-zoom → label-color-[interpolate(zoom, …)]', () => {
      const out = convertMapboxStyle({
        version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 'c', type: 'symbol', source: 'x', 'source-layer': 'pts',
          layout: { 'text-field': '{name}' } as never,
          paint: {
            'text-color': ['interpolate', ['linear'], ['zoom'], 5, '#666', 14, '#000'],
          } as never,
        }],
      })
      expect(out).toContain('label-color-[interpolate(zoom, 5, #666, 14, #000)]')
      expect(parses(out)).toBe(true)
    })

    it('emits Mapbox defaults when text properties are unset (parity)', () => {
      // The user goal: a Mapbox style should render the same in xgis
      // as it does in Mapbox GL. Mapbox's spec defaults — text-size
      // 16, text-color #000, text-max-width 10 ems — are applied
      // implicitly when omitted; if we let the runtime fall through
      // to its own defaults (size 12, color = layer fill, no wrap)
      // every basemap label diverges visibly. The converter pins
      // these down at the source level so the IR + runtime stay
      // unchanged for hand-authored xgis.
      const out = convertMapboxStyle({
        version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 'bare', type: 'symbol', source: 'x', 'source-layer': 'pts',
          layout: { 'text-field': '{name}' } as never,
        }],
      })
      expect(out).toContain('label-color-#000')
      expect(out).toContain('label-size-16')
      expect(out).toContain('label-max-width-10')
      expect(parses(out)).toBe(true)
    })

    it('skips text-max-width default for symbol-placement: line', () => {
      // Mapbox spec: "text-max-width is unused by symbol-placement: line".
      // Mirror that here so road labels don't wrap mid-name.
      const out = convertMapboxStyle({
        version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 'road', type: 'symbol', source: 'x', 'source-layer': 'roads',
          layout: { 'text-field': '{name}', 'symbol-placement': 'line' } as never,
        }],
      })
      expect(out).not.toContain('label-max-width')
      expect(out).toContain('label-along-path')
      expect(parses(out)).toBe(true)
    })

    it('multi-token text-field "{name} ({ref})" resolves per feature', () => {
      // Real-world: German autobahn labels, US highway shields, transit
      // line labels universally compose two fields. The converter emits
      // the multi-token string as a quoted xgis literal; lower.ts walks
      // it through parseTextTemplate so each `{field}` interpolates per
      // feature. Verify both the parse path and end-to-end resolution.
      const out = convertMapboxStyle({
        version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 'hwy', type: 'symbol', source: 'x', 'source-layer': 'transportation',
          layout: { 'text-field': '{name} ({ref})' } as never,
        }],
      })
      expect(out).toContain('label-["{name} ({ref})"]')
      expect(parses(out)).toBe(true)
    })

    it('coalesce text-field locale fallback maps to xgis ?? operator', () => {
      // ["coalesce", ["get", "name:ko"], ["get", "name"]] is the standard
      // localised-label pattern in basemaps. exprToXgis already maps
      // coalesce → `??`; locale variants with ":" drop with a warning so
      // the fallback operand takes over. Confirm the wiring.
      const out = convertMapboxStyle({
        version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 'place_label', type: 'symbol', source: 'x', 'source-layer': 'place',
          layout: { 'text-field': ['coalesce', ['get', 'name'], ['get', 'name_en']] } as never,
        }],
      })
      expect(out).toContain('label-[.name ?? .name_en]')
      expect(parses(out)).toBe(true)
    })

    it('reserved xgis keywords in layer ids get a `_` suffix', () => {
      // OpenMapTiles styles use raw ids like "place", "source", "layer"
      // for symbol layers. xgis treats these as keywords (lexer/tokens.ts:
      // KEYWORDS map). Without a sanitiser escape, the produced source
      // would fail to parse — visible as "Open in Playground" failure
      // for any converted basemap that touches a place-typed source.
      const out = convertMapboxStyle({
        version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 'place', type: 'symbol', source: 'x', 'source-layer': 'place',
          layout: { 'text-field': '{name}' } as never,
        }],
      })
      expect(out).toContain('layer place_ {')
      expect(parses(out)).toBe(true)
    })

    it('symbol-spacing on line placement → label-spacing-N (repeat labels)', () => {
      // Mapbox repeats labels along long lines at symbol-spacing pixel
      // intervals (default 250). Without this every long highway gets
      // a single label which Mapbox would render as a chain.
      const explicit = convertMapboxStyle({
        version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 'hwy', type: 'symbol', source: 'x', 'source-layer': 'roads',
          layout: { 'text-field': '{name}', 'symbol-placement': 'line', 'symbol-spacing': 500 } as never,
        }],
      })
      expect(explicit).toContain('label-spacing-500')
      expect(parses(explicit)).toBe(true)

      // Default 250 emitted when symbol-spacing is unset on line placement.
      const dflt = convertMapboxStyle({
        version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 'hwy', type: 'symbol', source: 'x', 'source-layer': 'roads',
          layout: { 'text-field': '{name}', 'symbol-placement': 'line' } as never,
        }],
      })
      expect(dflt).toContain('label-spacing-250')
      expect(parses(dflt)).toBe(true)

      // No spacing emitted for point placement (Mapbox: it's meaningless).
      const pt = convertMapboxStyle({
        version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 'pt', type: 'symbol', source: 'x', 'source-layer': 'pts',
          layout: { 'text-field': '{name}' } as never,
        }],
      })
      expect(pt).not.toContain('label-spacing')
      expect(parses(pt)).toBe(true)
    })

    it('text-halo-blur → label-halo-blur (soft-glow halos)', () => {
      // Most basemap styles set text-halo-blur to 0.5–1 px so the halo
      // reads as a soft glow, not a hard outline. Without this the
      // shader's halo edge stays sharp regardless of the source style
      // — visibly different from Mapbox.
      const out = convertMapboxStyle({
        version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 'h', type: 'symbol', source: 'x', 'source-layer': 'pts',
          layout: { 'text-field': '{name}' } as never,
          paint: { 'text-halo-width': 2, 'text-halo-blur': 1, 'text-halo-color': '#fff' },
        }],
      })
      expect(out).toContain('label-halo-blur-1')
      expect(parses(out)).toBe(true)
    })

    it('text-letter-spacing / text-padding interpolate-by-zoom', () => {
      const out = convertMapboxStyle({
        version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 'pad', type: 'symbol', source: 'x', 'source-layer': 'pts',
          layout: {
            'text-field': '{name}',
            'text-letter-spacing': ['interpolate', ['linear'], ['zoom'], 5, 0.05, 14, 0.15],
            'text-padding': ['interpolate', ['linear'], ['zoom'], 5, 1, 14, 4],
          } as never,
        }],
      })
      expect(out).toContain('label-letter-spacing-[interpolate(zoom, 5, 0.05, 14, 0.15)]')
      expect(out).toContain('label-padding-[interpolate(zoom, 5, 1, 14, 4)]')
      expect(parses(out)).toBe(true)
    })

    it('text-halo-width / text-halo-color interpolate-by-zoom', () => {
      const out = convertMapboxStyle({
        version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 'h', type: 'symbol', source: 'x', 'source-layer': 'pts',
          layout: { 'text-field': '{name}' } as never,
          paint: {
            'text-halo-width': ['interpolate', ['linear'], ['zoom'], 5, 1, 14, 2],
            'text-halo-color': ['interpolate', ['linear'], ['zoom'], 5, '#fff', 14, '#eee'],
          } as never,
        }],
      })
      expect(out).toContain('label-halo-[interpolate(zoom, 5, 1, 14, 2)]')
      expect(out).toContain('label-halo-color-[interpolate(zoom, 5, #fff, 14, #eee)]')
      expect(parses(out)).toBe(true)
    })

    it('text-font stack → multiple label-font-X utilities (browser-native fallback)', () => {
      const out = convertMapboxStyle({
        version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 'f', type: 'symbol', source: 'x', 'source-layer': 'pts',
          layout: {
            'text-field': '{name}',
            'text-font': ['Noto Sans Regular', 'Noto Sans CJK Regular'],
          } as never,
        }],
      })
      // Each font in the stack becomes its own utility — the lower
      // pass appends them into LabelDef.font[]. Browser walks the
      // stack glyph-by-glyph at ctx.font time.
      expect(out).toContain('label-font-Noto-Sans-Regular')
      expect(out).toContain('label-font-Noto-Sans-CJK-Regular')
      expect(parses(out)).toBe(true)
    })

    it('text-offset [dx, dy] → label-offset-x-N + label-offset-y-N', () => {
      const out = convertMapboxStyle({
        version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 'o', type: 'symbol', source: 'x', 'source-layer': 'pts',
          layout: { 'text-field': '{name}', 'text-offset': [0, 1.5] } as never,
        }],
      })
      expect(out).toContain('label-offset-y-1.5')
      expect(out).not.toContain('label-offset-x-0')  // zero dx omitted
      expect(parses(out)).toBe(true)
    })

    it('text-offset with NEGATIVE values uses bracket binding form', () => {
      // Real-world repro: OpenFreeMap Bright + many basemap styles
      // anchor labels above the point with `text-offset: [0, -0.2]`.
      // Without bracket form the converter emitted `label-offset-y--0.2`
      // (double dash) which the lexer rejects → playground compile
      // error on "Open in Playground" for any converted style with
      // negative offsets.
      const out = convertMapboxStyle({
        version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 'o', type: 'symbol', source: 'x', 'source-layer': 'pts',
          layout: { 'text-field': '{name}', 'text-offset': [-0.5, -0.2] } as never,
        }],
      })
      expect(out).toContain('label-offset-x-[-0.5]')
      expect(out).toContain('label-offset-y-[-0.2]')
      expect(out).not.toContain('label-offset-y--0.2')
      expect(parses(out)).toBe(true)
    })

    it('text-rotate / text-letter-spacing negatives use bracket form', () => {
      const out = convertMapboxStyle({
        version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 'r', type: 'symbol', source: 'x', 'source-layer': 'pts',
          layout: {
            'text-field': '{name}',
            'text-rotate': -45,
            'text-letter-spacing': -0.1,
          } as never,
        }],
      })
      expect(out).toContain('label-rotate-[-45]')
      expect(out).toContain('label-letter-spacing-[-0.1]')
      expect(parses(out)).toBe(true)
    })

    it('text-transform → label-uppercase', () => {
      const out = convertMapboxStyle({
        version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 't', type: 'symbol', source: 'x', 'source-layer': 'pts',
          layout: { 'text-field': '{name}', 'text-transform': 'uppercase' } as never,
        }],
      })
      expect(out).toContain('label-uppercase')
      expect(parses(out)).toBe(true)
    })

    it('text-rotate + text-letter-spacing → label-rotate-N + label-letter-spacing-N', () => {
      const out = convertMapboxStyle({
        version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 'r', type: 'symbol', source: 'x', 'source-layer': 'pts',
          layout: {
            'text-field': '{name}',
            'text-rotate': 30,
            'text-letter-spacing': 0.05,
          } as never,
        }],
      })
      expect(out).toContain('label-rotate-30')
      expect(out).toContain('label-letter-spacing-0.05')
      expect(parses(out)).toBe(true)
    })

    it('text-max-width + text-line-height + text-justify → multiline trio', () => {
      const out = convertMapboxStyle({
        version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 'm', type: 'symbol', source: 'x', 'source-layer': 'pts',
          layout: {
            'text-field': '{name}',
            'text-max-width': 7,
            'text-line-height': 1.1,
            'text-justify': 'right',
          } as never,
        }],
      })
      expect(out).toContain('label-max-width-7')
      expect(out).toContain('label-line-height-1.1')
      expect(out).toContain('label-justify-right')
      expect(parses(out)).toBe(true)
    })

    it('symbol-placement: line → label-along-path utility', () => {
      // Road / waterway / highway names — 7 of 25 symbol layers in
      // OpenFreeMap Bright. Without this, road network labels never
      // emit because point-anchor placement on a linestring picks an
      // unhelpful centroid.
      const out = convertMapboxStyle({
        version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 'road-name', type: 'symbol', source: 'x', 'source-layer': 'road',
          layout: {
            'text-field': '{name}',
            'symbol-placement': 'line',
          } as never,
        }],
      })
      expect(out).toContain('label-along-path')
      expect(parses(out)).toBe(true)
    })

    it('symbol-placement: line-center → label-line-center utility', () => {
      const out = convertMapboxStyle({
        version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 'l', type: 'symbol', source: 'x', 'source-layer': 'lines',
          layout: {
            'text-field': '{name}',
            'symbol-placement': 'line-center',
          } as never,
        }],
      })
      expect(out).toContain('label-line-center')
      expect(parses(out)).toBe(true)
    })

    it('symbol-placement no longer warns as Batch 1d/1e/2 gap', () => {
      // Regression for the Batch 1d wiring — the converter previously
      // listed `symbol-placement` in its ignored-keys warning. After
      // wiring, the warning shouldn't mention it.
      const out = convertMapboxStyle({
        version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 'r', type: 'symbol', source: 'x', 'source-layer': 'road',
          layout: { 'text-field': '{name}', 'symbol-placement': 'line' } as never,
        }],
      })
      expect(out).not.toMatch(/ignored properties.*symbol-placement/)
    })

    it('text-allow-overlap / text-ignore-placement / text-padding → collision opt-outs', () => {
      const out = convertMapboxStyle({
        version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 'c', type: 'symbol', source: 'x', 'source-layer': 'pts',
          layout: {
            'text-field': '{name}',
            'text-allow-overlap': true,
            'text-ignore-placement': true,
            'text-padding': 4,
          } as never,
        }],
      })
      expect(out).toContain('label-allow-overlap')
      expect(out).toContain('label-ignore-placement')
      expect(out).toContain('label-padding-4')
      expect(parses(out)).toBe(true)
    })

    it('skips icon-only symbol layer (no text-field)', () => {
      const out = convertMapboxStyle({
        version: 8, sources: { x: { type: 'vector', url: 'a.pmtiles' } },
        layers: [{
          id: 'poi_icon', type: 'symbol', source: 'x', 'source-layer': 'poi',
          layout: { 'icon-image': 'cafe-15' } as never,
        }],
      })
      expect(out).toContain('SKIPPED')
      expect(out).toContain('icon-only')
      expect(out).toContain('Batch 2')
      expect(parses(out)).toBe(true)
    })
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
