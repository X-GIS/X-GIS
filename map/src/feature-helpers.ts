// Feature-level helpers used by XGISMap's data-load and rebuild paths
// (and shared with VectorTileRenderer for the hex-color parser).
// Pure functions over GeoJSON / hex-string inputs — no engine state,
// no GPU coupling. Extracted from map.ts so cross-cutting utilities
// live somewhere callers from multiple modules can reach without
// reimporting from a high-level orchestrator.

import { evaluate, makeEvalProps } from '@xgis/compiler'
import type * as AST from '@xgis/compiler'
import type { GeoJSONFeatureCollection } from '@xgis/data'

// ─── Color helpers ─────────────────────────────────────────────────

/** Parse `#rgb` / `#rrggbb` / `#rrggbbaa` to [r, g, b, a] in 0..1.
 *  Defaults missing channels: alpha to 1, all RGB to 0 on unrecognised
 *  input. Never returns null — callers needing a "did this parse?"
 *  signal should use {@link hexToRgba} instead. Previously duplicated
 *  in map.ts and vector-tile-renderer.ts; consolidated here. */
export function parseHexColor(hex: string): [number, number, number, number] {
  let r = 0,
    g = 0,
    b = 0,
    a = 1
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
 *  feature centroid as the symbol position (#727). Polygon uses a
 *  guaranteed-INTERIOR point of the outer ring (not the bbox centre,
 *  which falls OUTSIDE a concave / crescent polygon); MultiPolygon uses
 *  the LARGEST-area part's interior point (not just the first part);
 *  LineString / MultiLineString use the 50%-arc-length point of the
 *  (longest) chain — a point ON the line, not the bbox centre floating
 *  off a curve; Point / MultiPoint use the first coordinate. Returns
 *  null on empty / unsupported shapes so the caller can fall back to a
 *  different strategy (e.g. tile-centre when no per-feature anchor is
 *  available). */
export function featureAnchor(
  geom: import('@xgis/data').GeoJSONGeometry | { type: string; coordinates: unknown },
): [number, number] | null {
  if (!geom) return null
  // GeometryCollection (RFC 7946 §3.1.8) has `geometries`, not
  // `coordinates`. No single anchor without picking a sub-geometry;
  // return null and let the caller flatten via loadGeoJSON's
  // injection path (geojson.ts:316) which assigns the parent
  // feature's properties to each sub-geometry separately.
  if (geom.type === 'GeometryCollection') return null
  const c = (geom as { coordinates: unknown }).coordinates
  if (geom.type === 'Point') {
    // Validate Point coords shape — a malformed Point with missing /
    // non-numeric coordinates would otherwise let the caller deref
    // [0]/[1] on null and crash downstream. Return null cleanly.
    if (!Array.isArray(c) || c.length < 2 || typeof c[0] !== 'number' || typeof c[1] !== 'number')
      return null
    return c as [number, number]
  }
  if (geom.type === 'MultiPoint' && Array.isArray(c) && c.length > 0) {
    // Mirror the Point shape validation — first multi-point coord
    // must be a valid [number, number] pair, else null.
    const p = c[0]
    if (!Array.isArray(p) || p.length < 2 || typeof p[0] !== 'number' || typeof p[1] !== 'number')
      return null
    return p as [number, number]
  }
  if (geom.type === 'LineString' && Array.isArray(c)) {
    return lineMidpoint(c as [number, number][])
  }
  if (geom.type === 'MultiLineString' && Array.isArray(c) && c.length > 0) {
    return lineMidpoint(longestChain(c as [number, number][][]))
  }
  if (geom.type === 'Polygon' && Array.isArray(c) && c.length > 0) {
    return polygonInteriorPoint(c[0] as [number, number][])
  }
  if (
    geom.type === 'MultiPolygon' &&
    Array.isArray(c) &&
    c.length > 0 &&
    Array.isArray(c[0]) &&
    (c[0] as unknown[]).length > 0
  ) {
    return polygonInteriorPoint(largestPartOuter(c as [number, number][][][]))
  }
  return null
}

/** Bounding-box centre of a ring of [lon, lat] points. Returns null
 *  for empty rings. */
function ringBboxCentre(ring: [number, number][]): [number, number] | null {
  if (!ring || ring.length === 0) return null
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity
  for (const pt of ring) {
    // Skip malformed points (null, non-array, < 2 entries, non-numeric).
    // Pre-fix `for (const [x, y] of ring)` destructure threw on null
    // points and tore down the whole symbol-placement loop for the
    // entire tile.
    if (!Array.isArray(pt) || pt.length < 2) continue
    const x = pt[0]
    const y = pt[1]
    if (typeof x !== 'number' || typeof y !== 'number') continue
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  // If every point was malformed, minX/maxX stay at ±Infinity →
  // (Infinity + -Infinity) / 2 = NaN. Return null cleanly instead.
  if (!Number.isFinite(minX)) return null
  return [(minX + maxX) / 2, (minY + maxY) / 2]
}

/** Shoelace area (absolute, planar lon/lat units) of a ring. Used ONLY to
 *  compare parts RELATIVELY (largest MultiPolygon part), so a planar area
 *  is sufficient — no geodesic correction needed for the ranking. */
function ringAbsArea(ring: [number, number][]): number {
  if (!Array.isArray(ring) || ring.length < 3) return 0
  let a = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const pi = ring[i]
    const pj = ring[j]
    if (!Array.isArray(pi) || !Array.isArray(pj)) continue
    if (typeof pi[0] !== 'number' || typeof pi[1] !== 'number') continue
    if (typeof pj[0] !== 'number' || typeof pj[1] !== 'number') continue
    a += (pj[0] + pi[0]) * (pj[1] - pi[1])
  }
  return Math.abs(a) / 2
}

/** Outer ring of the LARGEST-area part of a MultiPolygon. Fixes the old
 *  `coordinates[0][0]` which only ever labelled the FIRST part — for a
 *  country with a big mainland + small islands the label jumped to whichever
 *  part happened to be first in the data, not the visually dominant one. */
function largestPartOuter(parts: [number, number][][][]): [number, number][] {
  let best: [number, number][] = []
  let bestA = -1
  for (const part of parts) {
    const outer = Array.isArray(part) ? part[0] : undefined
    if (!Array.isArray(outer)) continue
    const a = ringAbsArea(outer as [number, number][])
    if (a > bestA) {
      bestA = a
      best = outer as [number, number][]
    }
  }
  return best
}

/** A point GUARANTEED to lie inside a polygon's outer ring — unlike the
 *  bbox centre, which lands OUTSIDE a concave / crescent / C-shaped polygon
 *  (the reported #727 "inline label sits off-shape"). Scanline "visual
 *  centre": at several latitudes near the vertical middle, take the midpoint
 *  of the WIDEST interior span (between consecutive edge crossings, even-odd
 *  rule) and keep the widest found. Holes are ignored (acceptable for a
 *  label anchor). Degenerate rings (< 3 vertices, zero height, all-malformed)
 *  fall back to the bbox centre. NOT the full pole-of-inaccessibility
 *  (polylabel) — a scanline interior point is right-sized for a label anchor
 *  and, crucially, is provably inside; polylabel's "most interior" refinement
 *  can layer on later without changing this contract. */
function polygonInteriorPoint(ring: [number, number][]): [number, number] | null {
  const bbox = ringBboxCentre(ring)
  if (!bbox) return null
  if (!Array.isArray(ring) || ring.length < 3) return bbox
  let minY = Infinity
  let maxY = -Infinity
  for (const pt of ring) {
    if (!Array.isArray(pt) || typeof pt[1] !== 'number') continue
    if (pt[1] < minY) minY = pt[1]
    if (pt[1] > maxY) maxY = pt[1]
  }
  if (!Number.isFinite(minY) || maxY <= minY) return bbox
  let bestMidX = bbox[0]
  let bestY = bbox[1]
  let bestW = -1
  // Multiple scanlines dodge a vertex-aligned degenerate line (where the
  // even-odd crossing count is unreliable); the widest span across all of
  // them is the sturdiest interior estimate.
  for (const frac of [0.5, 0.4, 0.6, 0.3, 0.7]) {
    const y = minY + (maxY - minY) * frac
    const xs: number[] = []
    for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
      const a = ring[i]
      const b = ring[j]
      if (!Array.isArray(a) || !Array.isArray(b)) continue
      const ay = a[1]
      const by = b[1]
      if (typeof ay !== 'number' || typeof by !== 'number') continue
      // Edge straddles the scanline (half-open `<=` convention avoids
      // double-counting a shared vertex on the boundary).
      if (ay <= y !== by <= y) {
        const t = (y - ay) / (by - ay)
        xs.push((a[0] as number) + t * ((b[0] as number) - (a[0] as number)))
      }
    }
    xs.sort((p, q) => p - q)
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const w = xs[k + 1]! - xs[k]!
      if (w > bestW) {
        bestW = w
        bestMidX = (xs[k]! + xs[k + 1]!) / 2
        bestY = y
      }
    }
  }
  return bestW > 0 ? [bestMidX, bestY] : bbox
}

