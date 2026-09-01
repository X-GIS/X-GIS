// Issue #1994 — `["step", ["zoom"], base, z1, v1, …]` line-dasharray dropped,
// mislabeled `data-driven`. The classifier (paint-line.ts) bucketed every
// `step` as needing per-feature plumbing, but the runtime's dasharray
// resolver (resolveArrayShape, map/src/render/paint-shape-resolve.ts:230-236)
// already STEPS the interpolate-form binding to the LAST stop whose
// `zoom <= cameraZoom` — exactly Mapbox `step`'s own right-continuous
// semantics, regardless of which Mapbox expression authored the binding
// (dasharray is `interpolated: false` per spec either way). So a zoom-step
// source maps EXACTLY (not approximately) onto the SAME
// `stroke-dasharray-[interpolate(zoom, …)]` binding the interpolate-form
// and legacy-{stops} form (#1976) already use: the step's base sits at a
// sentinel zoom of 0 (camera zoom is never negative) and each (z_i, v_i)
// becomes its own stop.
//
// `["step", ["get", …]]` (a per-feature input) is genuinely data-driven and
// keeps dropping with that label. A `["step", ["zoom"], …]` that reaches the
// classifier means the lift declined for a malformed reason (a non-numeric
// stop key or a non-array stop value) — it must NOT carry the data-driven
// label, since the gap has nothing to do with per-feature plumbing.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { withPragma } from './_pragma'

function convert(layer: Record<string, unknown>): { out: string; warnings: string[] } {
  const warnings: string[] = []
  const out = convertMapboxStyle(
    {
      version: 8,
      sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
      layers: [layer],
    } as never,
    { coverage: { sources: [], layers: [], warnings } },
  )
  return { out, warnings }
}

function lineLayer(paint: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'l',
    type: 'line',
    source: 'v',
    'source-layer': 'r',
    paint: { 'line-color': '#ff0000', ...paint },
  }
}

const dashDrops = (warnings: string[]): string[] =>
  warnings.filter((w) => w.includes('paint.line-dasharray:'))

const dashBindingLines = (out: string): string[] =>
  out.split('\n').filter((l) => l.includes('stroke-dasharray-'))

describe('#1994 — zoom-step (`["step", ["zoom"], …]`) dasharray lifts to the interpolate binding', () => {
  it('1. one-stop step over zoom emits a stroke-dasharray-[interpolate(zoom, …)] binding containing both arrays; no drop warning', () => {
    const { out, warnings } = convert(
      lineLayer({
        'line-dasharray': ['step', ['zoom'], ['literal', [2, 2]], 15, ['literal', [4, 2]]],
      }),
    )
    expect(out).toContain('stroke-dasharray-[interpolate(zoom, 0, [2, 2], 15, [4, 2])]')
    expect(dashDrops(warnings)).toEqual([])
  })

  it('2. a 1-element base array normalizes to [a, a] (same repeat rule as the constant/interp paths)', () => {
    const { out, warnings } = convert(
      lineLayer({
        'line-dasharray': ['step', ['zoom'], ['literal', [1]], 14, ['literal', [2, 4]]],
      }),
    )
    expect(out).toContain('stroke-dasharray-[interpolate(zoom, 0, [1, 1], 14, [2, 4])]')
    expect(dashDrops(warnings)).toEqual([])
  })

  it('3. step over a per-feature input (["get", …]) still drops, labeled data-driven', () => {
    const { out, warnings } = convert(
      lineLayer({
        'line-dasharray': ['step', ['get', 'class'], ['literal', [1, 2]], 3, ['literal', [2, 4]]],
      }),
    )
    expect(out).not.toContain('stroke-dasharray-[')
    const drops = dashDrops(warnings)
    expect(drops.length).toBe(1)
    expect(drops[0]).toContain('data-driven (needs per-feature dash plumbing)')
  })

  it('4. malformed step over zoom (a non-array stop value) drops with a precise NON-data-driven label', () => {
    const { out, warnings } = convert(
      lineLayer({
        'line-dasharray': ['step', ['zoom'], ['literal', [2, 2]], 15, 'solid'],
      }),
    )
    expect(out).not.toContain('stroke-dasharray-[')
    const drops = dashDrops(warnings)
    expect(drops.length).toBe(1)
    expect(drops[0]).not.toContain('data-driven')
    expect(drops[0]).toContain('zoom-step (malformed stop values)')
  })

  it('5a. regression guard — constant dasharray array unchanged (one emitted line)', () => {
    const { out, warnings } = convert(lineLayer({ 'line-dasharray': [4, 2] }))
    const lines = dashBindingLines(out)
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('stroke-dasharray-4-2')
    expect(dashDrops(warnings)).toEqual([])
  })

  it('5b. regression guard — legacy {stops} dasharray (#1976) unchanged (one emitted line)', () => {
    const { out, warnings } = convert(
      lineLayer({
        'line-dasharray': {
          stops: [
            [15, [2, 2]],
            [18, [3, 3]],
          ],
        },
      }),
    )
    const lines = dashBindingLines(out)
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('stroke-dasharray-[interpolate(zoom, 15, [2, 2], 18, [3, 3])]')
    expect(dashDrops(warnings)).toEqual([])
  })

  it('5c. regression guard — modern ["interpolate"] dasharray unchanged (one emitted line)', () => {
    const { out, warnings } = convert(
      lineLayer({
        'line-dasharray': [
          'interpolate',
          ['linear'],
          ['zoom'],
          8,
          ['literal', [4, 2]],
          16,
          ['literal', [8, 2]],
        ],
      }),
    )
    const lines = dashBindingLines(out)
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('stroke-dasharray-[interpolate(zoom, 8, [4, 2], 16, [8, 2])]')
    expect(dashDrops(warnings)).toEqual([])
  })

  it('6. pipeline check — witness 1 emitted output really lowers to a dashArrayShape', () => {
    const { out, warnings } = convert(
      lineLayer({
        'line-dasharray': ['step', ['zoom'], ['literal', [2, 2]], 15, ['literal', [4, 2]]],
      }),
    )
    expect(dashDrops(warnings)).toEqual([])
    const tokens = new Lexer(withPragma(out)).tokenize()
    const ast = new Parser(tokens).parse()
    const scene = lower(ast)
    const node = scene.renderNodes[0]
    expect(node).toBeDefined()
    const shape = node!.stroke.dashArrayShape
    expect(shape).toBeDefined()
    expect(shape!.kind).toBe('zoom-interpolated')
    expect(shape!.stops).toEqual([
      { zoom: 0, value: [2, 2] },
      { zoom: 15, value: [4, 2] },
    ])
  })
})
