// ═══ Boolean zoom-step lift (Mapbox `["step", ["zoom"], b0, z1, b1, …]`) ═══
//
// A boolean paint property cannot be authored as an `["interpolate", …]` —
// the Mapbox spec types booleans `interpolated: false`, so a zoom-varying
// boolean is spelled with `step`. That form is what OFM Bright authors on
// `fill-antialias` (landcover-wood: `["step", ["zoom"], false, 9, true]`).
//
// This module maps such a curve onto the 0/1 NUMERIC `step(zoom, …)` call the
// xgis binding grammar and `extractStepZoomStops` (lower-helpers.ts) already
// understand, so the lift needs no new AST shape, no new PropertyShape kind
// and no new extractor — only the boolean → 0/1 substitution.
//
// Deliberately NOT in paint-helpers.ts: that file sits 3 lines under its LOC
// ceiling (loc-ceiling-ratchet), and this is a self-contained transform with
// one caller.

import { unwrapStopLiteral } from './zoom-function-fold'

/** `["literal", true] | true` → `'1'`, `false` → `'0'`, anything else → null. */
function boolBit(v: unknown): string | null {
  const u = unwrapStopLiteral(v)
  if (u === true) return '1'
  if (u === false) return '0'
  return null
}

/** Render a Mapbox BOOLEAN zoom-step expression as the xgis
 *  `step(zoom, d, z1, v1, …)` call body (no brackets), with every boolean
 *  mapped to 0/1 — `["step", ["zoom"], false, 9, true]` → `step(zoom, 0, 9, 1)`.
 *
 *  Returns null (caller keeps its warn-and-drop path) unless EVERY part
 *  matches: the operator is `step`, its input is `["zoom"]` (so a per-feature
 *  `["get", …]` input is rejected — there is no per-feature lane for these
 *  flags), the stop keys are finite numbers, and every value is a boolean (a
 *  numeric-valued step is some other property's curve, not this one's).
 *  Mapbox v8 `["literal", …]` wrappers are peeled at every position. */
export function boolZoomStepCall(v: unknown): string | null {
  const expr = unwrapStopLiteral(v)
  if (!Array.isArray(expr) || expr[0] !== 'step') return null
  const input = unwrapStopLiteral(expr[1])
  if (!Array.isArray(input) || input.length !== 1 || input[0] !== 'zoom') return null
  // After the operator + input: the default value, then N (zoom, value) pairs.
  const rest = expr.slice(2)
  if (rest.length < 3 || rest.length % 2 !== 1) return null
  const defaultBit = boolBit(rest[0])
  if (defaultBit === null) return null
  const parts: string[] = [defaultBit]
  for (let i = 1; i + 1 < rest.length; i += 2) {
    const zoom = unwrapStopLiteral(rest[i])
    const bit = boolBit(rest[i + 1])
    if (typeof zoom !== 'number' || !Number.isFinite(zoom) || bit === null) return null
    parts.push(String(zoom), bit)
  }
  return `step(zoom, ${parts.join(', ')})`
}
