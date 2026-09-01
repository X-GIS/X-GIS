// Issue #1976 — legacy zoom-function objects `{"stops": [[z, v], …]}`
// (Mapbox style spec v0/v1, still authored by Carto / Versatiles /
// MapLibre-demo basemaps) were dropped for four paint properties whose
// zoom-interp branches pre-gated on the MODERN expression array only
// (`Array.isArray(v) && v[0] === 'interpolate'`): line-dasharray,
// line-translate, fill-translate and — sharing addFillTranslate —
// fill-extrusion-translate. The lift machinery (interpolateZoomStops)
// already understood the legacy shape; only the pre-gates blocked it.
//
// Two adjacent gaps closed here:
//   * a SINGLE-stop RANGE function is the constant (exponential /
//     interval clamp below the first stop and above the last, and with
//     one stop those are the same stop), but the lift needs >= 2 stops
//     and so dropped it everywhere. `categorical` is exact-key match,
//     not a range, so it is excluded from the fold;
//   * a 1-element dasharray value (`[1]`, authored by Carto Dark Matter)
//     failed the `length >= 2` gate on BOTH dasharray paths — normalised
//     via the SVG/MapLibre odd-length repeat rule, in both places.
//
// Out of scope (still drops, deliberately): data-driven forms.
// `["step", ["zoom"], …]` dasharray now converts too (#1994, see
// step-zoom-dasharray.test.ts) — 7d below covers its interaction with the
// #1976 lift machinery this file otherwise exercises.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

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

function fillLayer(paint: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'f',
    type: 'fill',
    source: 'v',
    'source-layer': 'p',
    paint: { 'fill-color': '#00ff00', ...paint },
  }
}

function fillExtrusionLayer(paint: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'b',
    type: 'fill-extrusion',
    source: 'v',
    'source-layer': 'b',
    paint: { 'fill-extrusion-color': '#0000ff', 'fill-extrusion-height': 10, ...paint },
  }
}

function symbolLayer(layout: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 's',
    type: 'symbol',
    source: 'v',
    'source-layer': 'poi',
    layout: { 'text-field': '{name}', ...layout },
    paint: { 'text-color': '#ffffff' },
  }
}

function backgroundLayer(paint: Record<string, unknown>): Record<string, unknown> {
  return { id: 'bg', type: 'background', paint }
}

const dashDrops = (warnings: string[]): string[] =>
  warnings.filter((w) => w.includes('paint.line-dasharray:'))

const propertyFnWarnings = (warnings: string[]): string[] =>
  warnings.filter((w) => w.includes('legacy Mapbox data-driven property function'))

