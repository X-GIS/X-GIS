// ═══ PMTiles Backend — Pure Helpers ═══
// Top-level pure free functions extracted verbatim from
// pmtiles-backend.ts (no `this`, no module-mutable state, no side
// effects beyond reading the environment). Behaviour-preserving
// structural split only; no logic or symbol renames.

import { evaluate, makeEvalProps, type GeoJSONFeature } from '@xgis/compiler'
import { evalExtrudeExpr } from '../eval/extrude-eval'

/** Same height extractor as the worker (mvt-worker.ts). The inline
 *  fallback path can't import from mvt-worker because its module is
 *  worker-only (top-level postMessage handler), so we duplicate the
 *  helper. Keep in sync with the worker copy. */
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
        expr as never,
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
        expr as never,
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

/** Per-backend cap on simultaneous in-flight HTTP fetches. Independent
 *  of catalog-level MAX_CONCURRENT_LOADS — protects this backend from
 *  oversubscribing one archive's network. Mobile gets a tighter cap
 *  because each in-flight fetch holds a directory-page reference in
 *  the pmtiles client + an MVT decode in the worker queue. User-
 *  reported forced refresh on iPhone after sustained pinch+drag
 *  navigation traced to fetch / decode pressure compounding faster
 *  than the GPU could drain it.
 *
 *  Evaluated lazily — module top-level resolution would race the
 *  Playwright viewport apply (and real mobile DPR setup), so a
 *  module-init `MAX_INFLIGHT = …` constant could capture the wrong
 *  value before the host page is fully laid out. The function form
 *  re-checks `window.innerWidth` at every loadTile entry, which is
 *  cheap (one property read + one comparison) and always reflects
 *  the live viewport. */
export function maxInflight(): number {
  const w = (typeof window !== 'undefined' ? window.innerWidth : 0) || 0
  return w > 0 && w <= 900 ? 4 : 16
}

/** Per-key negative cache TTL (ms) for tiles that the fetcher has
 *  reported `'failed'` for. While a key is in the failed cache,
 *  loadTile returns immediately without dispatching a new fetch and
 *  without calling acceptResult — so the catalog's hasTileData stays
 *  false, and the renderer's parent-walk continues to find the
 *  failed tile "missing" and falls back to the nearest cached
 *  ancestor. After the TTL, the next visible-tile pass retries the
 *  fetch once (in case the upstream issue resolved). */
/** Negative cache TTL with progressive backoff. The previous flat
 *  5-minute TTL was too aggressive for transient failures (iOS Safari
 *  network blips, CDN edge hiccups, momentary 5xx) — once a tile
 *  failed three retry attempts, it stayed missing for 5 full minutes
 *  even after the upstream recovered. User-visible symptom: 21 tiles
 *  persistently flickering on a parked iPhone view of NYC because they
 *  failed once and got locked out.
 *
 *  Exponential backoff per consecutive failure:
 *    1st failure → 15 s   (transient blip recovers fast)
 *    2nd failure → 30 s
 *    3rd failure → 1 min
 *    4th failure → 2 min
 *    5th+        → 5 min  (cap — likely permanent or upstream broken)
 *
 *  A successful fetch clears the count, so a tile that recovers stops
 *  paying the longer backoff window even if it failed N-1 times before. */
export function failedKeyTtlMs(consecutiveFailures: number): number {
  const seconds = Math.min(15 * Math.pow(2, consecutiveFailures - 1), 300)
  return seconds * 1000
}

/** Tile dimensions in Mercator metres — used by the worker's
 *  buildLineSegments call for tile-edge boundary detection.
 *  Computed on main and passed to the worker so the worker doesn't
 *  redo the trig per tile. */
export function tileSizeMerc(z: number, y: number): { widthMerc: number; heightMerc: number } {
  const DEG2RAD = Math.PI / 180
  const R = 6378137
  const LAT_LIMIT = 85.051129
  const clamp = (v: number) => Math.max(-LAT_LIMIT, Math.min(LAT_LIMIT, v))
  const n = 1 << z
  const widthMerc = (360 / n) * DEG2RAD * R
  const yToLat = (yt: number) => {
    const s = Math.PI - 2 * Math.PI * (yt / n)
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(s) - Math.exp(-s)))
  }
  const latNorth = yToLat(y)
  const latSouth = yToLat(y + 1)
  const myNorth = Math.log(Math.tan(Math.PI / 4 + (clamp(latNorth) * DEG2RAD) / 2)) * R
  const mySouth = Math.log(Math.tan(Math.PI / 4 + (clamp(latSouth) * DEG2RAD) / 2)) * R
  return { widthMerc, heightMerc: myNorth - mySouth }
}

/** True if Web-Mercator tile (z, x, y) overlaps the given lon/lat bounds. */
export function tileIntersectsBounds(
  z: number,
  x: number,
  y: number,
  bounds: [number, number, number, number],
): boolean {
  const n = 1 << z
  const tileWest = (x / n) * 360 - 180
  const tileEast = ((x + 1) / n) * 360 - 180
  const yToLat = (yt: number) => {
    const s = Math.PI - 2 * Math.PI * (yt / n)
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(s) - Math.exp(-s)))
  }
  const tileNorth = yToLat(y)
  const tileSouth = yToLat(y + 1)
  return !(
    tileEast < bounds[0] ||
    tileWest > bounds[2] ||
    tileNorth < bounds[1] ||
    tileSouth > bounds[3]
  )
}
