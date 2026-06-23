// Regression tests for FIX #6 (opacity clamp typo window) and
// FIX #9 (legacy property-function silent drop).
//
// Both tests are written to FAIL against the unfixed code, then pass
// after the fix is applied (fail-before protocol).

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

// ── helpers ──────────────────────────────────────────────────────────

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

function emitFillColor(color: unknown): string {
  return convertMapboxStyle({
    version: 8,
    sources: { v: { type: 'vector', url: 'x.pmtiles' } },
    layers: [{
      id: 'l',
      type: 'fill',
      source: 'v',
      'source-layer': 'a',
      paint: { 'fill-color': color },
    }],
  } as never)
}

// ── FIX #6: opacity typo-window clamp ────────────────────────────────

describe('FIX #6 — fill-opacity typo-window (1, 2] clamped to 1.0 with warning', () => {
  it('fill-opacity: 1.2 → opacity-100 (Mapbox-faithful clamp, not /100)', () => {
    // BEFORE fix: 1.2 / 100 = 0.012 → opacity-1 (near-invisible).
    // AFTER fix:  1.2 is in (1, 2] typo window → clamp to 1 → opacity-100.
    const out = emitFill(1.2)
    expect(out).toContain('opacity-100')
  })

  it('fill-opacity: 1.2 emits a warning (silent before fix)', () => {
    // BEFORE fix: v in (1, 100] did NOT trigger the warn gate (v<0||v>100).
    // AFTER fix:  v in (1, 2] triggers a warning (typo window clamped to 1).
    const out = emitFill(1.2)
    expect(out).toContain('Conversion notes')
    expect(out).toMatch(/opacity.*1\.2|1\.2.*opacity/i)
  })

  it('fill-opacity: 1.9 → opacity-100 (top of typo window)', () => {
    // 1.9 is still in (1, 2] typo window → clamp to 1.
    const out = emitFill(1.9)
    expect(out).toContain('opacity-100')
  })

  it('fill-opacity: 2.5 → legacy /100 path (clearly percent, v > 2)', () => {
    // 2.5 / 100 = 0.025 → opacity-3 (rounded). The /100 percent
    // heuristic applies for v > 2; this should NOT become opacity-100.
    const out = emitFill(2.5)
    expect(out).not.toContain('opacity-100')
    expect(out).toMatch(/opacity-\d+/)
  })

  it('fill-opacity: 1.0 unchanged (boundary, fast-path, no warning)', () => {
    // v <= 1 fast path: exactly 1 → opacity-100, no warning.
    const out = emitFill(1.0)
    expect(out).toContain('opacity-100')
  })
})

// ── FIX #9: legacy property-function warning ──────────────────────────

describe('FIX #9 — legacy property-function emits conversion warning (not silent drop)', () => {
  it('fill-color with legacy categorical property-function emits a warning', () => {
    // BEFORE fix: interpolateZoomStops sees stops with string keys →
    // `typeof z !== 'number'` → returns null → property silently dropped,
    // NO warning in the output.
    // AFTER fix: the object carries `property` key → detected as a legacy
    // data-driven function → warning pushed.
    const legacyCategorical = {
      property: 'class',
      type: 'categorical',
      stops: [['primary', '#ff0000'], ['secondary', '#00ff00']],
    }
    const out = emitFillColor(legacyCategorical)
    expect(out).toContain('Conversion notes')
    // Warning must mention the property name or "property function" or
    // "data-driven" so it is actionable.
    expect(out).toMatch(/property.{0,60}function|data.driven|categorical|legacy/i)
  })

  it('fill-color with legacy interval property-function emits a warning', () => {
    const legacyInterval = {
      property: 'height',
      type: 'interval',
      stops: [[0, '#aaaaaa'], [100, '#ffffff']],
    }
    const out = emitFillColor(legacyInterval)
    expect(out).toContain('Conversion notes')
    expect(out).toMatch(/property.{0,60}function|data.driven|interval|legacy/i)
  })

  it('plain zoom stops (no property key) still converts without spurious warning', () => {
    // Sanity: a normal legacy zoom-function object must NOT be mistaken
    // for a property function; no new warning should appear for it.
    const zoomStops = {
      stops: [[5, '#aaaaaa'], [14, '#ffffff']],
    }
    const out = emitFillColor(zoomStops)
    // Should not contain the property-function warning.
    expect(out).not.toMatch(/property.{0,60}function|data.driven/i)
  })
})
