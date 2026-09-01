// Mapbox paint.icon-translate → LabelDef.iconTranslateX/Y round-trip.
//
// icon-translate is a CSS-px VIEWPORT offset that applies only to the
// icon (independent of text-translate). The converter emits the
// `label-icon-translate-{x,y}-N` utility pair (mirror of icon-offset);
// lower threads it into LabelDef.iconTranslateX/Y; the runtime
// dispatchIcon adds it (× dpr) to the icon anchor at IconStage.addIcon.
// Default [0,0] = no-op. icon-translate-anchor: only viewport honoured.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { evaluate } from '../eval/evaluator'
import { makeEvalProps } from '../eval/reserved-keys'
import type { Expr } from '../parser/ast'

function compileLabel(
  layer: Record<string, unknown>,
  opts?: { coverage?: { sources: never[]; layers: never[]; warnings: string[] } },
): {
  iconImage?: string
  iconTranslateX?: number
  iconTranslateY?: number
  iconTranslateExpr?: { ast: unknown }
} {
  const style = {
    version: 8,
    sprite: 'https://example/sprites/foo',
    sources: { src: { type: 'vector', tiles: ['https://x/{z}/{x}/{y}.pbf'] } },
    layers: [layer],
  }

  const xgis = convertMapboxStyle(style as any, opts as any)
  const tokens = new Lexer(xgis).tokenize()
  const program = new Parser(tokens).parse()
  const scene = lower(program)
  for (const n of scene.renderNodes) {
    const label = (n as any).label
    if (label) return label
  }
  return {}
}

describe('Mapbox paint.icon-translate → LabelDef.iconTranslateX/Y', () => {
  it('absent → both undefined (no offset)', () => {
    const def = compileLabel({
      id: 'poi',
      type: 'symbol',
      source: 'src',
      'source-layer': 'poi',
      layout: { 'icon-image': 'x' },
    })
    expect(def.iconTranslateX).toBeUndefined()
    expect(def.iconTranslateY).toBeUndefined()
  })

  it('[0, 0] → both undefined (default, no-op)', () => {
    const def = compileLabel({
      id: 'poi',
      type: 'symbol',
      source: 'src',
      'source-layer': 'poi',
      layout: { 'icon-image': 'x' },
      paint: { 'icon-translate': [0, 0] },
    })
    expect(def.iconTranslateX).toBeUndefined()
    expect(def.iconTranslateY).toBeUndefined()
  })

  it('[3, 4] → x=3, y=4', () => {
    const def = compileLabel({
      id: 'poi',
      type: 'symbol',
      source: 'src',
      'source-layer': 'poi',
      layout: { 'icon-image': 'x' },
      paint: { 'icon-translate': [3, 4] },
    })
    expect(def.iconTranslateX).toBe(3)
    expect(def.iconTranslateY).toBe(4)
  })

  it('negative [0, -8] (POI icon nudge up) → x undefined, y=-8 via bracket form', () => {
    const def = compileLabel({
      id: 'poi',
      type: 'symbol',
      source: 'src',
      'source-layer': 'poi',
      layout: { 'icon-image': 'x' },
      paint: { 'icon-translate': [0, -8] },
    })
    expect(def.iconTranslateX).toBeUndefined()
    expect(def.iconTranslateY).toBe(-8)
  })

  it('v8 ["literal", [dx, dy]] wrap unwraps to constant', () => {
    const def = compileLabel({
      id: 'poi',
      type: 'symbol',
      source: 'src',
      'source-layer': 'poi',
      layout: { 'icon-image': 'x' },
      paint: { 'icon-translate': ['literal', [-2, 5]] },
    })
    expect(def.iconTranslateX).toBe(-2)
    expect(def.iconTranslateY).toBe(5)
  })

  it('is independent of text-translate (icon shifts, text does not)', () => {
    const def = compileLabel({
      id: 'poi',
      type: 'symbol',
      source: 'src',
      'source-layer': 'poi',
      layout: { 'icon-image': 'x', 'text-field': '{name}' },
      paint: { 'icon-translate': [6, 0], 'text-translate': [0, -10] },
    })
    // icon-translate lands on the icon fields; text-translate stays on
    // the label translate (NOT mixed into the icon offset).
    expect(def.iconTranslateX).toBe(6)
    expect((def as { translate?: [number, number] }).translate).toEqual([0, -10])
  })

  it('icon-translate-anchor "map" → LabelDef.iconTranslateAnchorMap=true (world-anchored)', () => {
    const def = compileLabel({
      id: 'poi',
      type: 'symbol',
      source: 'src',
      'source-layer': 'poi',
      layout: { 'icon-image': 'x' },
      paint: { 'icon-translate': [2, 2], 'icon-translate-anchor': 'map' },
    }) as { iconTranslateX?: number; iconTranslateY?: number; iconTranslateAnchorMap?: boolean }
    expect(def.iconTranslateX).toBe(2)
    expect(def.iconTranslateY).toBe(2)
    expect(def.iconTranslateAnchorMap).toBe(true)
  })

  it('icon-translate-anchor "map" WITHOUT icon-translate → flag undefined (anchor no-op)', () => {
    const def = compileLabel({
      id: 'poi',
      type: 'symbol',
      source: 'src',
      'source-layer': 'poi',
      layout: { 'icon-image': 'x' },
      paint: { 'icon-translate-anchor': 'map' },
    }) as { iconTranslateAnchorMap?: boolean }
    expect(def.iconTranslateAnchorMap).toBeUndefined()
  })

  it('DEFAULT (no anchor) → iconTranslateAnchorMap undefined (viewport, byte-identical)', () => {
    const def = compileLabel({
      id: 'poi',
      type: 'symbol',
      source: 'src',
      'source-layer': 'poi',
      layout: { 'icon-image': 'x' },
      paint: { 'icon-translate': [2, 2] },
    }) as { iconTranslateAnchorMap?: boolean }
    expect(def.iconTranslateAnchorMap).toBeUndefined()
  })

  it('no gap warning for the supported constant form', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    compileLabel(
      {
        id: 'poi',
        type: 'symbol',
        source: 'src',
        'source-layer': 'poi',
        layout: { 'icon-image': 'x' },
        paint: { 'icon-translate': [3, 4] },
      },
      { coverage } as any,
    )
    expect(coverage.warnings.some((w) => w.includes('shares the text-translate offset'))).toBe(
      false,
    )
  })
})

