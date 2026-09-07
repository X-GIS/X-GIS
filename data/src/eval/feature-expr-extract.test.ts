// ═══ The three feature-expression extractors, and the distinctions between them ═══
//
// These moved here from two files that each defined them (#2534 row 4). The move was
// verbatim, so the first job is a differential proving that. The second job is the one
// that turned out to matter more:
//
// BEFORE THIS FILE, NOTHING DISTINGUISHED THEM. Measured, not assumed — with the three
// living in `pmtiles-backend-helpers.ts` and `mvt-worker.ts`, every suite that touches
// either file (21 files / 148 tests) still passed with:
//
//   • `extractFeatureHeights` rewired to the WIDTHS evaluator          -> 148/148 green
//   • `extractFeatureWidths`'s per-feature `try/catch` made to rethrow  -> 148/148 green
//
// The second cut is unambiguous: that isolation is what `eval/AGENTS.md` calls intentional
// — "one pathological feature in a 10 000-feature tile must not abort the rest of the slice
// bake" — and nothing asserted it. Arm C does now.
//
// The FIRST cut is more interesting, and it corrected me. I read it as a coverage gap and
// wrote an arm asserting the two evaluators are "not interchangeable". That arm failed, and
// probing found NO input where heights and widths disagree — numeric strings, zero,
// negatives, booleans, null props and throwing getters all agree. So the passing cut may
// simply mean they ARE equivalent today. Arm B pins that equivalence instead of asserting a
// distinction I could not demonstrate; whether they can be folded is a real open question
// that needs `evalExtrudeExpr`'s contract proven, not sampled.

import { describe, it, expect } from 'vitest'
import { evaluate, makeEvalProps, type GeoJSONFeature } from '@xgis/compiler'
import type * as AST from '@xgis/compiler'
import { evalExtrudeExpr } from './extrude-eval'
import {
  extractFeatureHeights,
  extractFeatureWidths,
  extractFeatureColors,
} from './feature-expr-extract'

// ── expression builders, same idiom as extrude-eval.test.ts ─────────────────────────────
const fld = (field: string) => ({ kind: 'FieldAccess' as const, object: null, field })

const feat = (properties: Record<string, unknown> | null, type = 'Polygon'): GeoJSONFeature =>
  ({
    type: 'Feature',
    properties,
    geometry: { type, coordinates: [] },
  }) as unknown as GeoJSONFeature

// ── the retired bodies, verbatim ────────────────────────────────────────────────────────
// As they stood in BOTH pmtiles-backend-helpers.ts and mvt-worker.ts at 1260623a (the two
// were identical; the colours pair differed only by braces). Independent second
// implementations — do not refactor them to share anything.

function retiredHeights(
  features: GeoJSONFeature[],
  expr: unknown,
  tileZoom: number,
): Map<number, number> {
  const out = new Map<number, number>()
  if (!expr) return out
  for (let i = 0; i < features.length; i++) {
    const f = features[i]
    const v = evalExtrudeExpr(
      expr,
      (f.properties ?? undefined) as Record<string, unknown> | undefined,
      tileZoom,
      f,
    )
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out.set(i, v)
  }
  return out
}

function retiredWidths(
  features: GeoJSONFeature[],
  expr: unknown,
  tileZoom: number,
): Map<number, number> {
  const out = new Map<number, number>()
  if (!expr) return out
  for (let i = 0; i < features.length; i++) {
    const f = features[i]
    let v: unknown
    try {
      v = evaluate(
        expr as AST.Expr,
        makeEvalProps({
          props: (f.properties ?? undefined) as Record<string, unknown> | undefined,
          cameraZoom: tileZoom,
          geometryType: f.geometry?.type,
          featureId: (f as { id?: string | number }).id,
        }),
      )
    } catch {
      continue
    }
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out.set(i, v)
  }
  return out
}

// ── inputs ──────────────────────────────────────────────────────────────────────────────
/** Numeric shapes the accept step must sort: usable, and every kind it must drop. */
const NUMERIC_FEATURES: GeoJSONFeature[] = [
  feat({ v: 12 }), // usable
  feat({ v: 0 }), // zero — dropped, not a usable width/height
  feat({ v: -3 }), // negative — dropped
  feat({ v: Number.NaN }), // NaN — dropped
  feat({ v: Number.POSITIVE_INFINITY }), // non-finite — dropped
  feat({ v: 'not a number' }), // wrong type — dropped
  feat({}), // property absent
  feat(null), // properties-less feature: MVT/GeoJSON allows null
  feat({ v: 0.5 }), // sub-unit, still usable
]