describe('#1976 — legacy {stops} zoom functions lift for dasharray / translate', () => {
  it('1. line-dasharray legacy stops → stroke-dasharray bracket binding, no drop warning', () => {
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
    expect(out).toContain('stroke-dasharray-[interpolate(zoom, 15, [2, 2], 18, [3, 3])]')
    expect(dashDrops(warnings)).toEqual([])
  })

  it('2. line-dasharray legacy stops with a 1-element stop value → [a] normalised to [a, a]', () => {
    // Carto Dark Matter `boundary_county`. SVG / MapLibre dash rule: an
    // odd-length dash array repeats, so [1] ≡ [1, 1].
    const { out, warnings } = convert(
      lineLayer({
        'line-dasharray': {
          stops: [
            [6, [1]],
            [7, [2, 2]],
          ],
        },
      }),
    )
    expect(out).toContain('stroke-dasharray-[interpolate(zoom, 6, [1, 1], 7, [2, 2])]')
    expect(dashDrops(warnings)).toEqual([])
  })

  it('2b. a 3-element dasharray stop value stays 3 elements (mirrors the constant path)', () => {
    // Carto Dark Matter `boundary_state`. Only the 1-element case is
    // normalised — it is otherwise inexpressible downstream.
    const { out, warnings } = convert(
      lineLayer({
        'line-dasharray': {
          stops: [
            [6, [1, 2, 3]],
            [7, [1, 2, 3]],
          ],
        },
      }),
    )
    expect(out).toContain('stroke-dasharray-[interpolate(zoom, 6, [1, 2, 3], 7, [1, 2, 3])]')
    expect(dashDrops(warnings)).toEqual([])
  })

  it('3. fill-translate legacy stops → per-axis fill-translate bracket bindings, no drop warning', () => {
    const { out, warnings } = convert(
      fillLayer({
        'fill-translate': {
          stops: [
            [14, [0, 0]],
            [16, [-2, -2]],
          ],
        },
      }),
    )
    expect(out).toContain('fill-translate-x-[interpolate(zoom, 14, 0, 16, -2)]')
    expect(out).toContain('fill-translate-y-[interpolate(zoom, 14, 0, 16, -2)]')
    expect(warnings.filter((w) => w.includes('fill-translate:'))).toEqual([])
  })

  it('4. fill-extrusion-translate legacy stops → same fill-translate utilities, no drop warning', () => {
    const { out, warnings } = convert(
      fillExtrusionLayer({
        'fill-extrusion-translate': {
          stops: [
            [14, [0, 0]],
            [16, [-2, -2]],
          ],
        },
      }),
    )
    expect(out).toContain('fill-translate-x-[interpolate(zoom, 14, 0, 16, -2)]')
    expect(out).toContain('fill-translate-y-[interpolate(zoom, 14, 0, 16, -2)]')
    expect(warnings.filter((w) => w.includes('translate:'))).toEqual([])
  })

  it('4b. a fill-extrusion-translate that DOES drop names fill-extrusion-translate, not fill-translate', () => {
    const { warnings } = convert(
      fillExtrusionLayer({ 'fill-extrusion-translate': ['get', 'shift'] }),
    )
    const drops = warnings.filter((w) => w.includes('translate: non-constant form'))
    expect(drops.length).toBe(1)
    expect(drops[0]).toContain('paint.fill-extrusion-translate:')
    expect(drops[0]).not.toContain('paint.fill-translate:')
  })

  it('4c. the fill layer keeps naming fill-translate in its drop warning', () => {
    const { warnings } = convert(fillLayer({ 'fill-translate': ['get', 'shift'] }))
    const drops = warnings.filter((w) => w.includes('translate: non-constant form'))
    expect(drops.length).toBe(1)
    expect(drops[0]).toContain('paint.fill-translate:')
  })

  it('5. line-translate legacy stops → per-axis stroke-translate bracket bindings, no drop warning', () => {
    const { out, warnings } = convert(
      lineLayer({
        'line-translate': {
          stops: [
            [10, [0, 1]],
            [14, [0, 3]],
          ],
        },
      }),
    )
    expect(out).toContain('stroke-translate-x-[interpolate(zoom, 10, 0, 14, 0)]')
    expect(out).toContain('stroke-translate-y-[interpolate(zoom, 10, 1, 14, 3)]')
    expect(warnings.filter((w) => w.includes('line-translate:'))).toEqual([])
  })
})

describe('#1976 — single-stop legacy zoom functions fold to their constant', () => {
  it('6. text-size {"stops": [[14, 12]]} → label-size-12', () => {
    // Versatiles Colorful `label-place-neighbourhood`. One stop means the
    // function evaluates to 12 at EVERY zoom — it IS the constant 12.
    const { out, warnings } = convert(symbolLayer({ 'text-size': { stops: [[14, 12]] } }))
    expect(out).toContain('label-size-12')
    expect(out).not.toContain('label-size-16')
    expect(warnings.filter((w) => w.includes('text-size'))).toEqual([])
  })

  it('6b. line-width {"stops": [[10, 3]]} → stroke-3 (fold is not text-size-specific)', () => {
    const { out } = convert(lineLayer({ 'line-width': { stops: [[10, 3]] } }))
    expect(out).toContain('stroke-3')
    expect(out).not.toContain('stroke-[interpolate')
  })

  it('6c. a single-stop fold evaluates to the constant at the stop zoom (no 0/0 NaN)', () => {
    // Guard against a "duplicate the stop into two" implementation: equal
    // zoom keys make t = (z - z0) / (z1 - z0) = 0/0 = NaN in a linear
    // evaluator, so exactly-at-the-stop-zoom is the hazard sample.
    const { out } = convert(lineLayer({ 'line-width': { stops: [[10, 3]] } }))
    expect(out).not.toContain('interpolate(zoom, 10, 3, 10, 3)')
    expect(out).not.toContain('NaN')
  })

  it('6e. background-color {"stops": [[5, "#333333"]]} → background { fill: #333333 }', () => {
    // The background layer builds its own paint bag (it emits a top-level
    // `background { … }` directive, not a layer block), so it is the third
    // fold boundary alongside safePropsBag and paintToUtilities' bag.
    const { out, warnings } = convert(
      backgroundLayer({ 'background-color': { stops: [[5, '#333333']] } }),
    )
    expect(out).toContain('background { fill: #333333 }')
    expect(warnings.filter((w) => w.includes('Color expression not converted'))).toEqual([])
  })

  it('6f. single-stop background-opacity folds into the fill hex alpha', () => {
    // applyAlphaMultiplier('#336699', 0.5): a = round(255 * 0.5) = 128 = 0x80.
    const { out, warnings } = convert(
      backgroundLayer({
        'background-color': '#336699',
        'background-opacity': { stops: [[5, 0.5]] },
      }),
    )
    expect(out).toContain('background { fill: #33669980 }')
    expect(warnings.filter((w) => w.includes('background-opacity'))).toEqual([])
  })

  it('6g. multi-stop background-color still lifts to an interpolate fill (regression guard)', () => {
    const { out } = convert(
      backgroundLayer({
        'background-color': {
          stops: [
            [5, '#111111'],
            [10, '#222222'],
          ],
        },
      }),
    )
    expect(out).toContain('background { fill: interpolate(zoom, 5, #111111, 10, #222222) }')
  })

  it('6d. a two-stop legacy function still lifts to an interpolate (fold is single-stop only)', () => {
    const { out } = convert(
      lineLayer({
        'line-width': {
          stops: [
            [10, 3],
            [14, 6],
          ],
        },
      }),
    )
    expect(out).toContain('stroke-[interpolate(zoom, 10, 3, 14, 6)]')
  })
})

