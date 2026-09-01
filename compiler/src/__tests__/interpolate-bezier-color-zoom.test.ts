// #2166 — `["interpolate", ["cubic-bezier", …], ["zoom"], z0, colour0, …]`.
//
// The DATA-DRIVEN densifier (expr-interpolate.ts) samples hex-colour stops at
// the bezier-eased fraction; its ZOOM-AXIS twin (paint-helpers.ts
// interpolateZoomStops) admitted numeric stops only, warned "folded to
// linear", and then returned the plain 2-stop shape — so the authored curve
// was silently discarded on the zoom axis while the identical expression on a
// data axis kept it.
//
// Measured on a0a8337a, `["cubic-bezier", 0.9, 0, 1, 1]` over #ff0000 → #0000ff:
//   zoom axis  → interpolate(zoom, 0, #ff0000, 10, #0000ff)          (2 stops)
//   data axis  → interpolate(.x, 0, "#ff0000", …, 5, "#dd0022", …)   (7 stops)
// and the zoom-axis emit was BYTE-IDENTICAL to the same ramp authored with
// ["linear"] — i.e. the curve carried no information at all.
//
// Pure compile-time, GPU-free. The rendered correlate is
// playground/e2e/_bezier-zoom-color-gate.spec.ts.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { exprToXgis } from '../convert/expressions'
import { parseExpressionString } from '../parser/parser'
import { extractInterpolateZoomColorStops } from '../ir/lower-helpers'

/** Strong ease-in: eased(0.5) = 0.1328, so the midpoint colour sits far from
 *  the linear #800080 — a delta no rounding can hide. */
const EASE_IN = ['cubic-bezier', 0.9, 0, 1, 1]
const RAMP_STOPS = [0, '#ff0000', 10, '#0000ff']

function convertFillColor(color: unknown): { out: string; warnings: string[] } {
  const warnings: string[] = []
  const out = convertMapboxStyle(
    {
      version: 8,
      sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
      layers: [
        { id: 'l', type: 'fill', source: 'v', 'source-layer': 's', paint: { 'fill-color': color } },
      ],
    } as never,
    { coverage: { sources: [], layers: [], warnings } },
  )
  return { out, warnings }
}

/** Pull the `interpolate(zoom, …)` fill binding out of the emitted layer. */
function fillBinding(out: string): string {
  const m = out.match(/fill-\[(interpolate\(zoom,[^\]]*)\]/)
  if (!m) throw new Error(`no zoom-interp fill binding in:\n${out}`)
  return m[1]!
}