describe('feature-expression extractors (#2534 row 4)', () => {
  // ── A. the move changed nothing ───────────────────────────────────────────────────────
  it('extractFeatureHeights equals the retired body', () => {
    expect([...extractFeatureHeights(NUMERIC_FEATURES, fld('v'), 14)]).toEqual([
      ...retiredHeights(NUMERIC_FEATURES, fld('v'), 14),
    ])
  })

  it('extractFeatureWidths equals the retired body', () => {
    expect([...extractFeatureWidths(NUMERIC_FEATURES, fld('v'), 14)]).toEqual([
      ...retiredWidths(NUMERIC_FEATURES, fld('v'), 14),
    ])
  })

  it('the differential is not vacuous — the corpus admits some and drops most', () => {
    // Both equalities above would hold trivially over an all-rejected corpus.
    const got = extractFeatureHeights(NUMERIC_FEATURES, fld('v'), 14)
    expect(got.size).toBe(2) // indices 0 and 8
    expect(got.get(0)).toBe(12)
    expect(got.get(8)).toBe(0.5)
    expect(NUMERIC_FEATURES.length - got.size).toBeGreaterThan(5)
  })

  it('a falsy expr yields an empty map without touching the features', () => {
    for (const e of [undefined, null, 0, '']) {
      expect(extractFeatureHeights(NUMERIC_FEATURES, e, 14).size).toBe(0)
      expect(extractFeatureWidths(NUMERIC_FEATURES, e, 14).size).toBe(0)
      expect(extractFeatureColors(NUMERIC_FEATURES, e, 14).size).toBe(0)
    }
  })

  // ── B. heights vs widths: two evaluators, no OBSERVED difference ──────────────────────
  it('heights and widths agree on numeric expressions, on every input probed', () => {
    // They route through different evaluators — heights via `evalExtrudeExpr`, widths via
    // `evaluate` + `makeEvalProps` — and this consolidation kept them as two functions.
    // Honesty about why: I could NOT construct an input where they disagree. Numeric
    // strings, zero, negatives, booleans, null props and throwing getters all give the
    // same answer, because `evalExtrudeExpr`'s coercion contract ("finite positive number
    // or null") lands in the same place as the widths accept step.
    //
    // So this arm pins the equivalence rather than asserting a distinction I cannot show.
    // Whether they can be folded is a real question, and it needs `evalExtrudeExpr`'s
    // contract proven exhaustively rather than sampled — a separate change, not this one.
    for (const props of [{ v: 42 }, { v: '42' }, { v: 0 }, { v: -1 }, { v: true }, {}]) {
      const fs = [feat(props as Record<string, unknown>)]
      expect(extractFeatureHeights(fs, fld('v'), 14).get(0)).toBe(
        extractFeatureWidths(fs, fld('v'), 14).get(0),
      )
    }
  })

  // ── C. the isolation eval/AGENTS.md calls intentional ─────────────────────────────────
  it('a throwing feature is skipped, not propagated — the rest of the tile survives', () => {
    // "one pathological feature in a 10 000-feature tile must not abort the rest of the
    // slice bake" (data/src/eval/AGENTS.md). A property getter that throws stands in for
    // the pathological feature; removing the per-feature try/catch makes this arm throw.
    const boom = feat({}) as GeoJSONFeature & { properties: Record<string, unknown> }
    Object.defineProperty(boom.properties, 'v', {
      get() {
        throw new Error('pathological feature')
      },
      enumerable: true,
    })
    const features = [feat({ v: 7 }), boom, feat({ v: 9 })]

    const widths = extractFeatureWidths(features, fld('v'), 14)
    expect(widths.get(0)).toBe(7)
    expect(widths.has(1)).toBe(false) // skipped, not fatal
    expect(widths.get(2)).toBe(9) // and the scan continued past it
  })

  // ── D. the reserved keys the copies' comments say are load-bearing ────────────────────
  it('injects `$zoom` from tileZoom, so interpolate(zoom, …) resolves at decode time', () => {
    // The retired comment: "Inject $zoom + $geometryType + $featureId — full reserved-key
    // set". `$zoom` is the one this function can surface directly: the others resolve to
    // STRINGS, which the numeric accept step then drops by design, so a bare field access
    // on them proves nothing. Passing a different tileZoom must move the answer.
    const rows = [feat({})]
    expect(extractFeatureWidths(rows, fld('$zoom'), 14).get(0)).toBe(14)
    expect(extractFeatureWidths(rows, fld('$zoom'), 7).get(0)).toBe(7)
  })

  // ── E. colours: all four CSS hex forms, packed LSB=R ──────────────────────────────────
  it('packs every accepted hex form, and drops fully transparent ones', () => {
    // "Accept all four CSS hex forms. Mirror of the mvt-worker fix — short forms previously
    // fell through the length gate and the per-feature colour baking emitted nothing."
    const rows = [
      feat({ c: '#f00' }), // #rgb
      feat({ c: '#f00f' }), // #rgba, opaque
      feat({ c: '#ff0000' }), // #rrggbb
      feat({ c: '#ff0000ff' }), // #rrggbbaa
      feat({ c: '#ff000000' }), // alpha 0 — dropped, not drawn
      feat({ c: 'red' }), // named colour: this extractor does not resolve names
    ]
    const got = extractFeatureColors(rows, fld('c'), 14)
    const RED = (255 | (255 << 24)) >>> 0
    expect([got.get(0), got.get(1), got.get(2), got.get(3)]).toEqual([RED, RED, RED, RED])
    expect(got.has(4)).toBe(false)
    expect(got.has(5)).toBe(false)
  })

  it('DOCUMENTS a live defect: a malformed hex packs garbage instead of being dropped', () => {
    // MEASURED, not desired. This extractor has no hex VALIDITY gate — only a length gate —
    // so `parseInt('zz', 16)` is NaN and `NaN | …` folds that channel to 0:
    //
    //   '#zzz' -> 0xff000000   (opaque BLACK, silently drawn)
    //   '#1g3' -> 0xff330011   (r and b parsed, g silently 0)
    //
    // It is the same NaN-through-parseInt bug the three total hex parsers folded in #2639
    // each carried a comment about; this copy never received the guard. The fix is to gate
    // on `HEX_COLOR_RE` from `@xgis/shared`, which #2639 introduces — deliberately NOT done
    // here, so this consolidation stays a move and the behaviour change gets its own PR
    // and its own review. This arm exists so the defect cannot be lost, and so that fix
    // arrives as a visible red rather than a silent edit.
    const got = extractFeatureColors([feat({ c: '#zzz' }), feat({ c: '#1g3' })], fld('c'), 14)
    expect(got.get(0)).toBe(0xff000000)
    expect(got.get(1)).toBe(0xff330011)
  })
})