describe('#1976 — regression guards', () => {
  it('7a. modern ["interpolate"] dasharray still converts unchanged', () => {
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
    expect(out).toContain('stroke-dasharray-[interpolate(zoom, 8, [4, 2], 16, [8, 2])]')
    expect(dashDrops(warnings)).toEqual([])
  })

  it('7b. modern ["interpolate"] fill-translate still converts unchanged', () => {
    const { out, warnings } = convert(
      fillLayer({
        'fill-translate': [
          'interpolate',
          ['linear'],
          ['zoom'],
          14,
          ['literal', [0, 0]],
          16,
          ['literal', [-2, -2]],
        ],
      }),
    )
    expect(out).toContain('fill-translate-x-[interpolate(zoom, 14, 0, 16, -2)]')
    expect(out).toContain('fill-translate-y-[interpolate(zoom, 14, 0, 16, -2)]')
    expect(warnings.filter((w) => w.includes('fill-translate:'))).toEqual([])
  })

  it('7c. constant dasharray path is untouched (odd 3-element array still emitted as authored)', () => {
    const { out } = convert(lineLayer({ 'line-dasharray': [1, 2, 3] }))
    expect(out).toContain('stroke-dasharray-1-2-3')
  })

  it('7d. ["step", ["zoom"], …] dasharray now converts (#1994) — coexists with the #1976 lift', () => {
    // Superseded by #1994: a well-formed zoom-step dasharray used to drop
    // with a (mislabeled) data-driven warning; it now lifts onto the same
    // stroke-dasharray-[interpolate(zoom, …)] binding the legacy-{stops}
    // and modern-interpolate forms above use. Full coverage (malformed
    // forms, the zoom-step classifier label, the [a]→[a,a] repeat rule,
    // the pipeline check) lives in step-zoom-dasharray.test.ts; this guard
    // just confirms the #1976 lift work didn't regress step's own path.
    const { out, warnings } = convert(
      lineLayer({
        'line-dasharray': ['step', ['zoom'], ['literal', [2, 2]], 14, ['literal', [4, 4]]],
      }),
    )
    expect(out).toContain('stroke-dasharray-[interpolate(zoom, 0, [2, 2], 14, [4, 4])]')
    expect(dashDrops(warnings)).toEqual([])
  })

  it('7e. a legacy DATA-DRIVEN property function still warns and drops, it does not lift', () => {
    const { out, warnings } = convert(
      lineLayer({
        'line-dasharray': {
          property: 'class',
          type: 'categorical',
          stops: [
            ['primary', [2, 2]],
            ['secondary', [4, 4]],
          ],
        },
      }),
    )
    expect(out).not.toContain('stroke-dasharray-[')
    expect(propertyFnWarnings(warnings).length).toBe(1)
    expect(dashDrops(warnings).length).toBe(1)
  })

  it('7g. a legacy property function on a vec2 translate warns ONCE, not once per axis', () => {
    // fill-translate splits into two scalar axes, so the lift runs twice.
    // Without a short-circuit the property-function diagnostic fires for
    // both axes and the reader sees the same loss reported twice.
    const { warnings } = convert(
      fillLayer({
        'fill-translate': {
          property: 'class',
          type: 'categorical',
          stops: [
            ['primary', [2, 2]],
            ['secondary', [4, 4]],
          ],
        },
      }),
    )
    expect(propertyFnWarnings(warnings).length).toBe(1)
    expect(warnings.filter((w) => w.includes('paint.fill-translate:')).length).toBe(1)
  })

  it('7h. the same holds for line-translate', () => {
    const { warnings } = convert(
      lineLayer({
        'line-translate': {
          property: 'class',
          type: 'categorical',
          stops: [
            ['primary', [2, 2]],
            ['secondary', [4, 4]],
          ],
        },
      }),
    )
    expect(propertyFnWarnings(warnings).length).toBe(1)
    expect(warnings.filter((w) => w.includes('paint.line-translate:')).length).toBe(1)
  })

  it('7f. a SINGLE-stop data-driven property function does not fold to its value either', () => {
    const { out, warnings } = convert(
      lineLayer({
        'line-width': { property: 'class', type: 'categorical', stops: [['primary', 7]] },
      }),
    )
    expect(out).not.toContain('stroke-7')
    expect(propertyFnWarnings(warnings).length).toBe(1)
  })
})

