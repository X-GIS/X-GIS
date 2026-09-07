// ═══ Per-feature expression extraction — one copy, main thread and worker ═══
//
// Three extractors that run a per-feature expression at MVT/GeoJSON decode time and
// return a sparse `Map<featureIndex, value>`. They existed TWICE — exported from
// `sources/pmtiles-backend-helpers.ts` and private in `workers/mvt-worker.ts` — with
// identical signatures and, measured, identical bodies (the colours pair differed only
// by braces around one statement).
//
// The helpers copy said why: "can't import from mvt-worker because its module is
// worker-only (top-level postMessage handler), so we duplicate the helper. Keep in sync
// with the worker copy." The FIRST half of that is no longer true — `mvt-worker.ts` now
// gates its listener on `DedicatedWorkerGlobalScope` so unit tests can import it — but
// the conclusion still holds for a different reason: importing the worker would drag the
// whole decoder into the main-thread bundle. A third module both sides import is the
// answer either way, and "keep in sync" stops being anyone's job.
//
// This directory's charter (AGENTS.md) is why the module lives here: everything under
// `data/src/eval/` runs inside worker threads and "must not import anything outside
// `@xgis/compiler` and local helpers". These three need exactly that and nothing more —
// note that `pmtiles-backend-helpers.ts` also imports `@xgis/shared`, which they do not
// use, so moving them OUT is what keeps this module inside the charter.
//
// HEIGHTS AND WIDTHS ARE NOT THE SAME FUNCTION, though they read alike: heights goes
// through `evalExtrudeExpr`, widths through `evaluate` + `makeEvalProps` with its own
// per-feature try/catch. Folding them into one would collapse two different evaluators.

import { evaluate, makeEvalProps, type GeoJSONFeature } from '@xgis/compiler'
import type * as AST from '@xgis/compiler'
import { evalExtrudeExpr } from './extrude-eval'

/** Per-feature extrude heights. Uses `evalExtrudeExpr`, NOT the `evaluate` +
 *  `makeEvalProps` path its two siblings below take — that difference is the reason
 *  this is three functions and not one, and a test asserts it. */
export function extractFeatureHeights(
  features: GeoJSONFeature[],
  expr: unknown,
  tileZoom: number,
): Map<number, number> {
  // Mirrors mvt-worker.ts — only emit entries for features whose
  // expression evaluates to a usable height. Missing / null /
  // non-finite values are left out; the language is responsible
  // for declaring fallbacks (`extrude: .height ?? 50`) when it
  // wants a default.
  const out = new Map<number, number>()
  if (!expr) return out
  for (let i = 0; i < features.length; i++) {
    const f = features[i]
    // Properties-less features still resolve via the reserved keys.
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

export function extractFeatureWidths(
  features: GeoJSONFeature[],
  expr: unknown,
  tileZoom: number,
): Map<number, number> {
  const out = new Map<number, number>()
  if (!expr) return out
  for (let i = 0; i < features.length; i++) {
    const f = features[i]
    // Inject `$zoom` + `$geometryType` + `$featureId` — full reserved-
    // key set so width expressions like `["case", ["==",
    // ["geometry-type"], "LineString"], 4, 1]` resolve correctly. See
    // mvt-worker.ts's extractFeatureWidths for the rationale.
    // Per-feature throw isolation — mirror of applyFilter (566ab36).
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

export function extractFeatureColors(
  features: GeoJSONFeature[],
  expr: unknown,
  tileZoom: number,
): Map<number, number> {
  const out = new Map<number, number>()
  if (!expr) return out
  for (let i = 0; i < features.length; i++) {
    const f = features[i]
    // Full reserved-key bag — `["zoom"]` / `["geometry-type"]` / `["id"]`
    // all resolve. Pre-fix the raw props bag (and the cameraZoom-only
    // bag prior to this iteration) collapsed match() expressions that
    // referenced any of those identifiers to their default arm.
    // Per-feature throw isolation — mirror of applyFilter (566ab36).
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
    if (
      typeof v === 'string' &&
      v.startsWith('#') &&
      (v.length === 4 || v.length === 5 || v.length === 7 || v.length === 9)
    ) {
      // Accept all four CSS hex forms. Mirror of the mvt-worker fix —
      // short forms previously fell through the length gate and the
      // per-feature colour baking emitted nothing.
      let r: number, g: number, b: number, a: number
      if (v.length === 4 || v.length === 5) {
        r = parseInt(v[1] + v[1], 16)
        g = parseInt(v[2] + v[2], 16)
        b = parseInt(v[3] + v[3], 16)
        a = v.length === 5 ? parseInt(v[4] + v[4], 16) : 255
      } else {
        r = parseInt(v.slice(1, 3), 16)
        g = parseInt(v.slice(3, 5), 16)
        b = parseInt(v.slice(5, 7), 16)
        a = v.length === 9 ? parseInt(v.slice(7, 9), 16) : 255
      }
      if (a > 0) out.set(i, (r | (g << 8) | (b << 16) | (a << 24)) >>> 0)
    }
  }
  return out
}
