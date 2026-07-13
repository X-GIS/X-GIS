import { xlog } from '@xgis/shared'
import { toU32Id } from '@xgis/data'
import type { GeoJSONFeature } from '@xgis/data'
import type { RawDataset } from './map-types'

/** Host hooks the queue needs to read shared map state and trigger a
 *  retile/rebuild. Passed by reference at construction so the queue sees
 *  the live `rawDatasets` map and the current destroyed flag. */
export interface FeatureUpdateQueueHost {
  /** Live source-id → FeatureCollection map (read by reference). */
  readonly rawDatasets: Map<string, RawDataset>
  /** True once the owning map has been destroyed — a flush must bail. */
  isDestroyed(): boolean
  teardownSource(sourceId: string): void
  rebuildLayers(): void
  invalidate(): void
}

/** External-injection update state + flush pipeline extracted from
 *  map.ts (2026-06-18 runtime redesign §3.2 "FeatureUpdateQueue").
 *
 *  Owns the pending-patch queue, the coalescing rAF handle, the
 *  warn-once sets, and the lazy featureId→feature index. Behavior is a
 *  verbatim relocation of the former Map methods — same execution order,
 *  same coercions, same warnings. */
export class FeatureUpdateQueue {
  private _pendingPatches = new Map<
    string,
    Map<number, { geometry?: GeoJSONFeature['geometry']; properties?: Record<string, unknown> }>
  >()
  private _pendingFlushHandle: number | null = null
  private _unknownSourceWarned = new Set<string>()
  // Tile-backed (URL-loaded) sources store a marker, not a FeatureCollection,
  // so updateFeature can't patch them. Warn once per source (see updateFeature).
  private _tileBackedUpdateWarned = new Set<string>()
  // Lazy featureId → feature index per source, so flushPendingUpdates can
  // patch in O(patches) instead of O(features). Invalidated on setSourceData
  // (full replace) and rebuilt on demand.
  readonly featureIndex = new Map<string, Map<number, GeoJSONFeature>>()

  constructor(private readonly host: FeatureUpdateQueueHost) {}

  /** The live pending-patch queue (source-id → featureId → patch). Read
   *  by map.ts's `_pendingPatches` delegating accessor; the same Map
   *  instance, so callers that mutate it (e.g. seed a source) and the
   *  destroy() teardown that clears it operate on shared state. */
  get pendingPatches(): Map<
    string,
    Map<number, { geometry?: GeoJSONFeature['geometry']; properties?: Record<string, unknown> }>
  > {
    return this._pendingPatches
  }

  /** The coalescing flush rAF handle (or setTimeout-fallback id), or null
   *  when no flush is queued. Exposed for map.ts's `_pendingFlushHandle`
   *  delegating accessor so destroy() teardown cancels the same handle. */
  get pendingFlushHandle(): number | null {
    return this._pendingFlushHandle
  }
  set pendingFlushHandle(handle: number | null) {
    this._pendingFlushHandle = handle
  }

  /** Feature-level mutation. Enqueues a patch and coalesces all
   *  pending updates within a single rAF into one retile per source.
   *
   *  `featureId` matches the stable id (GeoJSON feature.id → u32).
   *  Unknown source or feature logs a warn-once and drops the patch
   *  (a host race under reconnect is expected, not fatal). */
  updateFeature(
    sourceId: string,
    featureId: number,
    patch: { geometry?: GeoJSONFeature['geometry']; properties?: Record<string, unknown> },
  ): void {
    if (!this.host.rawDatasets.has(sourceId)) {
      if (!this._unknownSourceWarned.has(sourceId)) {
        xlog.warn(`[X-GIS] updateFeature: unknown source "${sourceId}"`)
        this._unknownSourceWarned.add(sourceId)
      }
      return
    }
    // Tile-backed markers carry no FeatureCollection, so a patch would be
    // silently dropped at flush. Warn-once at enqueue time so the host learns
    // immediately rather than discovering a no-op.
    const dataset = this.host.rawDatasets.get(sourceId)
    if (!dataset || !Array.isArray((dataset as { features?: unknown }).features)) {
      if (!this._tileBackedUpdateWarned.has(sourceId)) {
        xlog.warn(
          `[X-GIS] updateFeature: source "${sourceId}" is tile-backed (URL-loaded); feature updates are only supported for host-pushed GeoJSON sources (setSourceData)`,
        )
        this._tileBackedUpdateWarned.add(sourceId)
      }
      return
    }
    let bySource = this._pendingPatches.get(sourceId)
    if (!bySource) {
      bySource = new Map()
      this._pendingPatches.set(sourceId, bySource)
    }
    const existing = bySource.get(featureId)
    // Defensive: coerce non-plain-object patch.properties to {} so a
    // host passing a string / array (TypeScript-cast at the boundary)
    // doesn't spread char/index keys into the patched feature props.
    // Mirror of the makeEvalProps coercion (4e11bb7).
    const patchProps = patch.properties
    const safePatchProps =
      patchProps !== null &&
      patchProps !== undefined &&
      typeof patchProps === 'object' &&
      !Array.isArray(patchProps)
        ? patchProps
        : {}
    bySource.set(featureId, {
      geometry: patch.geometry ?? existing?.geometry,
      properties: { ...(existing?.properties ?? {}), ...safePatchProps },
    })
    this.scheduleFlushPendingUpdates()
    this.host.invalidate()
  }

