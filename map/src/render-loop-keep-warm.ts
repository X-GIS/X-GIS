// ═══ End-of-frame keep-warm gate ═══
//
// Tile/texture work still outstanding keeps the loop warm so the scene converges. Pure
// and extracted (#1575) because this predicate is the difference between a map that
// converges and one that fossilises half-loaded, and it was previously reachable only
// through a full GPU frame — the exact shape CLAUDE.md's own lessons ledger records as
// having been paid for once already.

/** The subset of a tile renderer this gate reads. The ledger is reached directly rather
 *  than through a per-renderer forwarder, so the raster and DEM arms cannot drift into
 *  answering this question differently — which is how that pair has failed before. */
export interface KeepWarmTiles {
  hasPendingLoads(): boolean
  readonly failedTiles: { hasPendingRetries(): boolean }
}

export interface KeepWarmInputs {
  /** Unresolved VT placeholders counted this frame. */
  totalMissed: number
  raster: KeepWarmTiles
  hillshade: KeepWarmTiles
  /** The VT sources' renderers — scanned only when nothing above already fired.
   *
   *  `_selection._czPendingAdvance` is reached DIRECTLY rather than through a
   *  per-renderer forwarder, the same call the raster/DEM `failedTiles` ledger above
   *  makes and for the same reason: the transition state has exactly one owner
   *  (`TileSelectionCache`), and a forwarder is a second place that could answer this
   *  question differently. It is also the only shape available — both owning files sit
   *  on shrink-only LOC ceilings (`loc-ceiling-ratchet.test.ts`), so the accessor this
   *  would otherwise be cannot be added to either without an unrelated extraction. The
   *  coupling is typechecked here, so a rename on either side breaks the build. */
  vtRenderers: Iterable<{
    renderer: { hasPendingUploads(): boolean; _selection: { _czPendingAdvance: unknown } }
  }>
}

/** Must the loop render again? Six signals:
 *
 *   - VT tiles with unresolved placeholders (`missedTiles > 0`) — including a VT tile
 *     inside its source's fetch backoff, which is BOUNDED exactly as the raster ledger
 *     below is: `tile-decision.ts` marks a `pending` decision `terminal` past
 *     `KEEP_WARM_MAX_FAILURES` consecutive failures and the renderer stops counting it,
 *     so a permanently-unfetchable tile lets the loop idle while a transient one stays
 *     warm long enough for the source's retry to run (#1596)
 *   - raster tiles mid-fetch
 *   - hillshade DEM tiles mid-fetch — a hillshade-only scene has no other signal, and
 *     without it the loop idles before the DEM arrives and the arrival never repaints:
 *     permanent black relief until an interaction
 *   - raster/DEM tiles waiting out a RETRY backoff (#1575). Nothing else can see one:
 *     `hasPendingLoads` is 0 the moment the failed load settles, and `totalMissed` counts
 *     VT sources only. So on a static camera the loop stopped, and the retry — which is
 *     re-attempted only from inside `render()` — never ran. It terminates: a tile gets
 *     `MAX_TILE_ATTEMPTS` over ~10.5 s and is then abandoned.
 *   - VT tiles queued behind the per-frame upload budget (scanned last: it is the only
 *     signal that costs a loop over the sources)
 *   - a VT LOD transition still in flight (#1997). The readiness gate advances the tile
 *     LOD one step per RENDERED frame, so a camera that jumps two levels — a `#z/lat/lon`
 *     hash, `jumpTo`, a bounds fit — leaves the selection behind the camera for two more
 *     frames. An unconverged selection can be legitimately EMPTY (a z=0 root tile is not
 *     inside a zoom-2 sphere frustum), and an empty selection requests nothing, misses
 *     nothing and uploads nothing: every signal above reads quiet in the exact frame the
 *     ramp still owes work. The loop then idles mid-ramp and CANNOT restart, because the
 *     LOD only advances inside a rendered frame — the 5 s readiness timeout included. It
 *     terminates for the same reason the others do: the gate either reaches its target or
 *     times out, and both paths clear the flag. Measured on the globe demo: the loop
 *     stopped with cz=0 against camera zoom 2 and stayed there with zero tiles
 *     indefinitely; one `invalidate()` finished the ramp in two frames (cz 0→1→2,
 *     tiles 0→4→8). */
export function keepLoopWarm(input: KeepWarmInputs): boolean {
  if (
    input.totalMissed > 0 ||
    input.raster.hasPendingLoads() ||
    input.hillshade.hasPendingLoads() ||
    input.raster.failedTiles.hasPendingRetries() ||
    input.hillshade.failedTiles.hasPendingRetries()
  ) {
    return true
  }
  for (const { renderer } of input.vtRenderers) {
    if (renderer.hasPendingUploads() || renderer._selection._czPendingAdvance !== null) return true
  }
  return false
}