describe('#1976 — the [a] ≡ [a, a] dash repeat rule holds on BOTH dasharray paths', () => {
  it('8a. a single-stop legacy dasharray folds to the constant and still emits a dash', () => {
    // The fold routes {"stops": [[6, [1]]]} to the CONSTANT branch, so the
    // repeat rule has to live there too — otherwise the fold turns a
    // convertible value into a dropped one.
    const { out, warnings } = convert(lineLayer({ 'line-dasharray': { stops: [[6, [1]]] } }))
    expect(out).toContain('stroke-dasharray-1-1')
    expect(dashDrops(warnings)).toEqual([])
  })

  it('8b. a plain constant [1] emits stroke-dasharray-1-1 (same value, same result)', () => {
    const { out, warnings } = convert(lineLayer({ 'line-dasharray': [1] }))
    expect(out).toContain('stroke-dasharray-1-1')
    expect(dashDrops(warnings)).toEqual([])
  })

  it('8c. a constant [1] and a stops-wrapped [1] converge on the same utility', () => {
    const viaConstant = convert(lineLayer({ 'line-dasharray': [1] })).out
    const viaStops = convert(lineLayer({ 'line-dasharray': { stops: [[6, [1]]] } })).out
    expect(viaConstant).toBe(viaStops)
  })
})

describe('#1976 — the single-stop fold respects the legacy function `type`', () => {
  it('9a. a CATEGORICAL single-stop function does NOT fold', () => {
    // Legacy categorical semantics are exact-key match: {type: "categorical",
    // stops: [[14, 12]]} yields 12 only when the input equals 14 and the
    // property default everywhere else — folding it to a constant 12 at
    // every zoom would be a silent behaviour change.
    const { out, warnings } = convert(
      symbolLayer({ 'text-size': { type: 'categorical', stops: [[14, 12]] } }),
    )
    expect(out).not.toContain('label-size-12')
    expect(out).toContain('label-size-16')
    expect(warnings.some((w) => w.includes('text-size expression form not converted'))).toBe(true)
  })

  it('9b. an EXPONENTIAL single-stop function still folds', () => {
    const { out } = convert(
      symbolLayer({ 'text-size': { type: 'exponential', stops: [[14, 12]] } }),
    )
    expect(out).toContain('label-size-12')
  })

  it('9c. an INTERVAL single-stop function still folds', () => {
    const { out } = convert(symbolLayer({ 'text-size': { type: 'interval', stops: [[14, 12]] } }))
    expect(out).toContain('label-size-12')
  })

  it('9d. an unknown `type` does NOT fold', () => {
    const { out } = convert(symbolLayer({ 'text-size': { type: 'identity', stops: [[14, 12]] } }))
    expect(out).not.toContain('label-size-12')
    expect(out).toContain('label-size-16')
  })
})
