import type { VectorTileRenderer, RenderFrameState } from '../vector-tile-renderer'
import type { RenderArgs } from '../vector-tile-renderer-types'
import { uploadBudgetFor } from '../vector-tile-renderer-helpers'

/** #2508 phase 5 — request what the classification found missing, BEFORE
 *  anything draws: on-demand tiles compile synchronously and land in the GPU
 *  cache within the same frame. Also drops the uploads the selection no
 *  longer needs and installs the camera-distance upload priority. Consumes
 *  only. */
export function requestAndPrefetch(
  vtr: VectorTileRenderer,
  args: RenderArgs,
  ctx: RenderFrameState,
): void {
  // Request missing tiles BEFORE drawing — on-demand tiles compile synchronously
  // and become available in gpuCache within the same frame.
  //
  // Parent prefetch delegates the walk to `firstIndexedAncestor` so
  // the logic is CPU-testable and unified across call sites. The old
  // inline loop capped at 2 levels, which silently dropped every
  // descendant whose real parent lived more than 2 levels up — at
  // z=20 over a maxLevel=5 source, that meant the z=5 parent was
  // never prefetched, VTR drew nothing, and FLICKER fired sustainedly.
  //
  // Set-based dedup: hundreds of z=20 tiles share a single z=5
  // ancestor, so we request it once per frame.
  // parentKeysSet declared above (hoisted for over-zoom fast path).
  // Skip the prefetch loop entirely when EVERY tile was handled by
  // the over-zoom fast path — fast path already populated
  // parentKeysSet for any parents needing fetch, and the per-tile
  // hasEntry/sliceCached calls in this loop would all be redundant
  // (all currentZ keys are out-of-archive, all parents already
  // checked above). Same idea as the primary-renderTileKeys skip
  // below.
  // Anticipatory parent prefetch for IN-ARCHIVE tiles only. The
  // toLoad branch from the legacy prefetch loop is gone: per-tile
  // case 6 already pushes `key`/`closestExisting` into toLoad with
  // the same `hasEntryInIndex` guard, so a second push here was
  // pure duplication (the catalog dedupes against `loadingTiles`
  // but the JS overhead of re-iterating + re-checking still cost
  // ~0.5 ms / render at z=21.6 over Seoul). For over-zoom tiles
  // the fast path already enqueued the maxLevel parent into
  // parentKeysSet, so we skip them entirely — only in-archive
  // tiles whose own ancestor needs prefetching reach the body.
  if (ctx.anyInArchive) {
    for (let i = 0; i < ctx.neededKeys.length; i++) {
      if (ctx.parentAtMaxLevel[i] >= 0) continue
      const pk = ctx.archiveAncestor[i]
      // Keep already-loading ancestors in parentKeysSet so they
      // stay in `activeKeys` for cancelStale's protection check.
      // Excluding them here meant a parent in flight got dropped
      // from the next frame's active set → cancelStale aborted
      // it → cold-start at high zoom (z=14) never resolved
      // (regression repro: _pmtiles-zoom14-blank.spec.ts). The
      // catalog's requestTiles dedupes loadingTiles internally,
      // so re-adding here costs only a Set membership check.
      if (pk >= 0 && !ctx.sliceCached(pk)) {
        ctx.parentKeysSet.add(pk)
      }
    }
  }
  // Load parents first, then current zoom tiles
  const parentKeys = [...ctx.parentKeysSet]

  // Cancel in-flight fetches the camera has moved past. Active set =
  // anything we still need this frame: current visible (neededKeys)
  // + their parent fallbacks (parentKeys) + the parents that fast
  // path & in-archive walk pushed into fallbackKeys. Without this,
  // every frame leaves a trail of zombie fetches behind — the
  // user pans / zooms past a tile while its bytes are still on the
  // wire, and by the time the bytes arrive the catalog has moved
  // on, but bandwidth + worker capacity already paid for the
  // round-trip. cancelStale clips that trail by aborting the
  // network transfers and dropping decode-queued bytes for keys
  // the catalog no longer wants. Backends without cancellation
  // (XGVT-binary, GeoJSON-runtime) are no-ops.
  {
    const activeKeys = vtr._scratchActiveKeys
    activeKeys.clear()
    for (const k of ctx.neededKeys) activeKeys.add(k)
    for (const k of parentKeys) activeKeys.add(k)
    for (const k of ctx.fallbackKeys) activeKeys.add(k)
    // Rule 1 (replace refinement): classifyFallback's pending branch
    // routes the request to the SHALLOWEST uncached ancestor, which
    // can sit between the pinned skeleton (z=0..2/3) and the visible
    // zoom (e.g. z=5 when skeleton ends at z=2). Without unioning
    // toLoad, the next frame's cancelStale sees those mid-chain
    // ancestors as "stale" (not in needed/parent/fallback/skeleton/
    // prefetch sets) and aborts the in-flight fetch — top-down
    // loading then never converges, the request loops forever
    // between fire and abort.
    for (const k of ctx.toLoad) activeKeys.add(k)
    if (ctx.source.cancelStale) ctx.source.cancelStale(activeKeys)
    // Same active-set for the renderer-side upload queue. Without
    // this, the queue accumulates hundreds of stale `uploadTile`
    // jobs across fast zoom+pan and per-frame maxJobs (4-8) can't
    // drain fast enough — new visible tiles never reach the GPU and
    // parent-fallback fills persist. See cancelStaleUploads doc.
    vtr.cancelStaleUploads(activeKeys)
  }

  // Update the fetch-queue priority comparator with the current
  // camera centre BEFORE issuing requestTiles. The PriorityQueue
  // re-sorts on every dispatch using whatever comparator is set, so
  // the first job picked from the queue right after this is the
  // closest tile to the camera. World-copy offsets aren't carried in
  // the tile-key (only z/x/y), so a tile's distance is computed
  // against the central-world-copy mercator centre — adequate for
  // priority ordering since all visible copies of the same tile
  // sort together. Backends without a queue (XGVT-binary, GeoJSON)
  // ignore this hook.
  // Update fetch + upload priority comparators with the current
  // camera centre. Wired through stable instance closures
  // (`_distSqStable`) — re-allocating a fresh closure + Map per
  // render() call (called ~80 times per frame on 80-layer styles)
  // dominated the JS-thread slice before this hoist. The memo on
  // `_distMemo` actually shares the lookup across every render() in
  // the frame now, instead of starting empty each time.
  if (vtr._distMemoCamX !== args.camera.centerX || vtr._distMemoCamY !== args.camera.centerY) {
    vtr._distMemoCamX = args.camera.centerX
    vtr._distMemoCamY = args.camera.centerY
    // Camera moved → previously-sorted items now compare against
    // different distances. Force the next upload-queue sort to
    // re-execute (the per-frame idempotency skip would otherwise
    // keep the stale ordering when the queue's items haven't
    // changed since last frame).
    vtr._uploads.markQueueDirty()
    vtr._distMemo.clear()
  }
  if (!vtr._priorityInstalled) {
    // Install the shared distance comparator on BOTH the fetch queue
    // (source) and the renderer-side upload queue (coordinator). Once —
    // both keep their identity for the renderer's lifetime.
    ctx.source.setFetchPriority(vtr._distSqStable)
    vtr._uploads.installPriority(vtr._distSqStable)
    vtr._priorityInstalled = true
  }
  // #1155 F3 — pass the burst flag so the concurrent-upload cap rises to 8/4
  // during cold start (signature-compatible; false in steady state).
  vtr._uploads.setMaxJobs(
    uploadBudgetFor(args.canvasWidth, args.canvasHeight, args.dpr, vtr._coldStartBurst),
  )

  // Visible-tile fetches: ALWAYS issued, like parentKeys. The
  // earlier `cameraIdle` gate here was a heat mitigation that
  // turned out to be too aggressive — at flat pitch on a settled
  // camera, the gate was leaving 11 of 12 visible z=currentZ
  // tiles uncached, so the canvas filled but with a parent-walk
  // (z=currentZ-1) fallback stripe (regression repro:
  // _mobile-detail-uniformity.spec.ts).
  //
  // The cancelStale mechanism above already abort-frees in-flight
  // fetches whose keys leave the active set during a gesture, so
  // the per-frame fetch traffic is self-trimmed without an extra
  // gate. Heat protection now relies entirely on the concurrency
  // caps (MAX_INFLIGHT, MAX_CONCURRENT_LOADS) + the prefetch /
  // step-prefetch idle gates, not on suppressing visible-fetch
  // start.
  if (parentKeys.length > 0) ctx.source.requestTiles(parentKeys)
  if (ctx.toLoad.length > 0) ctx.source.requestTiles(ctx.toLoad)

  // After on-demand compile, newly available tiles may need upload
  for (const key of ctx.toLoad) {
    if (!ctx.layerCache.has(key) && ctx.source!.hasTileData(key, ctx.sliceLayer)) {
      vtr.uploadTile(key, ctx.source!.getTileData(key, ctx.sliceLayer)!, ctx.sliceLayer)
    }
  }

  // NOW draw (tiles are guaranteed in gpuCache if they compiled synchronously)
}
