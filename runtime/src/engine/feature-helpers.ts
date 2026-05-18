// Feature-level helpers used by XGISMap's data-load and rebuild paths
// (and shared with VectorTileRenderer for the hex-color parser).
// Pure functions over GeoJSON / hex-string inputs — no engine state,
// no GPU coupling. Extracted from map.ts so cross-cutting utilities
// live somewhere callers from multiple modules can reach without
// reimporting from a high-level orchestrator.

import { evaluate, makeEvalProps } from '@xgis/compiler'
import type * as AST from '@xgis/compiler'
import type { GeoJSONFeatureCollection } from '../loader/geojson'

// ─── Color helpers ─────────────────────────────────────────────────

/** Parse `#rgb` / `#rrggbb` / `#rrggbbaa` to [r, g, b, a] in 0..1.
 *  Defaults missing channels: alpha to 1, all RGB to 0 on unrecognised
 *  input. Never returns null — callers needing a "did this parse?"
 *  signal should use {@link hexToRgba} instead. Previously duplicated
 *  in map.ts and vector-tile-renderer.ts; consolidated here. */
export function parseHexColor(hex: string): [number, number, number, number] {
  let r = 0, g = 0, b = 0, a = 1
  // Reject non-hex content early. Without this, `parseInt("zz", 16)` =
  // NaN propagated through to the colour buffer; the renderer's
  // float-array view stored NaN per channel and the GPU sampled
  // undefined behaviour (typically black-with-jitter depending on
  // driver). Mirror of the layer.ts wrapper regex guard.
  if (!/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(hex)) {
    return [0, 0, 0, 1]
  }
  if (hex.length === 4) {
    r = parseInt(hex[1] + hex[1], 16) / 255
    g = parseInt(hex[2] + hex[2], 16) / 255
    b = parseInt(hex[3] + hex[3], 16) / 255
  } else if (hex.length === 5) {
    // CSS Color Module 4 short-alpha form `#rgba` — each digit doubles
    // to a full byte. Pre-fix this length fell to the default
    // [0,0,0,1] and the colour silently turned black on any style
    // emitting `#xxxa`.
    r = parseInt(hex[1] + hex[1], 16) / 255
    g = parseInt(hex[2] + hex[2], 16) / 255
    b = parseInt(hex[3] + hex[3], 16) / 255
    a = parseInt(hex[4] + hex[4], 16) / 255
  } else if (hex.length === 7) {
    r = parseInt(hex.slice(1, 3), 16) / 255
    g = parseInt(hex.slice(3, 5), 16) / 255
    b = parseInt(hex.slice(5, 7), 16) / 255
  } else if (hex.length === 9) {
    r = parseInt(hex.slice(1, 3), 16) / 255
    g = parseInt(hex.slice(3, 5), 16) / 255
    b = parseInt(hex.slice(5, 7), 16) / 255
    a = parseInt(hex.slice(7, 9), 16) / 255
  }
  return [r, g, b, a]
}

/** Nullable variant of {@link parseHexColor}: returns null for null /
 *  undefined / empty / INVALID-SHAPE input. Callers that propagate a
 *  "no colour declared" intent (label fill fallback, time-interpolated
 *  colour stops) need this distinction over the all-zero default —
 *  AND the layer-style fill / stroke setter validation gates rely on
 *  the null signal to reject typo'd colour strings instead of
 *  silently rendering black.
 *
 *  Pre-fix the regex validation lived inside parseHexColor where it
 *  always returned the [0,0,0,1] black default for invalid input;
 *  the gate `parseHexColor(v) === null` in layer.ts (and callers
 *  expecting hexToRgba to signal validity) was dead code, and an
 *  authored `"red"` reached the renderer as black. */
export function hexToRgba(hex: string | null | undefined): [number, number, number, number] | null {
  if (!hex) return null
  if (typeof hex !== 'string') return null
  if (!/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(hex)) return null
  return parseHexColor(hex)
}

