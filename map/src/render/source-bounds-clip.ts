// ═══ Source-level spatial-extent clip for the raster / raster-dem selectors (#1984) ═══
//
// Mapbox `source.bounds: [west, south, east, north]` declares where a source HAS data.
// The vector family has honoured it since PMTilesBackend shipped — `hasTile` runs the
// archive's own header / TileJSON-manifest bounds through `tileIntersectsBounds`. The
// raster family had no equivalent: `visibleTilesFrustum` / `globeVisibleTiles` are
// global selectors, so a regional source (a city orthophoto, a national DEM) got the
// full frustum's worth of ocean tiles requested every frame — all guaranteed 404s,
// spending the same fixed concurrency budget the visible tiles are waiting on.
//
// This is the shared seam both raster renderers filter through, so the two twins cannot
// drift, and it delegates the overlap test itself to `tileIntersectsBounds` rather than
// re-deriving it: one authority for "does this tile touch the box", three callers.
//
// OVERLAP, NOT CONTAINMENT. The predicate keeps every tile whose extent MEETS the box,
// which deliberately includes a tile that swallows the box whole. Those coarse parents
// are what the fallback ladder draws while the leaves stream in (raster-renderer's
// parent-fallback prefetch walks 1–2 levels up from each selected tile), so a
// containment test would blank the source for the whole load — the classic bounds-clip
// bug. Pinned in both directions in source-bounds-clip.test.ts.
//
// NO ANTIMERIDIAN WRAPAROUND. Mapbox / TileJSON bounds do not cross the antimeridian,
// and MapLibre's own `TileBounds` clamps each component into range and then tests
// `minX <= maxX`, so a `west > east` box is EMPTY there rather than wrapped. Rather
// than invent a wrap the reference renderer does not have, or silently adopt its
// blank-the-source behaviour, `normalizeSourceBounds` rejects such a box and the source
// stays UNCLIPPED — the pre-existing behaviour — while the converter warns at author
// time (compiler/src/convert/sources.ts).

import { tileIntersectsBounds } from '@xgis/data'

/** `[west, south, east, north]` in WGS84 degrees — the Mapbox source-bounds order. */
export type SourceBounds = [number, number, number, number]

/** Accept a declared box only if it can actually clip: 4 finite numbers, a non-inverted
 *  latitude span, a non-wrapping longitude span, and both within WGS84 range. Anything
 *  else returns undefined, which every caller treats as "no clip" — a malformed box
 *  must never be able to blank a source (the failure mode is invisible: no request is
 *  made, so there is nothing to 404 and nothing in the network log to explain it). */
export function normalizeSourceBounds(v: unknown): SourceBounds | undefined {
  if (!Array.isArray(v) || v.length !== 4) return undefined
  if (!v.every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined
  const [west, south, east, north] = v as SourceBounds
  if (west >= east || south >= north) return undefined
  if (west < -180 || east > 180 || south < -90 || north > 90) return undefined
  return [west, south, east, north]
}

/** Drop the selected tiles that cannot overlap `bounds`. Returns the SAME array when
 *  there is nothing to clip, so an un-declaring source allocates nothing per frame. */
export function clipTilesToBounds<T extends { z: number; x: number; y: number }>(
  tiles: T[],
  bounds: SourceBounds | undefined,
): T[] {
  if (!bounds) return tiles
  // `x`, never `ox`: the world-copy offset repeats the SAME geography, and the tile key
  // / URL are built from `x`, so filtering on `ox` would keep or drop copies of one
  // logical tile inconsistently.
  return tiles.filter((t) => tileIntersectsBounds(t.z, t.x, t.y, bounds))
}
