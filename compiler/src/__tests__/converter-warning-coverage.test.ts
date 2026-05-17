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
