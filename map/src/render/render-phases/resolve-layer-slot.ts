import type { VectorTileRenderer, GuardedFrame } from '../vector-tile-renderer'
import type { RenderArgs, LayerSlot } from '../vector-tile-renderer-types'
import { computeSliceKey } from '@xgis/data'

/** #2508 phase 1 — resolve this layer's slot: the slice key the worker emitted
 *  the tiles under and the resident-tile cache for it, plus the per-frame
 *  bookkeeping that hangs off the slot (frame counter, draw-order trace, uniform
 *  ring). Returns `null` for the variant-pipeline guard — a show whose bind-group
 *  layout is not the base one and that has neither a feature group nor variant
 *  fields draws nothing this call, and `render()` stops there. */
export function resolveLayerSlot(
  vtr: VectorTileRenderer,
  args: RenderArgs,
  guard: GuardedFrame,
): LayerSlot | null {
  // Sliced-source slot for this layer. PMTiles emits per-show slices when
  // the source-attach config carries `showSlices` — the slice key combines
  // `sourceLayer` with a stable hash of the layer's `filter:` AST so xgis
  // layers sharing a source layer but differing in filter get DIFFERENT
  // slices. Without filter / for legacy sources (XGVT-binary,
  // GeoJSON-runtime, no-filter PMTiles), sliceKey collapses to plain
  // `sourceLayer` ('' for single-layer sources) — back-compat. Inline
  // GeoJSON shows lack explicit `sourceLayer`; the tilingPool emits MVT
  // bytes with `_layer = sourceName`, so VTR looks up by `targetName` —
  // without this fallback, filtered shows (filter_gdp) computed
  // sliceLayer='__hash' vs the worker's 'countries__hash' and tiles
  // dropped silently. show-source-maps.ts mirrors the fallback.
  const effectiveSourceLayer = args.show.sourceLayer || args.show.targetName || ''
  const sliceLayer = computeSliceKey(effectiveSourceLayer, args.show.filterExpr?.ast ?? null)
  // DIAG: capture per-frame draw order so the cross-tile depth
  // question ("is buildings actually drawn LAST?") is answered from
  // runtime behaviour rather than architectural reading. The Map's
  // beginFrame resets `__xgisDrawOrderTrace = []`; map.ts dumps it
  // after the frame and clears the flag. Production paths stay
  // silent unless the flag is set.
  if (typeof window !== 'undefined') {
    const trace = (
      window as unknown as {
        __xgisDrawOrderTrace?: Array<{
          seq: number
          slice: string
          phase: string
          extrude: string
          tileKey?: number
          isFill?: boolean
        }>
      }
    ).__xgisDrawOrderTrace
    if (trace) {
      // Stash for the per-tile drawIndexed entries renderTileKeys
      // is about to push.
      vtr._drawStats.setTrace(sliceLayer, args.phase)
    } else {
      vtr._drawStats.setTrace(null, null)
    }
  }
  // Pre-fetch this layer's gpuCache slot once. Hot-path lookups
  // become pure numeric Map.has/get — no composite-string alloc per
  // tile. Use getOrCreate so the reference stays valid even if this
  // is the first frame to upload a tile for this slice layer
  // (otherwise mid-render compileTileOnDemand → uploadTile would
  // create a fresh inner Map and our captured `undefined` would go
  // stale). Empty inner Maps for unused layers cost only a Map
  // allocation, no per-tile work.
  const layerCache = vtr.getOrCreateLayerCache(sliceLayer)

  // Variant-pipeline guard. Feature-buffer variants (match()/interpolate())
  // need `featureBindGroupLayout`, but `tileBgFeature` is built lazily
  // AFTER the async geojson worker compile resolves (map.ts:1082-1084);
  // between registration and resolution only `tileBgDefault` exists, and
  // drawing produced "Bind group layout ... does not match" validation
  // errors (~5/frame on fixture_picking). Skip until a feature bg is
  // ready — the layer pops in late, like any tile-load gap. Skip ONLY
  // when none is available ANYWHERE: GeoJSON satisfies this with the
  // source-level `this.tileBgFeature`; MVT/PMTiles with per-tile
  // `cached.featureBindGroup`s built at upload. Returning unconditionally
  // on `!this.tileBgFeature` was the OFM Bright school-fill bug — the MVT
  // path leaves it null by design (empty PropertyTable), so the landuse
  // `class` match variant never reached its tile loop; per-tile groups
  // are tested inside the loop.
  if (
    args.bindGroupLayout !== vtr._bindGroups.baseLayout() &&
    !vtr._bindGroups.featureGroup() &&
    vtr._featureBinder.latestVariantFieldsLength() === 0
  )
    return null

  vtr.frameCount++
  // Pass the FRAME-level id (set by beginFrame from map's
  // _frameCount, monotonic across render-loop ticks). The
  // catalog short-circuits if the same id has already reset
  // its budget this frame — without this, every ShowCommand
  // sharing the source would reset the counters → each layer
  // would get a fresh sub-tile budget → 4× more sub-tile clips
  // per frame than intended → GPU buffer creation burst →
  // Chrome STATUS_BREAKPOINT at over-zoom.
  guard.source.resetCompileBudget(vtr.currentFrameId)
  vtr._drawStats.resetRenderedDraws()
  // _missedTiles is FRAME-scoped, not render-scoped — beginFrame()
  // resets it to 0. Multiple render() calls within one frame
  // (one per ShowCommand for sliced sources like PMTiles 4-layer)
  // ACCUMULATE into the same counter so map.ts's
  // hasPendingSourceWork sees the true frame total. Resetting
  // here would have clobbered earlier layers' miss counts and
  // falsely signaled "no work pending" when only the last
  // layer happened to converge first.
  vtr.ensureUniformRing()
  return { sliceLayer, layerCache }
}
