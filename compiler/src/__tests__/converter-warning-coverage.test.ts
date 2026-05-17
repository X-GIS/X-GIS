// Pin: each "silently dropped property" warning class fires exactly
// where expected. The conversion-notes block is the only user-visible
// signal for properties that the converter drops without an IR-side
// equivalent — a regression that removes any of these warnings is a
// silent-drop regression, and the tests below catch it.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function warningsOf(style: unknown): string[] {
  const out = convertMapboxStyle(style as never)
  const lines = out.split('\n')
  const warnings: string[] = []
  let inNotes = false
  for (const l of lines) {
    if (l.includes('Conversion notes')) { inNotes = true; continue }
    if (l.trim() === '*/') { inNotes = false; continue }
    if (inNotes && l.includes('• ')) warnings.push(l.split('• ')[1] ?? '')
  }
  return warnings
}

describe('converter warning coverage', () => {
  it('fill-pattern without fill-color → Batch 2 warning', () => {
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'wetland',
        type: 'fill',
        source: 'v',
        'source-layer': 'landcover',
        paint: { 'fill-pattern': 'wetland_bg_11' },
      }],
    })
    expect(w.some(s => s.includes('wetland') && s.includes('fill-pattern')))
      .toBe(true)
  })

  it('line-pattern without line-color → Batch 2 warning', () => {
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'road_pattern',
        type: 'line',
        source: 'v',
        'source-layer': 'transportation',
        paint: { 'line-pattern': 'dashed_white' },
      }],
    })
    expect(w.some(s => s.includes('road_pattern') && s.includes('line-pattern')))
      .toBe(true)
  })

  it('fill-pattern WITH fill-color → no warning (pattern is supplement)', () => {
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'park',
        type: 'fill',
        source: 'v',
        'source-layer': 'park',
        paint: { 'fill-color': '#0f0', 'fill-pattern': 'park_dots' },
      }],
    })
    expect(w.some(s => s.includes('fill-pattern declared without')))
      .toBe(false)
  })

  it('source scheme: "tms" → Y-flip warning', () => {
    const w = warningsOf({
      version: 8,
      sources: {
        legacy: {
          type: 'raster',
          tiles: ['https://example.com/{z}/{x}/{y}.png'],
          scheme: 'tms',
        },
      },
      layers: [{ id: 'r', type: 'raster', source: 'legacy' }],
    })
    expect(w.some(s => s.includes('legacy') && s.includes('tms')))
      .toBe(true)
  })

  it('multiple tile mirrors → subdomain-rotation warning', () => {
    const w = warningsOf({
      version: 8,
      sources: {
        m: {
          type: 'raster',
          tiles: [
            'https://a.example.com/{z}/{x}/{y}.png',
            'https://b.example.com/{z}/{x}/{y}.png',
            'https://c.example.com/{z}/{x}/{y}.png',
          ],
        },
      },
      layers: [{ id: 'r', type: 'raster', source: 'm' }],
    })
    expect(w.some(s => s.includes('"m"') && s.includes('mirrors')))
      .toBe(true)
  })

  it('top-level projection / fog / light / terrain → ignored-fields warning', () => {
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [],
      projection: { type: 'globe' },
      fog: { range: [0.5, 10] },
      light: { intensity: 0.3 },
    })
    expect(w.some(s => s.startsWith('Top-level style fields ignored'))).toBe(true)
    const note = w.find(s => s.startsWith('Top-level style fields ignored'))!
    for (const k of ['projection', 'fog', 'light']) {
      expect(note, `expected "${k}" in: ${note}`).toContain(k)
    }
  })

  it('GeoJSON source clustering → conversion-notes warning', () => {
    // Pins 754e4b9 — the five Mapbox cluster fields surface as a
    // single per-source warning so style authors know X-GIS has no
    // clustering pipeline.
    const w = warningsOf({
      version: 8,
      sources: {
        poi: {
          type: 'geojson',
          data: 'https://example.com/poi.geojson',
          cluster: true,
          clusterRadius: 50,
          clusterMaxZoom: 14,
        },
      },
      layers: [{ id: 'p', type: 'circle', source: 'poi' }],
    })
    expect(w.some(s => s.includes('"poi"') && s.includes('clustering')))
      .toBe(true)
  })

  it('GeoJSON source tuning fields → ignored-tuning warning', () => {
    // Pins e700bd0 — tolerance / buffer / lineMetrics / generateId
    // each surface in the consolidated note.
    const w = warningsOf({
      version: 8,
      sources: {
        lines: {
          type: 'geojson',
          data: 'https://example.com/roads.geojson',
          tolerance: 0.3,
          buffer: 128,
          lineMetrics: true,
          generateId: true,
        },
      },
      layers: [{ id: 'l', type: 'line', source: 'lines' }],
    })
    const note = w.find(s => s.includes('"lines"') && s.includes('ignored tuning fields'))
    expect(note, `expected ignored-tuning note: ${JSON.stringify(w)}`).toBeDefined()
    for (const k of ['tolerance', 'buffer', 'lineMetrics', 'generateId']) {
      expect(note, `expected "${k}" in: ${note}`).toContain(k)
    }
  })

  it('source minzoom / maxzoom / bounds → unhandled-bounds warnings', () => {
    // Pins bc32a5c (minzoom/maxzoom) + 39a3cee (bounds).
    const w = warningsOf({
      version: 8,
      sources: {
        regional: {
          type: 'raster',
          tiles: ['https://example.com/{z}/{x}/{y}.png'],
          minzoom: 4,
          maxzoom: 12,
          bounds: [125, 33, 132, 39],
        },
      },
      layers: [{ id: 'r', type: 'raster', source: 'regional' }],
    })
    expect(w.some(s => s.includes('"regional"') && s.includes('minzoom/maxzoom')))
      .toBe(true)
    expect(w.some(s => s.includes('"regional"') && s.includes('bounds')))
      .toBe(true)
  })

  it('interpolate-lab colour spec → "approximated as linear-RGB" warning', () => {
    // Pins e66e095 — Mapbox v3 perceptually-uniform colour interp
    // accepted with a graceful linear-RGB downgrade.
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'lab_fade',
        type: 'fill',
        source: 'v',
        'source-layer': 'landuse',
        paint: {
          'fill-color': ['interpolate-lab', ['linear'], ['zoom'],
            0, '#fff',
            18, '#888'],
        },
      }],
    })
    expect(w.some(s => s.includes('interpolate-lab') && s.includes('linear-RGB')))
      .toBe(true)
  })

  it('interpolate-hcl colour spec → "approximated as linear-RGB" warning', () => {
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'hcl_fade',
        type: 'fill',
        source: 'v',
        'source-layer': 'landuse',
        paint: {
          'fill-color': ['interpolate-hcl', ['linear'], ['zoom'],
            0, '#f00',
            18, '#00f'],
        },
      }],
    })
    expect(w.some(s => s.includes('interpolate-hcl') && s.includes('linear-RGB')))
      .toBe(true)
  })

  it('source "type": "pmtiles" routes through to xgis pmtiles source', () => {
    // Pins 1c61b9f — Protomaps community-extension shape ("type":
    // "pmtiles" instead of "vector" + .pmtiles URL detection) must
    // emit a real pmtiles source block, not the terminal
    // "unsupported source type" warning.
    const out = convertMapboxStyle({
      version: 8,
      sources: {
        protomaps: {
          type: 'pmtiles',
          url: 'https://example.com/regions.pmtiles',
        },
      },
      layers: [{
        id: 'water',
        type: 'fill',
        source: 'protomaps',
        'source-layer': 'water',
        paint: { 'fill-color': '#aef' },
      }],
    } as never)
    expect(out, 'xgis output should declare a pmtiles source').toMatch(/source\s+protomaps\s*\{[^}]*type:\s*pmtiles/)
    // And the layer block survives the conversion (sanity that the
    // dropped-source path isn't re-routed here).
    expect(out).toContain('layer water')
    // No "unsupported source type" warning either.
    const w = warningsOf({
      version: 8,
      sources: { protomaps: { type: 'pmtiles', url: 'https://example.com/x.pmtiles' } },
      layers: [],
    })
    expect(w.some(s => s.includes('"protomaps"') && s.includes('unsupported type'))).toBe(false)
  })

  it('background-opacity / background-pattern → ignored-properties warning', () => {
    // Pins 00f8834.
    const w = warningsOf({
      version: 8,
      sources: {},
      layers: [{
        id: 'bg',
        type: 'background',
        paint: {
          'background-color': '#f8f4f0',
          'background-opacity': 0.7,
          'background-pattern': 'paper',
        },
      }],
    })
    const note = w.find(s => s.includes('"bg"') && s.includes('ignored properties'))
    expect(note, `expected background ignored-properties note: ${JSON.stringify(w)}`).toBeDefined()
    expect(note).toContain('background-opacity')
    expect(note).toContain('background-pattern')
  })

  it('GeoJSON promoteId → reserved-id warning', () => {
    // Pins f8aed39.
    const w = warningsOf({
      version: 8,
      sources: {
        d: {
          type: 'geojson',
          data: 'https://example.com/d.geojson',
          promoteId: 'osm_id',
        },
      },
      layers: [{ id: 'l', type: 'circle', source: 'd' }],
    })
    expect(w.some(s => s.includes('"d"') && s.includes('promoteId'))).toBe(true)
  })

  it('source tileSize: 256 → wrong-zoom-scale warning', () => {
    // Pins 20af7b6.
    const w = warningsOf({
      version: 8,
      sources: {
        relief: {
          type: 'raster',
          tiles: ['https://example.com/ne2/{z}/{x}/{y}.png'],
          tileSize: 256,
        },
      },
      layers: [{ id: 'r', type: 'raster', source: 'relief' }],
    })
    expect(w.some(s => s.includes('"relief"') && s.includes('tileSize: 256')))
      .toBe(true)
  })

  it('fill-extrusion-base non-zero → unhonoured-base warning', () => {
    // Pins 4682b0d.
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'floating_building',
        type: 'fill-extrusion',
        source: 'v',
        'source-layer': 'building',
        paint: {
          'fill-extrusion-height': 40,
          'fill-extrusion-base': 10,
          'fill-extrusion-color': '#888',
        },
      }],
    })
    expect(w.some(s => s.includes('"floating_building"') && s.includes('fill-extrusion-base')))
      .toBe(true)
  })

  it('fill-extrusion-base: 0 → no unhonoured warning', () => {
    // Default 0 is the no-op case; the warning would be noise.
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'ground_building',
        type: 'fill-extrusion',
        source: 'v',
        'source-layer': 'building',
        paint: {
          'fill-extrusion-height': 40,
          'fill-extrusion-base': 0,
          'fill-extrusion-color': '#888',
        },
      }],
    })
    expect(w.some(s => s.includes('ground_building') && s.includes('fill-extrusion-base')))
      .toBe(false)
  })

  it('literal-wrapped line-dasharray emits the dash utility (no warning)', () => {
    // Mapbox v8 `["literal", [4, 2]]` wraps the bare-array shape.
    // Pre-fix the operator-string guard treated "literal" as an
    // expression and fell through to the non-constant warning. Now
    // unwrapped before the numeric check so the modern form behaves
    // identically to the legacy `[4, 2]` shape.
    const out = convertMapboxStyle({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'literal_dash',
        type: 'line',
        source: 'v',
        'source-layer': 'transportation',
        paint: {
          'line-color': '#000',
          'line-dasharray': ['literal', [4, 2]],
        },
      }],
    } as never)
    expect(out, 'literal-wrapped dasharray should emit stroke-dasharray-4-2')
      .toContain('stroke-dasharray-4-2')
    // No "non-constant" warning either.
    expect(out.includes('paint.line-dasharray: non-constant')).toBe(false)
  })

  it('literal-wrapped text-offset emits label-offset utilities', () => {
    // Pins 7986ea5 — Mapbox v8 `["literal", [0, -1.5]]` shape used to
    // fail the numeric-tuple check (outer length === 2 but offset[0]
    // === "literal" string). Now unwrapped before the check.
    const out = convertMapboxStyle({
      version: 8,
      sources: {},
      layers: [{
        id: 'wrapped',
        type: 'symbol',
        source: 'x',
        layout: {
          'text-field': 'A',
          'text-offset': ['literal', [0, -1.5]],
        },
      }],
    } as never)
    // Negative y should ride the bracket binding form per fmtSigned.
    expect(out).toMatch(/label-offset-y-\[-1\.5\]/)
  })

  it('literal-wrapped icon-offset survives conversion', () => {
    const out = convertMapboxStyle({
      version: 8,
      sources: {},
      layers: [{
        id: 'shield',
        type: 'symbol',
        source: 'x',
        layout: {
          'icon-image': 'shield',
          'icon-offset': ['literal', [3, 4]],
        },
      }],
    } as never)
    expect(out).toContain('label-icon-offset-x-3')
    expect(out).toContain('label-icon-offset-y-4')
  })

  it('["to-color", hex] unwraps to constant fill utility', () => {
    // Pins 51bfaf1 — `["to-color", "#aef"]` should emit `fill-#aef`,
    // not collapse to a per-feature bracket-binding eval.
    const out = convertMapboxStyle({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'to_color_fill',
        type: 'fill',
        source: 'v',
        'source-layer': 'park',
        paint: { 'fill-color': ['to-color', '#aef'] },
      }],
    } as never)
    expect(out).toContain('fill-#aef')
    expect(out).not.toMatch(/fill-\["#aef"\]/)
  })

  it('literal-wrapped fill-color → constant fill utility (not data-driven)', () => {
    // Pins the colors.ts literal-unwrap. Mapbox v8 `["literal", "#fff"]`
    // pre-fix fell to exprToXgis as a quoted string and emitted
    // `fill-["#fff"]` (a data-driven bracket binding) — wasteful eval
    // per-feature. Now unwrapped to the constant `fill-#fff` utility.
    const out = convertMapboxStyle({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'literal_fill',
        type: 'fill',
        source: 'v',
        'source-layer': 'park',
        paint: { 'fill-color': ['literal', '#aef'] },
      }],
    } as never)
    // Constant fill, not bracket binding.
    expect(out).toContain('fill-#aef')
    expect(out).not.toMatch(/fill-\["#aef"\]/)
  })

  it('literal-wrapped text-variable-anchor-offset pairs survive', () => {
    // Pins 8db3d26 — the VAO inner [x, y] can be literal-wrapped per
    // Mapbox v8. Pre-fix the bare-array check failed and the
    // anchor + offset silently dropped.
    const out = convertMapboxStyle({
      version: 8,
      sources: {},
      layers: [{
        id: 'vao_literal',
        type: 'symbol',
        source: 'x',
        layout: {
          'text-field': 'L',
          'text-variable-anchor-offset': [
            'top', ['literal', [0, -1]],
            'bottom', ['literal', [0, 1]],
          ],
        },
      }],
    } as never)
    expect(out).toContain('label-anchor-top')
    expect(out).toContain('label-anchor-bottom')
    expect(out).toMatch(/label-vao-0-y-\[-1\]/)
    expect(out).toMatch(/label-vao-1-y-1/)
  })

  it('zoom-interp line-dasharray → non-constant warning', () => {
    // Pins ccb126b — addStrokeDash warns on the non-array shape
    // (interpolate-by-zoom dasharray that the IR has no consumer for
    // today).
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'dashed_zoom',
        type: 'line',
        source: 'v',
        'source-layer': 'transportation',
        paint: {
          'line-color': '#000',
          'line-dasharray': ['interpolate', ['linear'], ['zoom'],
            8, ['literal', [4, 2]],
            16, ['literal', [8, 2]]],
        },
      }],
    })
    expect(w.some(s => s.includes('paint.line-dasharray') && s.includes('non-constant')))
      .toBe(true)
  })

  it('glyphs / sprite must NOT appear in the top-level warning (host-integration handled)', () => {
    // Regression for 2819cd6 — these used to be flagged here even
    // though the playground importers forward them via setGlyphsUrl /
    // setSpriteUrl.
    const w = warningsOf({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [],
      glyphs: 'https://example.com/fonts/{fontstack}/{range}.pbf',
      sprite: 'https://example.com/sprites/standard',
    })
    const note = w.find(s => s.startsWith('Top-level style fields ignored'))
    if (note) {
      expect(note).not.toContain('glyphs')
      expect(note).not.toContain('sprite')
    }
  })
})
