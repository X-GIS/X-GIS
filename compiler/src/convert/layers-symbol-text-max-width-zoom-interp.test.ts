// #2320: a non-constant text-max-width (zoom-interpolate or legacy stops)
// must not be silently replaced by the spec default 10 em. Correct
// behaviour mirrors the sibling text-padding / text-letter-spacing arms:
// emit a zoom-interpolated `label-max-width-[interpolate(zoom, …)]`,
// never `label-max-width-10` for an authored non-constant value.
import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from './mapbox-to-xgis'
import { Lexer, Parser, lower, emitCommands } from '../index'

function convert(layout: Record<string, unknown>): { out: string; warnings: string[] } {
  const coverage = { sources: [], layers: [], warnings: [] as string[] }
  const out = convertMapboxStyle(
    {
      version: 8,
      sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
      layers: [
        {
          id: 'lbl',
          type: 'symbol',
          source: 'v',
          'source-layer': 'a',
          layout: { 'text-field': '{name}', ...layout },
        },
      ],
    } as never,
    { coverage },
  )
  return { out, warnings: coverage.warnings }
}

/** Convert → lex → parse → lower → emit, so a converter arm is measured by
 *  what reaches the runtime rather than by the utility string alone: a
 *  `label-max-width-[…]` nobody lowers would leave LabelDef.maxWidth
 *  undefined, which text-stage.ts reads as "no wrap at any zoom". */
function lowered(layout: Record<string, unknown>): {
  maxWidth: number | undefined
  droppedBindings: string[]
} {
  const scene = lower(new Parser(new Lexer(convert(layout).out).tokenize()).parse())
  const cmds = emitCommands(scene) as unknown as {
    shows: Array<{ label?: { maxWidth?: number } }>
  }
  return {
    maxWidth: cmds.shows[0]?.label?.maxWidth,
    droppedBindings: (scene.diagnostics ?? [])
      .filter((d) => d.code === 'X-GIS0005')
      .map((d) => d.message),
  }
}

describe('text-max-width non-constant forms are not silently defaulted (#2320)', () => {
  it('["interpolate", ["linear"], ["zoom"], 5, 6, 10, 12] emits the zoom-interp form', () => {
    const { out } = convert({
      'text-max-width': ['interpolate', ['linear'], ['zoom'], 5, 6, 10, 12],
    })
    expect(out).toContain('label-max-width-[interpolate(zoom, 5, 6, 10, 12)]')
    expect(out).not.toContain('label-max-width-10')
  })

  it('legacy {stops: [[5, 6], [10, 12]]} emits the zoom-interp form', () => {
    const { out } = convert({
      'text-max-width': {
        stops: [
          [5, 6],
          [10, 12],
        ],
      },
    })
    expect(out).toContain('label-max-width-[interpolate(zoom, 5, 6, 10, 12)]')
    expect(out).not.toContain('label-max-width-10')
  })

  it('["step", ["zoom"], …] keeps the bounded default and names the loss', () => {
    // The fold only recognises interpolate / legacy-stops shapes. A `step`
    // zoom expression is spec-valid and common; emitting nothing for it would
    // leave the runtime with no maxWidth at all (no wrap), which is further
    // from Mapbox than the spec default 10 ems.
    const { out, warnings } = convert({ 'text-max-width': ['step', ['zoom'], 5, 10, 8] })
    expect(out).toContain('label-max-width-10')
    expect(out).not.toContain('label-max-width-[')
    expect(warnings.some((w) => w.includes('text-max-width'))).toBe(true)
  })

  it('data-driven ["match", …] keeps the bounded default and names the loss', () => {
    const { out, warnings } = convert({
      'text-max-width': ['match', ['get', 'kind'], 'city', 6, 10],
    })
    expect(out).toContain('label-max-width-10')
    expect(out).not.toContain('label-max-width-[')
    expect(warnings.some((w) => w.includes('text-max-width'))).toBe(true)
  })

  it('control: line placement suppresses the interpolated form (spec: unused)', () => {
    const { out, warnings } = convert({
      'symbol-placement': 'line',
      'text-max-width': ['interpolate', ['linear'], ['zoom'], 5, 6, 10, 12],
    })
    expect(out).not.toContain('label-max-width')
    expect(warnings.some((w) => w.includes('text-max-width'))).toBe(false)
  })

  it('control: constant 7 still emits label-max-width-7 with no warning', () => {
    const { out, warnings } = convert({ 'text-max-width': 7 })
    expect(out).toContain('label-max-width-7')
    expect(warnings.some((w) => w.includes('text-max-width'))).toBe(false)
  })

  it('control: omitted text-max-width still defaults to label-max-width-10', () => {
    const { out } = convert({})
    expect(out).toContain('label-max-width-10')
  })

  it('a negative stop is clamped AND named, like the constant arm', () => {
    const { out, warnings } = convert({
      'text-max-width': ['interpolate', ['linear'], ['zoom'], 5, -6, 10, 12],
    })
    expect(out).toContain('label-max-width-[interpolate(zoom, 5, 0, 10, 12)]')
    expect(warnings.some((w) => w.includes('text-max-width stop -6 is negative'))).toBe(true)
  })

  it('end-to-end: the folded form reaches LabelDef.maxWidth, undropped', () => {
    // The converter half alone is not the fix: without a lower arm the
    // bracket form raises X-GIS0005 and maxWidth arrives undefined, i.e.
    // labels never wrap — worse than the default-10 this issue replaced.
    const { maxWidth, droppedBindings } = lowered({
      'text-max-width': ['interpolate', ['linear'], ['zoom'], 5, 6, 10, 12],
    })
    expect(droppedBindings).toEqual([])
    expect(maxWidth).toBe(12)
  })

  it('end-to-end: the exponential form lowers the same way', () => {
    const { maxWidth, droppedBindings } = lowered({
      'text-max-width': ['interpolate', ['exponential', 2], ['zoom'], 5, 6, 10, 12],
    })
    expect(droppedBindings).toEqual([])
    expect(maxWidth).toBe(12)
  })

  it('end-to-end: a non-foldable form still lowers to the spec default 10', () => {
    const { maxWidth, droppedBindings } = lowered({
      'text-max-width': ['step', ['zoom'], 5, 10, 8],
    })
    expect(droppedBindings).toEqual([])
    expect(maxWidth).toBe(10)
  })
})
