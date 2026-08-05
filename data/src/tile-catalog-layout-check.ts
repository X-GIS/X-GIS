// ═══ Tile layout-version drift check ═══
//
// Extracted from tile-catalog.ts (#1570) to pay for the post-destroy latch under that
// file's LOC ceiling. Logic unchanged.

import { xlog } from '@xgis/shared'
import { layoutVersionMismatch } from './tile-catalog-helpers'
import { TILE_LAYOUT_VERSION, TILE_LAYOUT_VERSION_BASE, type TileSource } from './tile-source'

/** Evict a backend's cached tiles when its cached layout version is not the running
 *  one, so the next visible frame re-decodes through the new layout. The warn fires
 *  ONCE per (catalog, backend) pair — `warned` is the catalog's own WeakSet, which is
 *  what scopes "once" to the catalog rather than to the process. */
export function checkBackendLayoutVersion(
  backend: TileSource,
  warned: WeakSet<TileSource>,
  evictForBackend: () => void,
): void {
  const v = backend.meta.layoutVersion
  if (!layoutVersionMismatch(v)) return
  evictForBackend()
  if (warned.has(backend)) return
  warned.add(backend)
  xlog.warn(
    `[X-GIS] tile-layout-version mismatch for source: cached=${v ?? TILE_LAYOUT_VERSION_BASE}, running=${TILE_LAYOUT_VERSION} — evicting cache + re-decoding`,
  )
}
