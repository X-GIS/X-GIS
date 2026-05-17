// Lock in the null-as-omit contract added in iterations 158-164.
// Mapbox spec: a paint value of null falls back to the property
// default. Pre-fix the `null` literal lowering (a969be5) made
// every paint helper emit `fill-[null]` / `opacity-[null]` etc.
// The null-as-omit sweep across paint.ts + layers.ts now early-
// returns on null so the default-emission paths fire.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function emitFill(fillColor: unknown): string {
  return convertMapboxStyle({
    version: 8,
    sources: { v: { type: 'vector', url: 'x.pmtiles' } },
    layers: [{
      id: 'l',
      type: 'fill',
      source: 'v',
      'source-layer': 'water',
      paint: { 'fill-color': fillColor },
    }],
  } as never)
}

function emitCircle(paint: Record<string, unknown>): string {
  return convertMapboxStyle({
    version: 8,
    sources: { v: { type: 'vector', url: 'x.pmtiles' } },
    layers: [{
      id: 'l',
      type: 'circle',
      source: 'v',
      'source-layer': 'poi',
      paint,
    }],
  } as never)
}

function emitSymbol(paint: Record<string, unknown>, layout: Record<string, unknown> = {}): string {
  return convertMapboxStyle({
    version: 8,
    sources: { v: { type: 'vector', url: 'x.pmtiles' } },
    layers: [{
      id: 'l',
      type: 'symbol',
      source: 'v',
      'source-layer': 'place',
      paint,
      layout: { 'text-field': '{name}', ...layout },
    }],
  } as never)
}

describe('null paint values omit per Mapbox spec', () => {
  it('fill-color: null does NOT emit fill-[null]', () => {
    const out = emitFill(null)
    expect(out).not.toMatch(/fill-\[null\]/)
  })

  it('fill-color: "#abc" still emits (regression guard)', () => {
    expect(emitFill('#abc')).toMatch(/fill-#abc/)
  })

  it('circle-radius: null falls back to spec default 5', () => {
    const out = emitCircle({ 'circle-color': '#f00', 'circle-radius': null })
    expect(out).toMatch(/size-5/)
    expect(out).not.toMatch(/size-\[null\]/)
  })

  it('circle-opacity: null does NOT emit opacity-[null]', () => {
    const out = emitCircle({ 'circle-color': '#f00', 'circle-opacity': null })
    expect(out).not.toMatch(/opacity-\[null\]/)
  })

  it('circle-stroke-color: null does NOT emit stroke-[null]', () => {
    const out = emitCircle({
      'circle-color': '#f00',
      'circle-stroke-color': null,
      'circle-stroke-width': 1,
    })
    expect(out).not.toMatch(/stroke-\[null\]/)
  })

  it('text-color: null does NOT emit label-color-[null]', () => {
    const out = emitSymbol({ 'text-color': null })
    expect(out).not.toMatch(/label-color-\[null\]/)
  })

  it('text-size: null does NOT emit label-size-[null]', () => {
    const out = emitSymbol({}, { 'text-field': '{name}', 'text-size': null })
    expect(out).not.toMatch(/label-size-\[null\]/)
  })
})
