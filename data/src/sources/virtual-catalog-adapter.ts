// Legacy back-compat adapter for setVirtualCatalog (the old hook
// PMTiles wired through). The legacy fetcher returns a fully
// CompiledTile and pushes it via sink immediately on resolve —
// no two-stage fetch/compile split, no tick.
//
// Kept as a separate class so the new PMTilesBackend can adopt the
// paced raw-bytes pipeline without breaking the
// virtual-catalog-fetch.test.ts assertions that synthesise their
// own CompiledTile-returning fetcher in tests.
//
// New PMTiles loader code should use PMTilesBackend directly
// (via attachBackend); this adapter exists only for the
// VirtualCatalog interface that predates PMTilesBackend.

import { xlog } from '@xgis/shared'
import { tileKeyUnpack } from '@xgis/compiler'
import {
  TILE_LAYOUT_VERSION,
  type TileSource,
  type TileSourceSink,
  type TileSourceMeta,
  type BackendTileResult,
} from '../tile-source'

import { failedKeyTtlMs } from './pmtiles-backend-helpers'

import type { VirtualCatalog } from '../tile-types'
import type { CompiledTile } from '@xgis/compiler'

const MAX_INFLIGHT = 32

export class VirtualCatalogAdapter implements TileSource {
  readonly meta: TileSourceMeta
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- adapter bridges the deprecated VirtualCatalog to VirtualTileFetcher
  private catalog: VirtualCatalog
  private sink: TileSourceSink | null = null

  /** #2108 — per-key consecutive-failure ledger, the thing this adapter was
   *  missing entirely. Without it a persistently failing fetcher was re-invoked
   *  (and re-logged) on EVERY frame that still wanted the tile: `loadTile`
   *  releases the key on failure — which is correct and must stay, since holding
   *  it is the #2091 wedge — and nothing then remembered that the key had just
   *  failed.
   *
   *  Entries deliberately OUTLIVE their TTL (they are not pruned on read) so the
   *  `count` survives to drive the next backoff window; only a SUCCESSFUL fetch
   *  deletes one. That mirrors `PMTilesBackend`, whose ledger this is a minimal
   *  sibling of — the escalation policy itself is imported (`failedKeyTtlMs`)
   *  rather than restated, so there is no second authority for "how long do we
   *  back off" (CLAUDE.md §12). */
  private readonly failedKeys = new Map<number, { expiresAt: number; count: number }>()

  /** Bound on the ledger. An UNBOUNDED failed-key map is already classified as a
   *  bug in this repo twice (#282 / #1354: "panning across a broken region
   *  inserts one entry per tile ... without a bound the Map grows for the page
   *  lifetime"); `PMTilesBackend.FAILED_KEYS_MAX` is the same number on purpose. */
  private static readonly FAILED_KEYS_MAX = 4096

  // eslint-disable-next-line @typescript-eslint/no-deprecated -- adapter bridges the deprecated VirtualCatalog to VirtualTileFetcher
  constructor(catalog: VirtualCatalog) {
    this.catalog = catalog
    this.meta = {
      bounds: catalog.bounds,
      minZoom: catalog.minZoom,
      maxZoom: catalog.maxZoom,
      // The legacy `VirtualCatalog` interface is Web Mercator XYZ by API
      // contract (z/x/y slippy fetcher). Declared explicitly so future
      // schemes don't silently inherit the assumption.
      scheme: 'web-mercator-xyz',
      // Declares the polygon vertex byte format this backend emits. Catalog
      // evicts cached tiles on attach if the runtime's TILE_LAYOUT_VERSION
      // moves past what's cached (PR 2c.4).
      layoutVersion: TILE_LAYOUT_VERSION,
      propertyTable: { fieldNames: [], fieldTypes: [], values: [] },
      entries: undefined,
    }
  }

  attach(sink: TileSourceSink): void {
    this.sink = sink
  }

  has(key: number): boolean {
    const [z, x, y] = tileKeyUnpack(key)
    if (z < this.meta.minZoom || z > this.meta.maxZoom) return false
    return tileIntersectsBounds(z, x, y, this.meta.bounds)
  }

