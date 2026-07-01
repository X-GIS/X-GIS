// ═══ Extrude expression evaluator ═════════════════════════════════
//
// Thin wrapper around the compiler's `evaluate()` that coerces the
// result to a finite positive number (or null). Kept as a tiny
// helper so callers don't have to repeat the type-check + finite-
// check + sign-check at every call site. The MVT worker is already
// importing decode / decompose / compile from `@xgis/compiler`, so
// pulling in `evaluate` adds no new modules to the worker bundle.
//
// Returning null means "the expression didn't yield a usable height
// for this feature" — caller falls back to the layer's fallback
// height. NaN, Infinity, zero, negative numbers, strings, booleans,
// nulls, and unsupported AST kinds all collapse to that same null.

import { evaluate, makeEvalProps } from '@xgis/compiler'

export type ExtrudeAst = unknown // serialized AST node, structurally typed by evaluate()

/** Evaluate an extrude AST against a feature property bag. Returns
 *  a finite positive number, or null when the expression is missing
 *  required fields / divides by zero / produces a non-numeric
 *  value. The full compiler evaluator handles the entire AST surface
 *  (literals, FieldAccess, BinaryExpr, UnaryExpr, FnCall, MatchBlock,
 *  ConditionalExpr, ArrayLiteral / ArrayAccess, PipeExpr); anything
 *  the user can write inside `fill: ...` works inside `extrude: ...`
 *  too.
 *
 *  `tileZoom` (optional) gets injected as the reserved `$zoom` key so
 *  height expressions like `interpolate(zoom, …)` resolve correctly.
 *  Pre-fix the raw props bag let `["zoom"]` collapse to undefined and
 *  the surrounding interpolate evaluator returned 0 — every feature's
 *  height baked at the first-stop value regardless of zoom band.
 *  Tile zoom is a close-enough proxy for camera zoom (heights bake at
 *  tile-decode time; per-frame re-bake is a separate follow-up). */
export function evalExtrudeExpr(
  node: ExtrudeAst,
  props: Record<string, unknown> | null | undefined,
  tileZoom?: number,
  feature?: { id?: string | number; geometry?: { type?: string } },
): number | null {
  if (!node || typeof node !== 'object') return null
  // The cast is structural — evaluate() expects an AST.Expr but
  // accepts anything matching the node-kind dispatch shape we get
  // from the parser. Threading the full type all the way to the
  // worker would force the worker to re-export the compiler's AST
  // surface; using `unknown` at the boundary is functionally
  // equivalent and keeps the call sites straightforward.
  //
  // Properties-less features (`props` null/undefined) still resolve
  // via the reserved keys ($zoom / $geometryType / $featureId), so
  // a geometry-type-only or zoom-only extrude expression evaluates
  // cleanly against an empty bag.
  const useReservedKeys = tileZoom !== undefined || feature !== undefined
  const bag = useReservedKeys
    ? makeEvalProps({
        props: props ?? undefined,
        cameraZoom: tileZoom,
        geometryType: feature?.geometry?.type,
        featureId: feature?.id,
      })
    : (props ?? {})
  // Per-feature throw isolation — mirror of applyFilter (566ab36).
  // The extrude bake loops in mvt-worker / pmtiles-backend call this
  // once per polygon; one throw used to crash the whole tile compile.
  let v: unknown
  try {
    v = evaluate(node as never, bag)
  } catch {
    return null
  }
  if (typeof v !== 'number') return null
  if (!Number.isFinite(v) || v <= 0) return null
  return v
}