// ─── Geometry helpers ──────────────────────────────────────────────

/** Pick a representative anchor point [lon, lat] for a GeoJSON
 *  geometry — used by label placement when a Show command picks the
 *  feature centroid as the symbol position. Polygon / MultiPolygon
 *  use the bbox centre of the FIRST outer ring; Point / MultiPoint
 *  use the first coordinate; LineString / MultiLineString fall through
 *  to ringBboxCentre on the coordinate list. Returns null on empty /
 *  unsupported shapes so the caller can fall back to a different
 *  strategy (e.g. tile-centre when no per-feature anchor is available). */
export function featureAnchor(geom: { type: string; coordinates: unknown }): [number, number] | null {
  if (!geom) return null
  const c = geom.coordinates as unknown
  if (geom.type === 'Point') {
    // Validate Point coords shape — a malformed Point with missing /
    // non-numeric coordinates would otherwise let the caller deref
    // [0]/[1] on null and crash downstream. Return null cleanly.
    if (!Array.isArray(c) || c.length < 2 || typeof c[0] !== 'number' || typeof c[1] !== 'number') return null
    return c as [number, number]
  }
  if (geom.type === 'MultiPoint' && Array.isArray(c) && c.length > 0) {
    // Mirror the Point shape validation — first multi-point coord
    // must be a valid [number, number] pair, else null.
    const p = c[0]
    if (!Array.isArray(p) || p.length < 2 || typeof p[0] !== 'number' || typeof p[1] !== 'number') return null
    return p as [number, number]
  }
  if (geom.type === 'LineString' && Array.isArray(c)) {
    return ringBboxCentre(c as [number, number][])
  }
  if (geom.type === 'MultiLineString' && Array.isArray(c) && c.length > 0) {
    return ringBboxCentre(c[0] as [number, number][])
  }
  if (geom.type === 'Polygon' && Array.isArray(c) && c.length > 0) {
    return ringBboxCentre(c[0] as [number, number][])
  }
  if (geom.type === 'MultiPolygon' && Array.isArray(c) && c.length > 0
      && Array.isArray(c[0]) && (c[0] as unknown[]).length > 0) {
    return ringBboxCentre(c[0][0] as [number, number][])
  }
  return null
}

/** Bounding-box centre of a ring of [lon, lat] points. Returns null
 *  for empty rings. */
export function ringBboxCentre(ring: [number, number][]): [number, number] | null {
  if (!ring || ring.length === 0) return null
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const pt of ring) {
    // Skip malformed points (null, non-array, < 2 entries, non-numeric).
    // Pre-fix `for (const [x, y] of ring)` destructure threw on null
    // points and tore down the whole symbol-placement loop for the
    // entire tile.
    if (!Array.isArray(pt) || pt.length < 2) continue
    const x = pt[0]
    const y = pt[1]
    if (typeof x !== 'number' || typeof y !== 'number') continue
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
  }
  // If every point was malformed, minX/maxX stay at ±Infinity →
  // (Infinity + -Infinity) / 2 = NaN. Return null cleanly instead.
  if (!Number.isFinite(minX)) return null
  return [(minX + maxX) / 2, (minY + maxY) / 2]
}

// ─── Feature collection transforms ─────────────────────────────────

/** Filter a FeatureCollection by an xgis expression AST (`filter:`
 *  clause). Returns a new collection with only the features whose
 *  evaluated expression is truthy. Pass-through (returns the input
 *  reference) when no filter is supplied OR when nothing was removed —
 *  XGISMap's data-load step calls this on every dataset whether or
 *  not the show declared a filter, and the no-op fast-path avoids
 *  re-allocating on the most common case. */