// ═══ zoom-interpolated icon-translate — componentwise, not snapped (#2166) ═══
//
// The tuple used to ride ONE opaque binding into the runtime evaluate, whose
// `interpolate` builtin only lerps NUMERIC stop values (evaluator-helpers.ts
// `if (typeof a.y === 'number' && typeof b.y === 'number')`) and otherwise
// "picks the closer stop" — so a [dx,dy] stop pair SNAPPED and a zoom-animated
// offset jumped instead of sliding. The converter now splits the vec2 into two
// scalar zoom interpolates re-paired by an array literal.
//
// These assertions run the PRODUCTION resolve: the lowered
// LabelDef.iconTranslateExpr AST evaluated through `makeEvalProps({ props,
// cameraZoom })` — byte-identical to what applyFeatureExprs hands `evaluate`
// in label-pass.ts before writing iconTranslateX/Y for dispatchIcon.
describe('zoom-interpolated paint.icon-translate resolves componentwise (#2166)', () => {
  /** Resolve the lowered per-dispatch [dx,dy] at one camera zoom, through the
   *  same bag builder label-pass.ts uses. Throws when the property did not
   *  lower to an expression at all (the pre-fix drop paths). */
  function translateAt(paintValue: unknown, cameraZoom: number): [number, number] {
    const def = compileLabel({
      id: 'poi',
      type: 'symbol',
      source: 'src',
      'source-layer': 'poi',
      layout: { 'icon-image': 'x' },
      paint: { 'icon-translate': paintValue },
    })
    const ast = def.iconTranslateExpr?.ast
    if (ast === undefined)
      throw new Error(
        'icon-translate did not lower to iconTranslateExpr — nothing reaches applyFeatureExprs',
      )
    const v = evaluate(ast as Expr, makeEvalProps({ props: {}, cameraZoom }))
    // The exact predicate applyFeatureExprs gates on before assigning
    // iconTranslateX/Y — a shape that fails it is silently ignored at dispatch.
    expect(
      Array.isArray(v) && v.length === 2 && v.every((c) => typeof c === 'number' && isFinite(c)),
      `applyFeatureExprs would reject this resolved value: ${JSON.stringify(v)}`,
    ).toBe(true)
    return v as [number, number]
  }

  // Two stops six zooms apart, both axes moving, y negative (the POI
  // "nudge the icon up as you zoom in" shape OFM authors).
  const INTERP = [
    'interpolate',
    ['linear'],
    ['zoom'],
    10,
    ['literal', [0, 0]],
    16,
    ['literal', [8, -16]],
  ]

  it('a mid-stop zoom lands BETWEEN the stops, not on one of them', () => {
    // z13 is the exact midpoint. Pre-fix this returned the z16 stop [8,-16]
    // verbatim (the closer-stop tie-break), which is the snap under test.
    const [dx, dy] = translateAt(INTERP, 13)
    expect(dx, 'dx must be strictly inside (0, 8)').toBeGreaterThan(0)
    expect(dx).toBeLessThan(8)
    expect(dy, 'dy must be strictly inside (-16, 0)').toBeGreaterThan(-16)
    expect(dy).toBeLessThan(0)
    // …and at the exact componentwise linear value, not merely somewhere inside.
    expect(dx).toBeCloseTo(4, 10)
    expect(dy).toBeCloseTo(-8, 10)
  })

  it('successive mid-stop zooms are all DISTINCT (a snap makes them equal)', () => {
    // The discriminating shape: under the snap, z11/z12 both read [0,0] and
    // z14/z15 both read [8,-16] — four samples collapse to two values.
    const zooms = [11, 12, 14, 15]
    const xs = zooms.map((z) => translateAt(INTERP, z)[0])
    expect(new Set(xs).size, `dx at z${zooms.join('/z')} = ${xs.join(', ')}`).toBe(zooms.length)
    // Strictly increasing along the ramp — pins direction, not just distinctness.
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThan(xs[i - 1]!)
  })

  it('clamps to the first/last stop outside the ramp', () => {
    expect(translateAt(INTERP, 8)).toEqual([0, 0])
    expect(translateAt(INTERP, 10)).toEqual([0, 0])
    expect(translateAt(INTERP, 16)).toEqual([8, -16])
    expect(translateAt(INTERP, 20)).toEqual([8, -16])
  })

  it('the legacy {stops} spelling of the same ramp resolves identically', () => {
    // isZoomInterpCandidate admits both spellings (#1976); the legacy object
    // used to miss the split entirely and drop to the property default.
    const legacy = {
      stops: [
        [10, [0, 0]],
        [16, [8, -16]],
      ],
    }
    expect(translateAt(legacy, 13)).toEqual(translateAt(INTERP, 13))
  })

  it('["exponential", base] keeps its curve per axis', () => {
    const exp = [
      'interpolate',
      ['exponential', 2],
      ['zoom'],
      10,
      ['literal', [0, 0]],
      16,
      ['literal', [8, -16]],
    ]
    // base=2 lags the linear ramp in the first half of the interval. Pin the
    // EXACT value, not just the bounds: at the midpoint of a 6-zoom interval
    // the exponential weight is (base^3 - 1) / (base^6 - 1), so
    // dx = 8 * (2^3 - 1) / (2^6 - 1) = 8 * 7/63 = 0.888…. Bounds alone are
    // satisfied by any base in roughly (1, 4), so a wrong — or silently
    // dropped — `base` inside interpolate_exp is not distinguished from the
    // right one. The sibling linear assertions pin exactly; so does this now.
    const [dxExp] = translateAt(exp, 13)
    const [dxLin] = translateAt(INTERP, 13)
    expect(dxExp).toBeCloseTo((8 * (2 ** 3 - 1)) / (2 ** 6 - 1), 10)
    expect(dxExp).toBeLessThan(dxLin)
  })

  it('the BARE-ARRAY modern spelling converges on the same split (#2166)', () => {
    // The third spelling. INTERP uses the strict v8 `['literal', [dx, dy]]`
    // wrap and the legacy {stops} object is covered separately, but the modern
    // expression with bare-array stops had no assertion — while the hand-off
    // claims all three converge on one emit. Measured on the pre-fix base this
    // form DROPPED entirely ("icon-translate non-constant form could not be
    // converted; offset dropped"), so it is not a cosmetic gap.
    const bare = ['interpolate', ['linear'], ['zoom'], 10, [0, 0], 16, [8, -16]]
    for (const [z, ex, ey] of [
      [11, 8 / 6, -16 / 6],
      [13, 4, -8],
    ] as const) {
      const [dx, dy] = translateAt(bare, z)
      expect(dx, `bare-array dx at z=${z}`).toBeCloseTo(ex, 10)
      expect(dy, `bare-array dy at z=${z}`).toBeCloseTo(ey, 10)
    }
    // And it lands on the SAME numbers as the ['literal', …] spelling, which
    // is the "all three converge" claim stated as an assertion.
    expect(translateAt(bare, 13)).toEqual(translateAt(INTERP, 13))
  })

  it('the per-feature expression form still resolves whole (#777 I-F unchanged)', () => {
    const def = compileLabel({
      id: 'poi',
      type: 'symbol',
      source: 'src',
      'source-layer': 'poi',
      layout: { 'icon-image': 'x' },
      paint: {
        'icon-translate': ['case', ['has', 'big'], ['literal', [4, -6]], ['literal', [0, 0]]],
      },
    })
    const ast = def.iconTranslateExpr?.ast as Expr
    expect(ast).toBeTruthy()
    expect(evaluate(ast, makeEvalProps({ props: { big: 1 }, cameraZoom: 13 }))).toEqual([4, -6])
    expect(evaluate(ast, makeEvalProps({ props: {}, cameraZoom: 13 }))).toEqual([0, 0])
  })

  it('a legacy property function on the tuple warns ONCE, not once per axis', () => {
    // The split runs the SAME lift twice (x then y), so without the
    // `ix === null` short-circuit the interpolateZoomStops property-function
    // diagnostic fires for both axes and the reader sees one loss reported
    // twice. Mirror of legacy-zoom-stops-lift.test.ts 7g/7h for fill-/line-
    // translate; this pins the short-circuit on the icon-translate arm.
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    compileLabel(
      {
        id: 'poi',
        type: 'symbol',
        source: 'src',
        'source-layer': 'poi',
        layout: { 'icon-image': 'x' },
        paint: {
          'icon-translate': {
            property: 'class',
            type: 'categorical',
            stops: [
              ['primary', [2, 2]],
              ['secondary', [4, 4]],
            ],
          },
        },
      },
      { coverage } as never,
    )
    expect(
      coverage.warnings.filter((w) => w.includes('legacy Mapbox data-driven property function'))
        .length,
      coverage.warnings.join('\n'),
    ).toBe(1)
    // …and the property still drops exactly once, as it did before the split.
    expect(
      coverage.warnings.filter((w) =>
        w.includes('icon-translate non-constant form could not be converted'),
      ).length,
    ).toBe(1)
  })

  it('an interpolate driven by a FEATURE value keeps its own input (not rewritten to zoom)', () => {
    // The boundary of the split, and the reason the row stays `partial`.
    // vec2AxisZoomInterp lifts only a ["zoom"]-driven interpolate; widening
    // that pre-gate would silently retarget this expression's input from
    // `.t` to the camera zoom — a wrong offset with no diagnostic. Green
    // before AND after #2166: it is a boundary guard, not the fix.
    const def = compileLabel({
      id: 'poi',
      type: 'symbol',
      source: 'src',
      'source-layer': 'poi',
      layout: { 'icon-image': 'x' },
      paint: {
        'icon-translate': [
          'interpolate',
          ['linear'],
          ['get', 't'],
          0,
          ['literal', [0, 0]],
          1,
          ['literal', [8, -16]],
        ],
      },
    })
    const ast = def.iconTranslateExpr?.ast as Expr
    expect(ast).toBeTruthy()
    // Reads `t`, not the camera zoom: the same feature at two different zooms
    // resolves identically, and two different `t` at one zoom do not.
    expect(evaluate(ast, makeEvalProps({ props: { t: 1 }, cameraZoom: 4 }))).toEqual([8, -16])
    expect(evaluate(ast, makeEvalProps({ props: { t: 1 }, cameraZoom: 18 }))).toEqual([8, -16])
    expect(evaluate(ast, makeEvalProps({ props: { t: 0 }, cameraZoom: 18 }))).toEqual([0, 0])
    // …and it still snaps on this input — the residual the coverage row names.
    expect(evaluate(ast, makeEvalProps({ props: { t: 0.5 }, cameraZoom: 12 }))).toEqual([8, -16])
  })
})