  loadTile(key: number): void {
    if (!this.sink) return
    if (this.sink.hasTileData(key)) return
    // #2108 — inside the backoff window, do not re-dispatch (and do not re-log).
    // This is the whole fix for the per-frame fetch/log storm; the window is
    // TTL'd, never permanent, because a permanent lockout is its own user-visible
    // bug (see `failedKeyTtlMs`: 21 tiles stuck flickering after one failure).
    if (this.isFailed(key)) return
    if (this.sink.getLoadingCount() >= MAX_INFLIGHT) return
    const [z, x, y] = tileKeyUnpack(key)
    const sink = this.sink
    sink.trackLoading(key)
    // #2091 — nothing the fetcher does may strand the key in `loadingTiles`:
    // a SYNCHRONOUS throw escaped before .then/.catch attached, so the release
    // below never ran and `hasPendingLoads()` stayed true for the session —
    // starving the `idle` event (whose predicate folds pending source work)
    // and every consumer gated on first-idle. `Promise.resolve` also covers a
    // fetcher that returns a NON-THENABLE (a hand-written or mistyped
    // implementation): without it, `.then` would throw here and strand the key
    // the same way. A released key is re-requested on a later frame, exactly
    // as it is after an async rejection — same semantics for both shapes.
    let pending: Promise<CompiledTile | null>
    try {
      pending = Promise.resolve(this.catalog.fetcher(z, x, y))
    } catch (err) {
      sink.releaseLoading(key)
      this.noteFailure(key)
      xlog.error('[virtual-catalog fetch]', (err as Error)?.stack ?? err)
      return
    }
    pending
      .then((tile) => {
        sink.releaseLoading(key)
        // A resolved fetch is a success even when it yields no tile: `null` is the
        // backend's "this key genuinely has no data" answer, which acceptResult
        // caches as an empty placeholder. Neither shape is a failure to back off from.
        this.failedKeys.delete(key)
        sink.acceptResult(
          key,
          tile
            ? ({
                vertices: tile.vertices,
                dequantScale: tile.dequantScale,
                dequantHalf: tile.dequantHalf,
                indices: tile.indices,
                lineVertices: tile.lineVertices,
                lineIndices: tile.lineIndices,
                pointVertices: tile.pointVertices,
                // eslint-disable-next-line @typescript-eslint/no-deprecated -- reads the deprecated always-empty outlineIndices during the outline-frame migration
                outlineIndices: tile.outlineIndices,
                outlineVertices: tile.outlineVertices,
                outlineLineIndices: tile.outlineLineIndices,
                polygons: tile.polygons?.map((p) => ({ rings: p.rings, featId: p.featId })),
                fullCover: tile.fullCover,
                fullCoverFeatureId: tile.fullCoverFeatureId,
              } satisfies BackendTileResult)
            : null,
        )
      })
      .catch((err) => {
        sink.releaseLoading(key)
        this.noteFailure(key)
        xlog.error('[virtual-catalog fetch]', (err as Error)?.stack ?? err)
      })
  }

  /** Record one consecutive failure for `key` and arm its backoff window. */
  private noteFailure(key: number): void {
    const count = (this.failedKeys.get(key)?.count ?? 0) + 1
    this.failedKeys.set(key, { expiresAt: Date.now() + failedKeyTtlMs(count), count })
    // FIFO backstop (Map preserves insertion order, so the oldest go first).
    while (this.failedKeys.size > VirtualCatalogAdapter.FAILED_KEYS_MAX) {
      const oldest = this.failedKeys.keys().next().value
      if (oldest === undefined || oldest === key) break
      this.failedKeys.delete(oldest)
    }
  }

  /** TileSource.isFailed — true while `key`'s backoff window is still running.
   *  Surfaced by `TileCatalog.getTileState` as the `'failed'` lifecycle state. */
  isFailed(key: number): boolean {
    const failed = this.failedKeys.get(key)
    if (failed === undefined) return false
    return Date.now() < failed.expiresAt
  }

  /** TileSource.failureCount — CONSECUTIVE failures on record for `key`, 0 once a
   *  fetch succeeds. Deliberately not gated on the TTL still running: the entry
   *  survives expiry precisely to keep this number. `tile-decision.ts` reads it
   *  (through `TileCatalog`) to mark a decision terminal past
   *  `KEEP_WARM_MAX_FAILURES`, which is what lets the render loop stop holding a
   *  frame warm for a tile that is never going to arrive (#1596). Before this
   *  existed the adapter reported nothing, so that check could never fire here. */
  failureCount(key: number): number {
    return this.failedKeys.get(key)?.count ?? 0
  }
}

function tileIntersectsBounds(
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