/** Total planar length of a polyline (lon/lat units — relative use only). */
function polylineLength(coords: [number, number][]): number {
  let len = 0
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1]
    const b = coords[i]
    if (!Array.isArray(a) || !Array.isArray(b)) continue
    if (typeof a[0] !== 'number' || typeof b[0] !== 'number') continue
    len += Math.hypot(b[0] - a[0], b[1] - a[1])
  }
  return len
}

/** The longest sub-chain of a MultiLineString — fixes the old `coordinates[0]`
 *  which labelled whichever chain came first, not the dominant one. */
function longestChain(chains: [number, number][][]): [number, number][] {
  let best: [number, number][] = []
  let bestLen = -1
  for (const ch of chains) {
    if (!Array.isArray(ch)) continue
    const l = polylineLength(ch as [number, number][])
    if (l > bestLen) {
      bestLen = l
      best = ch as [number, number][]
    }
  }
  return best
}

/** The point at 50% cumulative arc-length along a polyline — a point ON the
 *  line, unlike the bbox centre which floats off a curved / L-shaped chain
 *  (the line half of #727). Malformed vertices are skipped; a single valid
 *  vertex returns itself; a zero-length chain returns its first vertex. */
function lineMidpoint(coords: [number, number][]): [number, number] | null {
  if (!Array.isArray(coords) || coords.length === 0) return null
  const clean = coords.filter(
    (p) => Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number',
  ) as [number, number][]
  if (clean.length === 0) return null
  if (clean.length === 1) return clean[0]!
  const total = polylineLength(clean)
  if (total <= 0) return clean[0]!
  const half = total / 2
  let acc = 0
  for (let i = 1; i < clean.length; i++) {
    const a = clean[i - 1]!
    const b = clean[i]!
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (acc + seg >= half) {
      const t = seg > 0 ? (half - acc) / seg : 0
      return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]
    }
    acc += seg
  }
  return clean[clean.length - 1]!
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
  cameraPitch?: number,
): GeoJSONFeatureCollection {
  // Defensive: null/undefined data short-circuits before `.features`
  // access. The host's data-load step can hand applyFilter a
  // partially-constructed dataset mid-stream; .features on null was
  // a hard crash.
  if (!data || !filterExpr?.ast || !Array.isArray(data.features)) return data
  const ast = filterExpr.ast as AST.Expr
  const filtered = data.features.filter((f) => {
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
      // Raw geometry for the Mapbox `["within"]` containment predicate
      // (lowered to `within(get("$geometry"), …)`). GeoJSON features are
      // already in lng/lat — the same space as the `within` polygon arg —
      // so no reprojection is needed here.
      geometry: f.geometry,
      featureId: (f as { id?: string | number }).id,
      cameraZoom,
      cameraPitch,
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
    // NaN filter result → false. Mirror of filter-eval.ts NaN guard:
    // pre-fix `result !== 0` accepted NaN as truthy and a filter
    // returning NaN (e.g. corrupted property divided by zero) let
    // every feature through.
    if (typeof result === 'number') return result !== 0 && Number.isFinite(result)
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
  cameraPitch?: number,
): GeoJSONFeatureCollection {
  // Guard against a malformed FeatureCollection — `applyFilter` has
  // the same `!data.features` short-circuit. Without this, `.map(...)`
  // throws when the runtime receives a no-features payload (e.g. an
  // empty source or a partial transfer mid-load) and the host's data-
  // load step crashes the whole rebuild.
  if (!data || !Array.isArray(data.features)) return data
  const ast = geometryExpr.ast as AST.Expr
  const newFeatures = data.features.map((f) => {
    const bag = makeEvalProps({
      props: f.properties ?? undefined,
      geometryType: f.geometry?.type,
      featureId: (f as { id?: string | number }).id,
      cameraZoom,
      cameraPitch,
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
