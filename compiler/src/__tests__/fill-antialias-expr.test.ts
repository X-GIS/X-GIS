// Issue #1995 (ADR-0012 Phase A5) — `fill-antialias` authored as a ZOOM
// expression used to warn-and-drop, losing the authored value entirely
// (the property fell back to the spec default `true`):
//
//   Layer "landcover-wood" — fill-antialias zoom/data expression not
//   supported (only constant true/false) — dropped.
//
// The flag already rode a PER-FRAME uniform lane (VTR bakes
// `currentFillAntialias` per render() into the polygon uniform's spare
// cam_ecef_off_h.w lane), so the zoom form needs no new GPU surface — only
// a per-frame shape to feed that same lane. The converter now lifts the
// boolean `["step", ["zoom"], …]` form to a 0/1 `step(zoom, …)` binding
// (`fill-antialias-[step(zoom, 0, 9, 1)]`), lower turns it into a
// zoom-stepped PropertyShape<number> on RenderNode/ShowCommand.fillAntialias,
// and resolveShow evaluates it each frame (resolveSteppedShape).
//
// Out of scope, still warn+drop (no per-feature lane exists):
// data-driven (per-feature) fill-antialias, and any non-step zoom form.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { optimize } from '../ir/optimize'
import { emitCommands } from '../ir/emit-commands'

const HERE = dirname(fileURLToPath(import.meta.url))

/** The REAL authored witness: OFM Bright's `landcover-wood`. Read from the
 *  fixture (not transcribed) so this test cannot drift from the corpus it
 *  exists to cover. */
function ofmBrightFillAntialiasLayers(): Array<{ id: string; value: unknown }> {
  const style = JSON.parse(
    readFileSync(join(HERE, 'fixtures', 'openfreemap-bright.json'), 'utf8'),
  ) as { layers: Array<{ id: string; paint?: Record<string, unknown> }> }
  return style.layers
    .filter((l) => Array.isArray(l.paint?.['fill-antialias']))
    .map((l) => ({ id: l.id, value: l.paint!['fill-antialias'] }))
}

function convert(value: unknown): { out: string; warnings: string[] } {
  const warnings: string[] = []
  const out = convertMapboxStyle(
    {
      version: 8,
      sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
      layers: [
        {
          id: 'land',
          type: 'fill',
          source: 'v',
          'source-layer': 'land',
          paint: { 'fill-color': '#a0c0a0', 'fill-antialias': value },
        },
      ],
    } as never,
    { coverage: { sources: [], layers: [], warnings } },
  )
  return { out, warnings }
}

/** The shape that reaches the runtime: ShowCommand.fillAntialias. */
function showFillAntialias(value: unknown): unknown {
  const { out } = convert(value)
  const scene = lower(new Parser(new Lexer(out).tokenize()).parse())
  return emitCommands(optimize(scene)).shows[0]!.fillAntialias
}

const antialiasWarned = (warnings: string[]): boolean =>
  warnings.some((w) => /fill-antialias/i.test(w))

describe('fill-antialias zoom expression — corpus witness (OFM Bright)', () => {
  it('the fixture still authors exactly one zoom-expression fill-antialias layer', () => {
    // Guards the witness below: if OFM Bright ever authors a second one, this
    // fails so the new form is looked at rather than silently uncovered.
    expect(ofmBrightFillAntialiasLayers().map((l) => l.id)).toEqual(['landcover-wood'])
  })

  it('landcover-wood’s authored value converts with NO warning (fail-before: warn+drop)', () => {
    for (const { value } of ofmBrightFillAntialiasLayers()) {
      const { out, warnings } = convert(value)
      expect(antialiasWarned(warnings)).toBe(false)
      expect(out).toContain('fill-antialias-[step(zoom, 0, 9, 1)]')
    }
  })

  it('landcover-wood’s value reaches ShowCommand as a zoom-stepped 0/1 shape', () => {
    // `["step", ["zoom"], false, 9, true]` — false below z9, true from z9 up.
    // The ε-paired stops are extractStepZoomStops' encoding of a step in the
    // existing zoom-stop machinery; resolveSteppedShape picks the last stop
    // whose zoom <= cameraZoom, so z<9 -> 0 and z>=9 -> 1.
    for (const { value } of ofmBrightFillAntialiasLayers()) {
      expect(showFillAntialias(value)).toEqual({
        kind: 'zoom-interpolated',
        stops: [
          { zoom: 8.9999, value: 0 },
          { zoom: 9, value: 1 },
        ],
      })
    }
  })
})

