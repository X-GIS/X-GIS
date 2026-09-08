// ═══ PMTiles Backend — Pure Helpers ═══
// Top-level pure free functions extracted verbatim from
// pmtiles-backend.ts (no `this`, no module-mutable state, no side
// effects beyond reading the environment). Behaviour-preserving
// structural split only; no logic or symbol renames.

import { EARTH, isMobileClassViewport, linkScaledConcurrency } from '@xgis/shared'

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
 *  cheap (one property read + one classifier call) and always
 *  reflects the live viewport. */
export function maxInflight(): number {
  const w = (typeof window !== 'undefined' ? window.innerWidth : 0) || 0
  // Scaled by link cost as well as device class (#1356) — same composition as
  // the catalog-level cap this sits under.
  return linkScaledConcurrency(isMobileClassViewport(w) ? 4 : 16)
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
  const R = EARTH.sphereR
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
