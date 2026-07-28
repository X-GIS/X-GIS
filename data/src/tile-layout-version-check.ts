// ═══ Tile-layout-version mismatch check ═══
//
// Extracted from TileCatalog, which sits on a shrink-only LOC ceiling. This is
// the one attach-time concern with no dependency on catalog internals beyond
// two injectable seams (evict + the once-per-pair warn set), so it lifts out
// cleanly and stays directly testable.

import { xlog } from '@xgis/shared'
import { TILE_LAYOUT_VERSION, TILE_LAYOUT_VERSION_BASE, type TileSource } from './tile-source'

/** Compare the attaching backend's `meta.layoutVersion` against the running
 *  runtime's `TILE_LAYOUT_VERSION`. On mismatch, evict any cached tiles
 *  attributable to this backend (and the legacy unattributed entries) so the
 *  next visible frame re-decodes through the new layout.
 *
 *  Backends shipped before the field existed surface as `undefined`; that is
 *  treated as `TILE_LAYOUT_VERSION_BASE`. The warn fires once per (catalog,
 *  backend) pair — the caller owns `warned`, so the "once" is scoped to the
 *  catalog rather than to this module. */
export function checkTileLayoutVersion(
  backend: TileSource,
  warned: WeakSet<TileSource>,
  evictTilesForBackend: (b: TileSource) => void,
): void {
  const v = backend.meta.layoutVersion
  const mismatch =
    v === undefined ? TILE_LAYOUT_VERSION > TILE_LAYOUT_VERSION_BASE : v !== TILE_LAYOUT_VERSION
  if (!mismatch) return
  evictTilesForBackend(backend)
  if (warned.has(backend)) return
  warned.add(backend)
  xlog.warn(
    `[X-GIS] tile-layout-version mismatch for source: cached=${v ?? TILE_LAYOUT_VERSION_BASE}, running=${TILE_LAYOUT_VERSION} — evicting cache + re-decoding`,
  )
}