export function applyFilter(
  data: GeoJSONFeatureCollection,
  filterExpr?: { ast: unknown } | null,
  cameraZoom?: number,
): GeoJSONFeatureCollection {
  // Defensive: null/undefined data short-circuits before `.features`
  // access. The host's data-load step can hand applyFilter a
  // partially-constructed dataset mid-stream; .features on null was
  // a hard crash.
  if (!data || !filterExpr?.ast || !Array.isArray(data.features)) return data
  const ast = filterExpr.ast as AST.Expr
  const filtered = data.features.filter(f => {
    // Inject `$geometryType` + `$featureId` so Mapbox
    // `["geometry-type"]` and `["id"]` accessors (lowered to
    // `get("$geometryType")` / `get("$featureId")` by the converter)
    // can read feature meta without breaking the props-only
    // evalFilter contract. `cameraZoom` rounds out the reserved-key
    // set so filters like `["all", [">=", ["zoom"], 14], ...]` see
    // the live camera value — mirror of the PMTiles filter eval
    // contract (mvt-worker / pmtiles-backend feed `tileZoom`).
    const propsBag = makeEvalProps({
      props: f.properties ?? undefined,
      geometryType: f.geometry?.type,
      featureId: (f as { id?: string | number }).id,
      cameraZoom,
    })
    // Wrap evaluate in try/catch so one malformed feature (or a
    // pathological filter expression hitting a stack-overflow / null
    // chain on one feature only) does not nuke every other feature
    // in the collection. Treat a throw as "filter rejects" — same as
    // a null/false return. Mirror of the per-layer try/catch isolation
    // (compiler/0c81006) at the runtime applyFilter boundary.
    let result: unknown
    try {
      result = evaluate(ast, propsBag)
    } catch {
      return false
    }
    // Truthy check: non-zero numbers, true booleans, non-empty strings.
    if (typeof result === 'boolean') return result
    if (typeof result === 'number') return result !== 0
    return !!result
  })
  if (filtered.length === data.features.length) return data
  return { ...data, features: filtered }
}

/** Generate procedural geometry per feature (`geometry:` clause).
 *  Evaluates the expression with each feature's properties; replaces
 *  the feature's geometry with the computed result. Three result
 *  shapes are recognised:
 *    - Falsy → keep original geometry
 *    - Coordinate array of arrays → wrap as Polygon (single ring)
 *    - GeoJSON-shaped object (has `type` + `coordinates`) → use as-is
 *  Anything else preserves the original geometry too. */
export function applyGeometry(
  data: GeoJSONFeatureCollection,
  geometryExpr: { ast: unknown },
  cameraZoom?: number,
): GeoJSONFeatureCollection {
  // Guard against a malformed FeatureCollection — `applyFilter` has
  // the same `!data.features` short-circuit. Without this, `.map(...)`
  // throws when the runtime receives a no-features payload (e.g. an
  // empty source or a partial transfer mid-load) and the host's data-
  // load step crashes the whole rebuild.
  if (!data || !Array.isArray(data.features)) return data
  const ast = geometryExpr.ast as AST.Expr
  const newFeatures = data.features.map(f => {
    const bag = makeEvalProps({
      props: f.properties ?? undefined,
      geometryType: f.geometry?.type,
      featureId: (f as { id?: string | number }).id,
      cameraZoom,
    })
    // Same per-feature isolation as applyFilter (566ab36): a throw in
    // evaluate on ONE feature must not nuke the whole collection.
    // Treat a throw as 'keep original geometry'.
    let result: unknown
    try {
      result = evaluate(ast, bag)
    } catch {
      return f
    }
    if (!result) return f
    if (Array.isArray(result) && result.length > 0 && Array.isArray(result[0])) {
      return {
        ...f,
        geometry: { type: 'Polygon' as const, coordinates: [result as number[][]] },
      }
    }
    if (result && typeof result === 'object' && 'type' in result && 'coordinates' in result) {
      return { ...f, geometry: result as typeof f.geometry }
    }
    return f
  })
  return { ...data, features: newFeatures }
}