/** `interpolate(<input>, z0, v0, …)` → [z, value] pairs, quotes stripped. */
function parseStops(src: string): Array<[number, string]> {
  const inner = src.replace(/^interpolate\([^,]+,\s*/, '').replace(/\)$/, '')
  const toks = inner.split(',').map((s) => s.trim())
  const out: Array<[number, string]> = []
  for (let i = 0; i < toks.length; i += 2)
    out.push([Number(toks[i]), toks[i + 1]!.replace(/"/g, '')])
  return out
}

describe('zoom-axis cubic-bezier over COLOUR stops (#2166)', () => {
  it('densifies the colour ramp instead of discarding the curve', () => {
    const { out, warnings } = convertFillColor(['interpolate', EASE_IN, ['zoom'], ...RAMP_STOPS])
    const binding = fillBinding(out)
    // CAUSE: the "can't be densified" downgrade must not fire; the
    // dense-sample note must.
    expect(
      warnings.filter((w) => /folded to linear/.test(w)),
      `the zoom-axis densifier still discarded the bezier curve: ${binding}`,
    ).toEqual([])
    expect(warnings.some((w) => /cubic-bezier/.test(w) && /sample/i.test(w))).toBe(true)
    // EFFECT: 6 samples per segment + the endpoint.
    const stops = parseStops(binding)
    expect(stops.map(([, hex]) => hex)).toEqual([
      '#ff0000',
      '#fc0003',
      '#f1000e',
      '#dd0022',
      '#bb0044',
      '#81007e',
      '#0000ff',
    ])
    // The midpoint is the whole point: linear would be #800080.
    expect(stops.find(([z]) => z === 5)![1]).toBe('#dd0022')
  })

  it('the emitted binding survives into the IR colour-stop carrier', () => {
    const { out } = convertFillColor(['interpolate', EASE_IN, ['zoom'], ...RAMP_STOPS])
    const ir = extractInterpolateZoomColorStops(parseExpressionString(fillBinding(out)))
    expect(
      ir,
      'the dense binding must still lower to zoom-interpolated colour stops',
    ).not.toBeNull()
    expect(ir!.stops.length).toBe(7)
    expect(ir!.stops.find((s) => s.zoom === 5)!.value).toBe('#dd0022')
  })

  it('the zoom axis and the data axis agree stop-for-stop', () => {
    const zoomStops = parseStops(
      fillBinding(convertFillColor(['interpolate', EASE_IN, ['zoom'], ...RAMP_STOPS]).out),
    )
    const dataOut = exprToXgis(['interpolate', EASE_IN, ['get', 'x'], ...RAMP_STOPS] as never, [])
    expect(parseStops(dataOut!)).toEqual(zoomStops)
  })

  it('the curve now carries information: bezier differs from linear', () => {
    // Byte-identical on a0a8337a — the control that names the defect best.
    const bez = fillBinding(convertFillColor(['interpolate', EASE_IN, ['zoom'], ...RAMP_STOPS]).out)
    const lin = fillBinding(
      convertFillColor(['interpolate', ['linear'], ['zoom'], ...RAMP_STOPS]).out,
    )
    expect(bez, 'a cubic-bezier ramp must not emit the same stops as ["linear"]').not.toBe(lin)
    expect(parseStops(lin)).toEqual([
      [0, '#ff0000'],
      [10, '#0000ff'],
    ])
  })

  it('NEGATIVE CONTROL — the numeric zoom arm is untouched', () => {
    const warnings: string[] = []
    const out = convertMapboxStyle(
      {
        version: 8,
        sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
        layers: [
          {
            id: 'l',
            type: 'line',
            source: 'v',
            'source-layer': 's',
            paint: {
              'line-width': [
                'interpolate',
                ['cubic-bezier', 0.42, 0, 0.58, 1],
                ['zoom'],
                5,
                0.5,
                15,
                4,
              ],
            },
          },
        ],
      } as never,
      { coverage: { sources: [], layers: [], warnings } },
    )
    expect(out).toContain(
      'interpolate(zoom, 5, 0.5, 6.666666666666666, 0.6964577731611428, 8.333333333333332, 1.3112118328297955, 10, 2.25, 11.666666666666666, 3.188788167170204, 13.333333333333334, 3.8035422268388577, 15, 4)',
    )
  })

  it('NEGATIVE CONTROL — an 8-digit (alpha) hex keeps its alpha by folding', () => {
    // `parseSrgbHex` drops alpha, so densifying `#rrggbbaa` would silently
    // delete an alpha the plain-linear fold preserves. The fold path is the
    // honest answer here, not a missed opportunity.
    const { out, warnings } = convertFillColor([
      'interpolate',
      EASE_IN,
      ['zoom'],
      0,
      '#ff000080',
      10,
      '#0000ff80',
    ])
    expect(
      warnings.some((w) => /folded to linear/.test(w)),
      'an alpha-carrying hex stop was densified — parseSrgbHex drops alpha, so the ' +
        'authored transparency is now gone from the emitted ramp',
    ).toBe(true)
    expect(out, 'the authored alpha must survive the fold').toContain('#ff000080')
  })

  it('NEGATIVE CONTROL — expression-valued colour stops still fold to linear', () => {
    // The honest residual that keeps the coverage row `partial`: an eased
    // sample can't be computed when the stop value is only known per feature.
    const { warnings } = convertFillColor([
      'interpolate',
      EASE_IN,
      ['zoom'],
      0,
      ['get', 'c0'],
      10,
      '#0000ff',
    ])
    expect(warnings.some((w) => /folded to linear/.test(w))).toBe(true)
  })
})
