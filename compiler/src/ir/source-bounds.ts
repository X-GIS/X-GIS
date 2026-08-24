// ═══ Source-level `bounds: [west, south, east, north]` — the one predicate (#1984) ═══
//
// Mapbox `source.bounds` declares where a source HAS data, so tiles outside it can only
// 404. Two stages need to agree about what a USABLE box is: the Mapbox converter (which
// decides whether to emit the property and what to warn when it doesn't) and `lowerSource`
// (which decides whether the parsed `.xgis` literal reaches `SourceDef`). Two copies of
// that rule would drift, so it lives here once and each stage renders its own message
// around the reason string this returns.
//
// GRAMMAR — `bounds: [-10, 35, 5, 45]` adds no production. `parseBlockProperty` parses a
// full expression and `parsePrimary` already builds an `ArrayLiteral` from `[a, b, …]`
// with `parseExpr()` elements, so a negative arrives as `UnaryExpr('-', NumberLiteral)`
// — the same shape `astLiteralToJS` folds for inline `data:` GeoJSON coordinates. The
// array form is also what `layers: ["water", "roads"]` already uses on a source block,
// so the property reads the way a Mapbox author wrote it.
//
// ANTIMERIDIAN — a crossing box (`west > east`) is REJECTED, not wrapped. Mapbox and
// TileJSON both order bounds west < east within [-180, 180], and MapLibre's `TileBounds`
// clamps each component and then tests `minX <= maxX`, so a crossing declaration yields
// an EMPTY box there and the source draws nothing. Inventing a wraparound the reference
// renderer does not have would be a silent divergence; adopting its blank-the-source
// behaviour would be a silent regression. Rejecting leaves the source unclipped (its
// pre-existing behaviour) and lets the converter say why.

import type * as AST from '../parser/ast'

/** `[west, south, east, north]` in WGS84 degrees — the Mapbox source-bounds order. */
export type SourceBounds = [number, number, number, number]

/**
 * Validate a declared source bounds. Returns the box, or the REASON it is unusable —
 * a fragment a caller embeds in its own diagnostic (`Source "x" bounds ${reason}`).
 */
export function checkSourceBounds(v: unknown): SourceBounds | string {
  if (
    !Array.isArray(v) ||
    v.length !== 4 ||
    !v.every((n) => typeof n === 'number' && isFinite(n))
  ) {
    return `must be [west, south, east, north] — 4 finite numbers; got ${JSON.stringify(v)?.slice(0, 80) ?? typeof v}`
  }
  const [west, south, east, north] = v as SourceBounds
  if (west >= east) {
    return `west=${west} ${west === east ? '=' : '>'} east=${east} — bounds do not cross the antimeridian (Mapbox/TileJSON order them west < east inside [-180, 180], and MapLibre reads a crossing box as EMPTY, drawing nothing). Split the extent into two sources, one per side of ±180`
  }
  if (south >= north) {
    return `south=${south} ${south === north ? '=' : '>'} north=${north} — inverted or zero-height latitude box; verify the [west, south, east, north] order`
  }
  if (south < -90 || north > 90) {
    return `latitude out of [-90, 90]: south=${south}, north=${north} — likely a swapped lon/lat axis`
  }
  if (west < -180 || east > 180) {
    return `longitude out of [-180, 180]: west=${west}, east=${east} — likely a swapped lon/lat axis`
  }
  return [west, south, east, north]
}

/**
 * Lower an `.xgis` source-block `bounds:` value. Undefined when the literal is not a
 * 4-number array or the box is unusable — the same silent-ignore rule its `tileSize` /
 * `maxzoom` siblings in `lowerSource` follow (they match a bare `NumberLiteral` and let
 * anything else fall through). The author-facing diagnostic for a bad box belongs to the
 * converter, which still has the Mapbox JSON that produced it; and the runtime
 * re-validates independently (`map/src/render/source-bounds-clip.ts`), so an unusable
 * box can only ever mean "no clip", never a silently blanked source.
 */
export function lowerSourceBounds(value: AST.Expr): SourceBounds | undefined {
  if (value.kind !== 'ArrayLiteral') return undefined
  const nums = value.elements.map(literalNumber)
  const checked = checkSourceBounds(nums)
  return typeof checked === 'string' ? undefined : checked
}

/** A signed numeric literal, folding the unary +/- the parser wraps negatives in. */
function literalNumber(e: AST.Expr): number | undefined {
  if (e.kind === 'NumberLiteral') return e.value
  if (e.kind === 'UnaryExpr' && e.operand.kind === 'NumberLiteral') {
    if (e.op === '-') return -e.operand.value
    if (e.op === '+') return e.operand.value
  }
  return undefined
}