describe('fill-antialias zoom expression — synthetic forms', () => {
  it('["step", ["zoom"], true, 10, false] (inverted) lifts to 1 -> 0', () => {
    const value = ['step', ['zoom'], true, 10, false]
    const { out, warnings } = convert(value)
    expect(antialiasWarned(warnings)).toBe(false)
    expect(out).toContain('fill-antialias-[step(zoom, 1, 10, 0)]')
    expect(showFillAntialias(value)).toEqual({
      kind: 'zoom-interpolated',
      stops: [
        { zoom: 9.9999, value: 1 },
        { zoom: 10, value: 0 },
      ],
    })
  })

  it('multi-boundary step keeps every boundary', () => {
    const value = ['step', ['zoom'], false, 5, true, 12, false]
    const { out, warnings } = convert(value)
    expect(antialiasWarned(warnings)).toBe(false)
    expect(out).toContain('fill-antialias-[step(zoom, 0, 5, 1, 12, 0)]')
    expect(showFillAntialias(value)).toEqual({
      kind: 'zoom-interpolated',
      stops: [
        { zoom: 4.9999, value: 0 },
        { zoom: 5, value: 1 },
        { zoom: 11.9999, value: 1 },
        { zoom: 12, value: 0 },
      ],
    })
  })

  it('v8-strict ["literal", …] wrappers on the input / values / stop keys lift too', () => {
    const { out, warnings } = convert([
      'step',
      ['literal', ['zoom']],
      ['literal', false],
      ['literal', 9],
      ['literal', true],
    ])
    expect(antialiasWarned(warnings)).toBe(false)
    expect(out).toContain('fill-antialias-[step(zoom, 0, 9, 1)]')
  })
})

describe('fill-antialias — forms that still warn + drop', () => {
  it('data-driven (per-feature) step still warns and emits no utility', () => {
    // No per-feature lane exists for the flag — deliberately unchanged.
    const { out, warnings } = convert(['step', ['get', 'kind'], false, 1, true])
    expect(antialiasWarned(warnings)).toBe(true)
    expect(out).not.toContain('fill-antialias-[')
  })

  it('["case", …] (non-step zoom form) still warns and emits no utility', () => {
    const { out, warnings } = convert(['case', ['>', ['zoom'], 9], true, false])
    expect(antialiasWarned(warnings)).toBe(true)
    expect(out).not.toContain('fill-antialias-[')
  })

  it('a step whose values are not booleans still warns (not a fill-antialias curve)', () => {
    const { out, warnings } = convert(['step', ['zoom'], 0, 9, 1])
    expect(antialiasWarned(warnings)).toBe(true)
    expect(out).not.toContain('fill-antialias-[')
  })
})

describe('fill-antialias — constant forms unchanged (regression)', () => {
  it('false still emits the flag utility, no warning, ShowCommand false', () => {
    const { out, warnings } = convert(false)
    expect(antialiasWarned(warnings)).toBe(false)
    expect(out).toContain('fill-antialias-false')
    expect(showFillAntialias(false)).toBe(false)
  })

  it('true / unauthored emit nothing and leave ShowCommand undefined', () => {
    const { out, warnings } = convert(true)
    expect(antialiasWarned(warnings)).toBe(false)
    expect(out).not.toContain('fill-antialias')
    expect(showFillAntialias(true)).toBeUndefined()
  })
})
