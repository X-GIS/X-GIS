// Pin the Mapbox `0..1` → xgis `0..100` opacity-scale conversion the
// converter does inside addOpacity (paint.ts). A regression that
// flipped the scale (e.g. emitted opacity-1 for fill-opacity: 1
// thinking xgis takes 0..1) would render everything ~1% opacity at
// the runtime resolver — invisible / near-invisible map. Pin a few
// canonical values + the legacy 0..100 passthrough.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function emitFill(opacity: unknown): string {
  return convertMapboxStyle({
    version: 8,
    sources: { v: { type: 'vector', url: 'x.pmtiles' } },
    layers: [{
      id: 'l',
      type: 'fill',
      source: 'v',
      'source-layer': 'a',
      paint: { 'fill-color': '#000', 'fill-opacity': opacity },
    }],
  } as never)
}

describe('opacity scale conversion (Mapbox 0..1 → xgis 0..100)', () => {
  it('fill-opacity: 1 → opacity-100 (full opacity)', () => {
    expect(emitFill(1)).toContain('opacity-100')
  })

  it('fill-opacity: 0.5 → opacity-50', () => {
    expect(emitFill(0.5)).toContain('opacity-50')
  })

  it('fill-opacity: 0 → opacity-0 (transparent)', () => {
    expect(emitFill(0)).toContain('opacity-0')
  })

  it('fill-opacity: 0.25 → opacity-25', () => {
    expect(emitFill(0.25)).toContain('opacity-25')
  })

  it('fill-opacity: 50 (legacy 0..100 form) → opacity-50 passthrough', () => {
    // The legacy 0..100 form was used by older Mapbox styles; the
    // `v <= 1 ? *100 : v` heuristic in addOpacity catches both shapes.
    expect(emitFill(50)).toContain('opacity-50')
  })

  it('fill-opacity: ["literal", 0.5] → opacity-50 (v8 wrapper unwrapped)', () => {
    // Pins the addOpacity literal-unwrap. Pre-fix the v8-wrapped 0.5
    // fell through to exprToXgis and emitted `opacity-0.5` (0.5% in
    // the 0..100 scale) instead of the correct opacity-50.
    expect(emitFill(['literal', 0.5])).toContain('opacity-50')
  })

  it('interpolate-by-zoom with literal-wrapped stop values resolves correctly', () => {
    // Pins c1954f4 — each stop value can be wrapped in ["literal",
    // …] per Mapbox v8 strict-tooling output. The whole interpolate
    // used to fail with one null-callback return; now each stop is
    // unwrapped at the per-stop emit site.
    const out = convertMapboxStyle({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'wrapped_stops',
        type: 'line',
        source: 'v',
        'source-layer': 'transportation',
        paint: {
          'line-color': '#000',
          'line-width': ['interpolate', ['linear'], ['zoom'],
            10, ['literal', 1],
            16, ['literal', 8]],
        },
      }],
    } as never)
    // Both stops should resolve to numeric values inside the
    // interpolate(zoom, …) call.
    expect(out).toMatch(/interpolate\(zoom,\s*10,\s*1,\s*16,\s*8\)/)
  })

  it('legacy {stops:[[zoom, ["literal", v]]]} resolves like bare stops', () => {
    // Pins 6b00f20 — Mapbox v0/v1 `{stops: [[zoom, value], …]}` shape
    // can carry literal-wrapped values too. Now unwrapped at the
    // legacy-stops branch of interpolateZoomStops.
    const out = convertMapboxStyle({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'legacy_stops',
        type: 'line',
        source: 'v',
        'source-layer': 'transportation',
        paint: {
          'line-color': '#000',
          'line-width': {
            stops: [[10, ['literal', 2]], [16, ['literal', 6]]],
          } as never,
        },
      }],
    } as never)
    expect(out).toMatch(/interpolate\(zoom,\s*10,\s*2,\s*16,\s*6\)/)
  })

  it('literal-wrapped line-width → bare numeric stroke utility', () => {
    // Pins the addStrokeWidth unwrap. `["literal", 3]` should emit
    // `stroke-3`, not the data-driven bracket form.
    const out = convertMapboxStyle({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'wrapped_width',
        type: 'line',
        source: 'v',
        'source-layer': 'transportation',
        paint: { 'line-color': '#000', 'line-width': ['literal', 3] },
      }],
    } as never)
    expect(out).toContain('stroke-3')
    expect(out).not.toMatch(/stroke-\["3"\]/)
  })

  it('literal-wrapped fill-extrusion-height emits bare utility', () => {
    const out = convertMapboxStyle({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'wrapped_height',
        type: 'fill-extrusion',
        source: 'v',
        'source-layer': 'building',
        paint: {
          'fill-extrusion-color': '#888',
          'fill-extrusion-height': ['literal', 40],
        },
      }],
    } as never)
    expect(out).toContain('fill-extrusion-height-40')
  })

  it('zoom-interpolated fill-opacity stops scale individually', () => {
    const out = convertMapboxStyle({
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [{
        id: 'l',
        type: 'fill',
        source: 'v',
        'source-layer': 'a',
        paint: {
          'fill-color': '#000',
          'fill-opacity': ['interpolate', ['linear'], ['zoom'],
            10, 0.2,
            16, 0.8],
        },
      }],
    } as never)
    // Both stops should scale to 0..100 inside the binding.
    expect(out).toMatch(/interpolate\(zoom,\s*10,\s*20,\s*16,\s*80\)/)
  })
})
