// Regression: Mapbox `text-halo-width: N` WITHOUT a matching
// `text-halo-color` declaration. Pre-fix lower.ts defaulted to
// `[0, 0, 0, 1]` (OPAQUE black), painting a hard black outline
// around every grey label. Most visible on OFM Bright at z > 12.2
// where `highway-name-major` (text-color: #666, text-halo-width: 1,
// no text-halo-color) first appears — the user saw the road names as
// fat black smudges rather than legible grey labels.
//
// Mapbox spec default for `text-halo-color` is `rgba(0,0,0,0)`
// (transparent black). So a halo-width without a halo-color must
// render NO visible halo — pinning that default here.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle, Lexer, Parser, lower, emitCommands } from '../index'

describe('label halo defaults — Mapbox spec compliance', () => {
  it('text-halo-width WITHOUT text-halo-color → halo.color alpha == 0', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'roads',
        type: 'symbol' as const,
        source: 'v',
        'source-layer': 'transportation_name',
        layout: { 'text-field': '{name}', 'text-size': 12 },
        paint: {
          'text-color': '#666',
          'text-halo-width': 1,
          // NB: no text-halo-color — Mapbox default rgba(0,0,0,0)
        },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    const cmds = emitCommands(lower(new Parser(new Lexer(xgis).tokenize()).parse()))
    const s = cmds.shows[0] as unknown as { label?: { halo?: { color: number[]; width: number } } }
    expect(s.label?.halo, 'halo struct should exist (width was set)').toBeDefined()
    // The CRITICAL invariant: halo alpha is 0, not 1. Anything else
    // paints a visible halo where Mapbox would render none.
    expect(s.label!.halo!.color[3], `halo color: ${JSON.stringify(s.label!.halo!.color)}`).toBe(0)
  })

  it('text-halo-color explicit → respected', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'roads',
        type: 'symbol' as const,
        source: 'v',
        'source-layer': 'transportation_name',
        layout: { 'text-field': '{name}', 'text-size': 12 },
        paint: {
          'text-color': '#666',
          'text-halo-width': 1,
          'text-halo-color': '#f8f4f0',
        },
      }],
    }
    const xgis = convertMapboxStyle(style as never)
    const cmds = emitCommands(lower(new Parser(new Lexer(xgis).tokenize()).parse()))
    const s = cmds.shows[0] as unknown as { label?: { halo?: { color: number[] } } }
    expect(s.label!.halo!.color[3]).toBeCloseTo(1, 2)
    expect(s.label!.halo!.color[0]).toBeCloseTo(0xf8 / 255, 2)
  })

  it('OFM Bright highway-name-major (z > 12.2 trigger): halo alpha == 0', () => {
    // The user-reported case: at z=12.2 the highway-name-major layer
    // first appears, and prior to the lower.ts fix every road label
    // got an opaque black halo because text-halo-color was omitted.
    const style = require('./fixtures/openfreemap-bright.json')
    const xgis = convertMapboxStyle(style)
    const cmds = emitCommands(lower(new Parser(new Lexer(xgis).tokenize()).parse()))
    const offenders: string[] = []
    type S = { layerName: string; label?: { halo?: { color: number[] } } }
    // Build a map keyed by the EXACT Mapbox layer.id. The converter
    // preserves the source ID into ShowCommand.layerName verbatim
    // (the underscore vs hyphen difference is upstream — `label_city`
    // and `highway-name-major` both round-trip).
    // The converter rewrites `-` to `_` in layer IDs so the xgis
    // DSL parses them as bare identifiers (hyphens aren't legal in
    // layer-name tokens). Build the lookup against the normalised
    // form so highway-name-major and label_city both round-trip.
    const srcById = new Map<string, { paint?: Record<string, unknown> }>()
    for (const L of style.layers) srcById.set(L.id.replace(/-/g, '_'), L)
    for (const s of cmds.shows as unknown as S[]) {
      if (!s.label?.halo) continue
      const srcLayer = srcById.get(s.layerName)
      const hasExplicitHaloColor = srcLayer?.paint?.['text-halo-color'] !== undefined
      if (!hasExplicitHaloColor && s.label.halo.color[3] !== 0) {
        offenders.push(`${s.layerName} halo=${JSON.stringify(s.label.halo.color)}`)
      }
    }
    expect(offenders, `Labels with implicit halo getting opaque fallback: ${offenders.join(' / ')}`).toEqual([])
  })
})