  private scheduleFlushPendingUpdates(): void {
    if (this._pendingFlushHandle !== null) return
    const raf =
      typeof window !== 'undefined' && window.requestAnimationFrame
        ? window.requestAnimationFrame.bind(window)
        : // Principled cast: this package's mixed global surface types
          // setTimeout with the node-flavored Timeout return while
          // clearTimeout accepts only the DOM number id, so no cast-free
          // spelling exists. The runtime value IS a numeric id in every
          // environment this fallback runs in (jsdom / SSR shims).
          (cb: FrameRequestCallback): number =>
            setTimeout(() => cb(performance.now()), 16) as unknown as number
    this._pendingFlushHandle = raf(() => this.flushPendingUpdates())
  }

  private flushPendingUpdates(): void {
    this._pendingFlushHandle = null
    if (this.host.isDestroyed()) return
    if (this._pendingPatches.size === 0) return

    for (const [sourceId, patches] of this._pendingPatches) {
      const data = this.host.rawDatasets.get(sourceId)
      // Non-FeatureCollection shape (tile-backed marker / legacy direct write):
      // `.features` not being an array would crash the for-of. updateFeature
      // rejects markers at enqueue time; a patch reaching here warns once so
      // the no-op is observable rather than silent. `'features' in data`
      // narrows the RawDataset union to the FeatureCollection arm.
      if (!data || !('features' in data) || !Array.isArray(data.features)) {
        if (!this._tileBackedUpdateWarned.has(sourceId)) {
          xlog.warn(
            `[X-GIS] updateFeature: source "${sourceId}" is not a patchable FeatureCollection; ${patches.size} pending update(s) dropped`,
          )
          this._tileBackedUpdateWarned.add(sourceId)
        }
        continue
      }
      // Lookup via featureId index so patching is O(patches) instead of
      // O(features). The index is built once per source and reused across
      // flush cycles until setSourceData replaces the dataset.
      let index = this.featureIndex.get(sourceId)
      if (!index) {
        index = new Map()
        for (let i = 0; i < data.features.length; i++) {
          const f = data.features[i]
          // +1 on the fallback index branch mirrors the encode chokepoint
          // (geojson-compile-worker.ts:resolveIdResolver) so the stable id
          // the host receives from a pick event (i+1 for id-less features)
          // matches the key updateFeature patches against here.
          index.set(toU32Id(f.id ?? f.properties?.id ?? i + 1), f)
        }
        this.featureIndex.set(sourceId, index)
      }
      for (const [fid, patch] of patches) {
        const f = index.get(fid)
        if (!f) continue
        if (patch.geometry) f.geometry = patch.geometry
        if (patch.properties) {
          f.properties = { ...(f.properties ?? {}), ...patch.properties }
        }
      }
      // Trigger a single retile for this source.
      this.host.teardownSource(sourceId)
    }
    this._pendingPatches.clear()
    this.host.rebuildLayers()
  }

  /** Cancel the coalescing rAF (or setTimeout fallback) and drop all
   *  pending patches. Called from the owning map's destroy() teardown so
   *  a queued flush can't run copyTextureToBuffer/submit on a torn-down
   *  device. */
  destroy(): void {
    if (this._pendingFlushHandle !== null) {
      if (typeof window !== 'undefined' && window.cancelAnimationFrame) {
        window.cancelAnimationFrame(this._pendingFlushHandle)
      } else clearTimeout(this._pendingFlushHandle)
      this._pendingFlushHandle = null
    }
    this._pendingPatches.clear()
  }
}
