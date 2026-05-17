// Pin `layout.visibility: 'none'` propagation across EVERY layer type.
// Pre-fix the visibility gate lived only in the generic convertLayer
// path (line / fill / fill-extrusion), so a symbol or circle layer
// with `visibility: 'none'` rendered anyway because the converter
// never emitted `visible: false`. Style authors who hide a label
// layer by toggling visibility (common pattern for "hide all labels"
// UI toggles in Mapbox studio) saw the labels survive the export.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function emitSymbolWithVisibility(visibility: unknown): string {
  return convertMapboxStyle({
    version: 8,
    sources: { v: { type: 'vector', url: 'x.pmtiles' } },
    layers: [{
      id: 'hidden_label',
      type: 'symbol',
      source: 'v',
      'source-layer': 'place',
      layout: { 'text-field': '{name}', visibility },
    }],
  } as never)
}

function emitCircleWithVisibility(visibility: unknown): string {
  return convertMapboxStyle({
    version: 8,
    sources: { v: { type: 'vector', url: 'x.pmtiles' } },
    layers: [{
      id: 'hidden_circle',
      type: 'circle',
      source: 'v',
      'source-layer': 'poi',
      paint: { 'circle-color': '#f00', 'circle-radius': 4 },
      layout: { visibility },
    }],
  } as never)
}

function emitLineWithVisibility(visibility: unknown): string {
  return convertMapboxStyle({
    version: 8,
    sources: { v: { type: 'vector', url: 'x.pmtiles' } },
    layers: [{
      id: 'hidden_road',
      type: 'line',
      source: 'v',
      'source-layer': 'transportation',
      paint: { 'line-color': '#000', 'line-width': 2 },
      layout: { visibility },
    }],
  } as never)
}

describe('layout.visibility: "none" propagates as visible: false', () => {
  it('symbol layer — visibility: "none" emits visible: false', () => {
    const out = emitSymbolWithVisibility('none')
    expect(out).toMatch(/visible:\s*false/)
  })

  it('circle layer — visibility: "none" emits visible: false', () => {
    const out = emitCircleWithVisibility('none')
    expect(out).toMatch(/visible:\s*false/)
  })

  it('line layer — visibility: "none" emits visible: false (regression guard)', () => {
    const out = emitLineWithVisibility('none')
    expect(out).toMatch(/visible:\s*false/)
  })

  it('symbol layer — visibility: ["literal", "none"] (v8 strict) also gates', () => {
    // Pins v8 strict-tooling literal-wrap. Without unwrap the
    // unwrapLiteralScalar passthrough collapses to the bare "none"
    // string and visible: false emits the same way.
    const out = emitSymbolWithVisibility(['literal', 'none'])
    expect(out).toMatch(/visible:\s*false/)
  })

  it('circle layer — visibility: "visible" does NOT add visible: false', () => {
    const out = emitCircleWithVisibility('visible')
    expect(out).not.toMatch(/visible:\s*false/)
  })

  it('symbol layer — visibility omitted does NOT add visible: false', () => {
    const out = convertMapboxStyle({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'shown_label',
        type: 'symbol',
        source: 'v',
        'source-layer': 'place',
        layout: { 'text-field': '{name}' },
      }],
    } as never)
    expect(out).not.toMatch(/visible:\s*false/)
  })
})
