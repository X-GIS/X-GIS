// ═══════════════════════════════════════════════════════════════════
// A2 — conversion warnings reach the runtime console once at load
// ═══════════════════════════════════════════════════════════════════
//
// Bug: `convertMapboxStyle` records every dropped / approximated filter /
// paint as a trailing `/* Conversion notes (review before running): … */`
// block comment in the emitted .xgis source. The runtime lexer DISCARDS
// comments, so a user who loaded a converted .xgis in the playground got
// ZERO console output even when a filter was silently widened or a paint
// property dropped — a silent wrong render.
//
// Fix: at load, run() extracts the notes block straight off the raw
// source string and console.warns it once (behind the default-on
// XGISMapOptions.logConversionNotes flag). This test pins:
//   1. extractConversionNotes() pulls the bullet lines out of real
//      converter output (and returns null for a clean / hand-authored
//      source).
//   2. logConversionNotes() surfaces each note via console.warn (spy).
//   3. the XGISMapOptions.logConversionNotes flag defaults on + opts out.

import { describe, it, expect, vi } from 'vitest'
import { convertMapboxStyle } from '@xgis/compiler'
import { extractConversionNotes, logConversionNotes, XGISMap } from './map'

function mockCanvas(): HTMLCanvasElement {
  return { width: 1200, height: 800 } as unknown as HTMLCanvasElement
}

// A minimal Mapbox style whose ONE layer carries an unconvertible filter
// (`["distance", geom]` — no lowering) so the converter emits a notes
// block. Real-world shape: a basemap layer the converter can't fully
// honour. (`within` was used here until it gained CPU support — see
// compiler/src/__tests__/within-convert.test.ts.)
const STYLE_WITH_DROPPED_FILTER = {
  version: 8,
  name: 'drops-a-filter',
  sources: { osm: { type: 'vector', url: 'https://example.com/tiles.json' } },
  layers: [
    {
      id: 'water',
      type: 'fill',
      source: 'osm',
      'source-layer': 'water',
      filter: ['distance', { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }],
      paint: { 'fill-color': '#00f' },
    },
  ],
}

// A clean hand-authored source — no converter, no notes block.
const CLEAN_XGIS = `source osm { type: tilejson, url: "https://example.com/t.json" }\nlayer water { source: osm, fill: #00f }\n`

describe('A2: conversion notes surface at runtime', () => {
  it('the converter emits a Conversion notes block for a dropped filter', () => {
    const xgis = convertMapboxStyle(STYLE_WITH_DROPPED_FILTER)
    expect(xgis).toContain('/* Conversion notes')
    // The distance drop is recorded (filterToXgis pushes the warning,
    // and lands it in the block).
    expect(xgis).toMatch(/distance/i)
  })

  it('extractConversionNotes pulls the bullet lines out of real converter output', () => {
    const xgis = convertMapboxStyle(STYLE_WITH_DROPPED_FILTER)
    const notes = extractConversionNotes(xgis)
    expect(notes).not.toBeNull()
    expect((notes as string[]).length).toBeGreaterThan(0)
    // The notes carry the actual warning text, decoration stripped.
    expect((notes as string[]).some(n => /distance/i.test(n))).toBe(true)
    // No bullet / comment-frame leakage in the extracted lines.
    for (const n of notes as string[]) {
      expect(n).not.toMatch(/^\s*\*/)
      expect(n).not.toContain('•')
    }
  })

  it('returns null for a clean hand-authored source (no notes block)', () => {
    expect(extractConversionNotes(CLEAN_XGIS)).toBeNull()
  })

  it('logConversionNotes console.warns once per note (spy)', () => {
    const xgis = convertMapboxStyle(STYLE_WITH_DROPPED_FILTER)
    const notes = extractConversionNotes(xgis) as string[]
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      logConversionNotes(xgis)
      // One header line + one line per note.
      expect(warnSpy).toHaveBeenCalledTimes(notes.length + 1)
      // The warnings carry the convert tag + the dropped-filter text.
      const all = warnSpy.mock.calls.map(c => String(c[0])).join('\n')
      expect(all).toContain('[X-GIS convert]')
      expect(all).toMatch(/distance/i)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('logConversionNotes is a no-op (no warn) for a clean source', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      logConversionNotes(CLEAN_XGIS)
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('XGISMapOptions.logConversionNotes defaults on', () => {
    const map = new XGISMap(mockCanvas())
    const flag = (map as unknown as { _logConversionNotes: boolean })._logConversionNotes
    expect(flag).toBe(true)
  })

  it('XGISMapOptions.logConversionNotes: false opts out', () => {
    const map = new XGISMap(mockCanvas(), { logConversionNotes: false })
    const flag = (map as unknown as { _logConversionNotes: boolean })._logConversionNotes
    expect(flag).toBe(false)
  })
})
