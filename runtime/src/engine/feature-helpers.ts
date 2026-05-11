// Feature-level helpers used by XGISMap's data-load and rebuild paths
// (and shared with VectorTileRenderer for the hex-color parser).
// Pure functions over GeoJSON / hex-string inputs — no engine state,
// no GPU coupling. Extracted from map.ts so cross-cutting utilities
// live somewhere callers from multiple modules can reach without
// reimporting from a high-level orchestrator.

import { evaluate } from '@xgis/compiler'
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
  if (hex.length === 4) {
    r = parseInt(hex[1] + hex[1], 16) / 255
    g = parseInt(hex[2] + hex[2], 16) / 255
    b = parseInt(hex[3] + hex[3], 16) / 255
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
 *  undefined / empty input. Callers that propagate a "no colour
 *  declared" intent (label fill fallback, time-interpolated colour
 *  stops) need this distinction over the all-zero default. */
export function hexToRgba(hex: string | null | undefined): [number, number, number, number] | null {
  if (!hex) return null
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
  if (geom.type === 'Point') return c as [number, number]
  if (geom.type === 'MultiPoint' && Array.isArray(c) && c.length > 0) {
    return c[0] as [number, number]
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
  for (const [x, y] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
  }
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
): GeoJSONFeatureCollection {
  if (!filterExpr?.ast || !data.features) return data
  const ast = filterExpr.ast as AST.Expr
  const filtered = data.features.filter(f => {
    // Inject `$geometryType` + `$featureId` so Mapbox
    // `["geometry-type"]` and `["id"]` accessors (lowered to
    // `get("$geometryType")` / `get("$featureId")` by the converter)
    // can read feature meta without breaking the props-only
    // evalFilter contract.
    const propsBag: Record<string, unknown> = { ...(f.properties ?? {}) }
    if (f.geometry) propsBag.$geometryType = f.geometry.type
    if ((f as { id?: string | number }).id !== undefined) {
      propsBag.$featureId = (f as { id: string | number }).id
    }
    const result = evaluate(ast, propsBag)
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
): GeoJSONFeatureCollection {
  const ast = geometryExpr.ast as AST.Expr
  const newFeatures = data.features.map(f => {
    const result = evaluate(ast, f.properties ?? {})
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
