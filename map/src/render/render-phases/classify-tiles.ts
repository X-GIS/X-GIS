import type { VectorTileRenderer, GuardedFrame } from '../vector-tile-renderer'
import type { LayerSlot, TileSelection, TileClassification } from '../vector-tile-renderer-types'
import { markEnd as perfMarkEnd, markStart as perfMarkStart } from '../../__profile__/perf-marks'
import { classifyTile } from '../../tile-decision'
import type { TileDecision } from '../../tile-decision'
import { xlog } from '@xgis/shared'

/** #2508 phase 4 — classify every visible tile into exactly one decision
 *  (direct, parent fallback, over-zoom parent, dropped, pending …), collecting
 *  the fallback pushes, the keys to request and the per-decision counts the
 *  inspector reads. The production invariant (`__XGIS_INVARIANTS`) runs here. */
export function classifyTiles(
  vtr: VectorTileRenderer,
  guard: GuardedFrame,
  slot: LayerSlot,
  sel: TileSelection,
): TileClassification {
  // neededKeys + worldOffDeg + parentAtMaxLevel + archiveAncestor
  // already computed (and cached frame-wide) above. Per-tile loop
  // and prefetch loop both read those arrays directly — no need
  // for a per-render `closestExistingByI` mirror, since the
  // sliceLayer-independent ancestor result is identical across
  // every same-frame ShowCommand render.
  const fallbackKeys: number[] = []
  const fallbackOffsets: number[] = []
  /** Parallel to `fallbackKeys`: the visible-tile key each fallback
   *  push is FILLING FOR. When a parent z=11 ancestor renders as
   *  fallback for a missing visible z=15 child, the per-tile clip
   *  mask uniform must clip the parent's geometry to the visible
   *  z=15 child's mercator bounds — otherwise the parent's data
   *  spills over neighboring children (some primary-loaded with
   *  their OWN buildings, causing cross-z depth fights). */
  const fallbackVisibleKeys: number[] = []
  const toLoad: number[] = []
  // Memoize sliceCached lookups across the per-tile + prefetch loops
  // within this render. Adjacent visible tiles share ancestors so
  // without memo the same parent key gets queried per layer slot.
  // hasEntryInIndex is no longer memoized at render scope — the
  // frame cache populate runs the only memoized walk now (see
  // archiveAncestor[] above), and the few remaining direct
  // hasEntryInIndex calls in the per-tile loop hit case-6 paths
  // that fire at most once per tile per render.
  const sliceCachedMemo = vtr._scratchSliceCachedMemo
  sliceCachedMemo.clear()
  const sliceCached = (k: number): boolean => {
    let v = sliceCachedMemo.get(k)
    if (v === undefined) {
      v = slot.layerCache.has(k) || guard.source!.hasTileData(k, slot.sliceLayer)
      sliceCachedMemo.set(k, v)
    }
    return v
  }

  // parentKeysSet is the prefetch queue. Hoisted ahead of the
  // main per-tile loop so the over-zoom fast path can populate it
  // for parents that need fetching, instead of duplicating the
  // queue logic.
  const parentKeysSet = vtr._scratchParentKeysSet
  parentKeysSet.clear()
  // Tracks whether ANY visible tile went through the in-archive
  // (normal) path. When false, the prefetch loop + primary
  // renderTileKeys are pure no-ops (every neededKey is over-zoom
  // so gpuCache.get returns null for all of them) and we can
  // skip them entirely.
  let anyInArchive = false

  // Per-tile decision tracker. Each visible tile resolves to one of:
  //   'primary'         — layerCache hit, will draw
  //   'parent-fallback' — cached ancestor pushed to fallbackKeys
  //   'child-fallback'  — cached child (deck.gl best-available) pushed
  //   'overzoom-parent' — over-zoom fast path pushed parent at maxLevel
  //   'queued-no-fb'    — uploadTile queued, NO fallback (= BUG)
  //   'drop-empty-slice'— sliced source layer has no features here
  //   'drop-no-archive' — tile not in archive index, no ancestor either
  //   'pending'         — fetch issued, no fallback found (cold area)
  //
  // Always populated (lightweight: array of constant-string refs).
  // The invariant-throw at end of loop is gated on
  // `globalThis.__XGIS_INVARIANTS`; the per-decision count summary
  // (exposed via `getLastDecisionCounts()`) is always available.
  // Scratch reuse + length reset; prior values are overwritten inside
  // the loop below (decision always assigned per tile).
  const _tileDecisions = vtr._scratchTileDecisions
  _tileDecisions.length = sel.tiles.length
  const _inv = (globalThis as { __XGIS_INVARIANTS?: boolean }).__XGIS_INVARIANTS

  // Per-frame slice memo: 81 shows in bright resolve to ~13 distinct
  // slices, so without this we run classifyTile 81× per visible tile
  // even though the inputs only vary by sliceLayer. See field decl.
  let sliceMemo = vtr._frameClassifyMemo.get(slot.sliceLayer)
  if (!sliceMemo) {
    sliceMemo = new Map()
    vtr._frameClassifyMemo.set(slot.sliceLayer, sliceMemo)
  }

  for (let i = 0; i < sel.tiles.length; i++) {
    const key = sel.neededKeys[i]

    // ── OVER-ZOOM FAST PATH ──
    // For tiles past archive maxLevel, every layer renders the
    // parent at maxLevel as camera-magnified fallback (no sub-tile
    // gen — Mapbox-style). Skip the entire per-tile body: no
    // gpuCache.has chain, no hasTileData chain, no parent-walk
    // (we know the destination is exactly maxLevel ancestor), no
    // compileTileOnDemand call. Just walk up by tileKeyParent and
    // push the fallback. Profiled: dropped per-tile loop time on
    // pmtiles_layered z=22 from 6.4 ms → ~1 ms per render.
    // Per-tile resolution via the pure `classifyTile` classifier
    // (engine/tile-decision.ts). The classifier returns ONE explicit
    // TileDecision; the side-effect application below pushes fallbackKeys,
    // requests uploads, and bumps counters per the decision kind.
    let decision: TileDecision | undefined = sliceMemo.get(key)
    if (!decision) {
      decision = classifyTile({
        visible: sel.tiles[i],
        visibleKey: key,
        maxLevel: sel.maxLevel,
        parentAtMaxLevel: sel.parentAtMaxLevel[i],
        archiveAncestor: sel.archiveAncestor[i],
        layerCache: slot.layerCache,
        hasSliceInCatalog: sliceCached,
        // Non-empty predicate: single-layer GeoJSON stores an empty
        // placeholder (zero geometry) under the default '' slice for
        // tiles with no features; hasTileData reports it as cached.
        // Report it as NOT-cached here so the empty default slice
        // classifies as drop-empty instead of queued-with-fallback.
        hasNonEmptySliceInCatalog: (k) => {
          if (slot.layerCache.has(k)) return true
          const d = guard.source!.getTileData(k, slot.sliceLayer)
          return (
            !!d &&
            (d.vertices.length > 0 ||
              d.lineVertices.length > 0 ||
              (d.pointVertices?.length ?? 0) > 0 ||
              !!d.fullCover)
          )
        },
        hasAnySliceInCatalog: (k) => guard.source!.hasTileData(k),
        hasEntryInIndex: (k) => guard.source!.hasEntryInIndex(k),
        // Consecutive fetch failures on record for the key — a `pending`
        // decision goes `terminal` past KEEP_WARM_MAX_FAILURES, which is
        // what lets the consumer below stop counting it as a missed tile.
        failureCount: (k) => guard.source!.getTileFailureCount(k),
        sliceLayer: slot.sliceLayer,
        // Coherence: any peer slice for this tile still queued blocks
        // primary in this layer too, so all consumers transition
        // together. See UploadCoordinator.isHeld (cap-deferred held set).
        hasOtherSliceHeld: vtr._uploads.isHeld(key),
      })
      sliceMemo.set(key, decision)
    }
    _tileDecisions[i] =
      decision.kind === 'queued-with-fallback' ? decision.fallback.kind : decision.kind

    if (decision.kind === 'overzoom-parent') {
      fallbackKeys.push(decision.parentKey)
      fallbackOffsets.push(sel.worldOffDeg[i])
      fallbackVisibleKeys.push(key)
      if (decision.parentNeedsFetch) {
        parentKeysSet.add(decision.parentKey)
      } else if (decision.parentNeedsUpload) {
        const data = guard.source.getTileData(decision.parentKey, slot.sliceLayer)
        perfMarkStart('vtr.upload')
        if (data) vtr.doUploadTile(decision.parentKey, data, slot.sliceLayer)
        perfMarkEnd('vtr.upload')
      }
      continue
    }

    anyInArchive = true
    if (decision.kind === 'primary') continue
    if (decision.kind === 'drop-empty-slice') continue
    if (decision.kind === 'drop-no-archive') {
      const t = sel.tiles[i]
      const wKey = `no-ancestor:${t.z}/${t.x}/${t.y}`
      if (sel.maxLevel > 0 && !vtr._drawStats.hasWarned(wKey)) {
        vtr._drawStats.markWarned(wKey)
        xlog.warn(
          `[VTR tile-drop] no ancestor found for ${t.z}/${t.x}/${t.y} — dropping from render (maxLevel=${sel.maxLevel}).`,
        )
      }
      continue
    }

    // queued-with-fallback wraps an inner fallback decision. The
    // outer kind triggers a uploadTile (queued behind the per-
    // frame budget); the inner is the visual fill until the
    // upload lands. Unwrap and process the inner uniformly.
    let inner: TileDecision = decision
    if (decision.kind === 'queued-with-fallback') {
      vtr.uploadTile(key, guard.source.getTileData(key, slot.sliceLayer)!, slot.sliceLayer)
      inner = decision.fallback
    }

    if (inner.kind === 'parent-fallback') {
      if (inner.parentNeedsUpload) {
        // Ancestor upload BYPASSES the per-frame budget. Fallback
        // parents are the visual safety net for every visible
        // tile currently uncached on GPU. Without the immediate
        // upload, renderTileKeys finds no gpuCache entry and the
        // tile draws as a black hole. (See _high-pitch-flicker
        // regression case.)
        perfMarkStart('vtr.upload')
        vtr.doUploadTile(
          inner.parentKey,
          guard.source.getTileData(inner.parentKey, slot.sliceLayer)!,
          slot.sliceLayer,
        )
        perfMarkEnd('vtr.upload')
      }
      fallbackKeys.push(inner.parentKey)
      fallbackOffsets.push(sel.worldOffDeg[i])
      fallbackVisibleKeys.push(key)
      // Advance the fetch frontier — without this push the parent
      // fallback covers the area visually forever but the proper-z
      // tile is never fetched, so the rendering stalls one z
      // coarser than the source supports. catalog.requestTiles
      // dedupes against `loadingTiles` so repeat pushes per frame
      // collapse to one in-flight fetch.
      if (inner.wantsRequestKey !== null) toLoad.push(inner.wantsRequestKey)
    } else if (inner.kind === 'child-fallback') {
      for (const ck of inner.childrenNeedingUpload) {
        const childData = guard.source.getTileData(ck, slot.sliceLayer)
        perfMarkStart('vtr.upload')
        if (childData) vtr.doUploadTile(ck, childData, slot.sliceLayer)
        perfMarkEnd('vtr.upload')
      }
      for (const ck of inner.childKeys) {
        fallbackKeys.push(ck)
        fallbackOffsets.push(sel.worldOffDeg[i])
        fallbackVisibleKeys.push(key)
      }
      // Fetch-frontier push, mirror of the parent-fallback arm above
      // (#2013): covered is not loaded — without this the stretched
      // descendants satisfy every frame and the visible z is never
      // requested. requestTiles dedupes against loadingTiles.
      if (inner.wantsRequestKey !== null) toLoad.push(inner.wantsRequestKey)
    } else if (inner.kind === 'pending') {
      if (inner.requestKey !== null) toLoad.push(inner.requestKey)
      // #1596 — a terminal key has failed KEEP_WARM_MAX_FAILURES times in
      // a row. It is still pushed to toLoad above (the source owns retry
      // timing), but it stops counting as a missed tile so the render loop
      // can finally idle instead of hot-looping on totalMissed>0 forever.
      // A key still INSIDE that budget deliberately keeps counting: this
      // counter is the only VT keep-warm signal, and the retry runs only
      // from a rendered frame, so suppressing it during the backoff would
      // strand a transient failure until the next user interaction.
      if (!inner.terminal) vtr._drawStats.recordMissedTile()
    }
  }

  // ── Production invariant — visibility/fallback consistency check ──
  // Fires if any visible tile reached the end of the per-tile loop
  // with `queued-no-fb` (the white-flash bug class) or with no decision
  // at all (un-tracked code path). Pending +
  // intentional drops are allowed; primary / fallback resolutions
  // are allowed. The bug pattern is: catalog has data, primary
  // can't draw (queued upload), AND no per-tile fallback was
  // pushed. Unlike the global fallbackKeys check, this is per-tile
  // so a fallback pushed by a NEIGHBOURING tile (sharing the same
  // ancestor) does NOT mask the bug here.
  if (_inv) {
    for (let i = 0; i < sel.tiles.length; i++) {
      const d = _tileDecisions[i]
      if (d === 'queued-no-fb' || d === undefined) {
        const t = sel.tiles[i]
        throw new Error(
          `[XGIS INVARIANT] tile ${t.z}/${t.x}/${t.y} layer="${slot.sliceLayer}" ` +
            `decision=${d ?? 'untracked'}. The per-tile loop resolved this tile ` +
            `without a primary draw or a per-tile fallback push. This is the bug ` +
            `class fixed by commit 49d4801 (uploadTile queue + continue skipping ` +
            `the parent-walk fallback).`,
        )
      }
    }
  }

  // Always-on per-decision summary for inspector / console diagnosis.
  // Reset to start fresh each render() call so consumers see THIS
  // layer's distribution. Tilly with `getLastDecisionCounts()`.
  vtr._drawStats.clearDecisionCounts()
  for (let i = 0; i < sel.tiles.length; i++) {
    const d = _tileDecisions[i] ?? 'untracked'
    vtr._drawStats.incDecisionCount(d)
  }
  return {
    anyInArchive,
    sliceCached,
    parentKeysSet,
    fallbackKeys,
    toLoad,
    _inv,
    fallbackOffsets,
    fallbackVisibleKeys,
  }
}
