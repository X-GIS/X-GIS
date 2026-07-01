// Pure free functions extracted from vector-tile-loader.ts.
//
// detectVectorTileFormat / resolveDispatch are re-exported from
// vector-tile-loader.ts to preserve every prior import path. memoizeOpen and
// normalizeVectorLayers are internal helpers consumed by the loader module.
// Every function here is pure: no `this`, no module-level state, no side
// effects beyond what the caller passes in (memoizeOpen mutates the cache Map
// it is handed, never module-global state).

import type { VectorTileFormat, VectorLayerInfo } from './vector-tile-loader-types'

/** Single source of truth for "what format is at `url`". Used by the
 *  data-load loop to decide if a load is a vector tile source at all,
 *  by `VectorTileLoader.sourceFor` to pick which subclass to instantiate,
 *  and by `prewarm` to pick which cache to prime.
 *
 *  Routing precedence (most-authoritative first):
 *    1. URL extension is decisive when present (`.tilejson` / `.json`,
 *       `.pmtiles`, `.xgvt`). The server is the source of truth for
 *       what bytes come back — an explicit `kind: pmtiles` from a stale
 *       xgis source can't override a `.json` URL (that broke the
 *       protomaps `.pmtiles → api.protomaps.com/v4.json?key=…` rewrite
 *       with "Wrong magic number" before the URL-wins rule landed).
 *       `.geojson` is excluded so feature-data URLs aren't mis-routed.
 *    2. Otherwise honour explicit `kind`.
 *    3. Fall through to `null` — caller decides what to do with the
 *       unknown URL. */
export function detectVectorTileFormat(
  url: string,
  kind?: VectorTileFormat | 'auto',
): VectorTileFormat | null {
  // Defensive: non-string url would crash at `.split('?')` (only
  // available on string). Empty string is permissible to fall
  // through to the kind-fallback branch / null return below.
  if (typeof url !== 'string') return null
  // Strip BOTH query (?…) and fragment (#…) before extension matching.
  // Pre-fix only `?` was split off, so a URL like 'x.pmtiles#frag'
  // kept '#frag' in the path → endsWith('.pmtiles') failed → fell to
  // null and the caller defaulted to PMTiles which crashed on the
  // wrong-magic-number boundary. Mirror of the compiler-side fragment
  // detection fix (8885924).
  // Strip the Protomaps `pmtiles://` scheme prefix if a host passed
  // it through bypassing the converter side. Mirror of the compiler
  // strip (3b81145). The protomaps/PMTiles library expects a bare
  // URL; without the strip the format detection still routed pmtiles
  // (since the inner URL ends with .pmtiles) but the subsequent
  // fetch failed on the `pmtiles:` scheme.
  // Case-insensitive scheme strip per RFC 3986 §3.1 — `PMTILES://...`
  // is the same URI as `pmtiles://...`. Path extension matching is
  // ALSO case-insensitive so `.PMTILES` / `.JSON` / `.TILEJSON` from a
  // case-tolerant server (Windows-style or S3 keys uppercased by an
  // upstream rewrite) route correctly instead of falling to the null
  // return + PMTiles-default crash on Wrong magic number.
  const stripped = /^pmtiles:\/\//i.test(url) ? url.slice('pmtiles://'.length) : url
  const path = stripped.split('?')[0]!.split('#')[0]!
  const lcPath = path.toLowerCase()
  if (lcPath.endsWith('.tilejson')) return 'tilejson'
  if (lcPath.endsWith('.json') && !lcPath.endsWith('.geojson')) return 'tilejson'
  if (lcPath.endsWith('.pmtiles')) return 'pmtiles'
  // Mapbox-style vector sources can declare `tiles: ["…/{z}/{x}/{y}.mvt"]`
  // (single-tile XYZ endpoint, no TileJSON manifest). Route those into
  // the MVT path; the loader synthesises a minimal TileJSON wrapper
  // around the template so the rest of the vector-tile pipeline doesn't
  // need to know whether the source had a real manifest or not.
  // ALSO accept extensionless `{z}/{x}/{y}` URLs — some Mapbox styles
  // (and OSM-derived hosts) author the XYZ template without a file
  // extension. The presence of all three placeholders is a strong
  // signal the URL is a per-tile fetch template, not a manifest. Pre-
  // fix this case fell to the `null` return and the caller defaulted
  // to PMTiles, which then failed with "Wrong magic number" on the
  // first fetch.
  if (kind === 'auto' || kind === 'tilejson') {
    if (lcPath.endsWith('.mvt') || lcPath.endsWith('.pbf')) return 'tilejson'
    if (url.includes('{z}') && url.includes('{x}') && url.includes('{y}')) {
      return 'tilejson'
    }
  }
  if (kind && kind !== 'auto') return kind
  return null
}

/** @deprecated Use {@link detectVectorTileFormat}. PMTiles is the
 *  legacy fallback for unknown URLs declared as a vector tile source,
 *  preserved for back-compat with `type: pmtiles` xgis declarations
 *  pointing at extensionless archives. */
export function resolveDispatch(
  url: string,
  kind: 'pmtiles' | 'tilejson' | 'auto' | undefined,
): 'pmtiles' | 'tilejson' {
  const f = detectVectorTileFormat(url, kind)
  return f === 'tilejson' ? 'tilejson' : 'pmtiles'
}

/** Memoize an in-flight fetch by URL: dedupes concurrent callers, evicts
 *  on rejection so the next call retries instead of resolving the cached
 *  failure forever. */
export function memoizeOpen<T>(
  cache: Map<string, Promise<T>>,
  url: string,
  factory: () => Promise<T>,
): Promise<T> {
  const hit = cache.get(url)
  if (hit) return hit
  const promise = factory()
  promise.catch(() => cache.delete(url))
  cache.set(url, promise)
  return promise
}

/** Normalize a TileJSON / PMTiles `vector_layers[]` entry. Both formats
 *  use the same shape but different default-zoom plumbing, so the per-
 *  layer minzoom/maxzoom fall back to the SOURCE's overall zoom range
 *  when a layer omits them. */
export function normalizeVectorLayers(
  raw: Array<{ id: string; minzoom?: number; maxzoom?: number; fields?: Record<string, string> }> | undefined,
  defaultMin: number,
  defaultMax: number,
): VectorLayerInfo[] {
  return (raw ?? []).map(vl => ({
    id: vl.id,
    minzoom: vl.minzoom ?? defaultMin,
    maxzoom: vl.maxzoom ?? defaultMax,
    fields: vl.fields,
  }))
}
