// ═══ The coverage stop-block — ONE teardown spine for two paths (#1569) ═══
//
// `map.destroy()` and `map._teardownForReinit()` had drifted. `destroy()` is
// thorough — #1359 verified it healthy for rAF, timers, pointer / keyboard /
// media-query / visibility listeners, the four `__xgis*` window globals and the RHI
// device — while `_teardownForReinit` is a shorter, older path that was never
// brought level with it. Every member below was in one and not the other, and each
// gap was independently reachable:
//
//   * The refresh scheduler lives on a MAP field, not on the torn-down ctx, so
//     `_releaseGpuResources` never touched it. A host-started `autoRefreshCoverage`
//     loop therefore kept polling the OLD scene's URL forever across a scene swap,
//     and on a validator roll armed the old region's handle into the NEW scene's
//     renderer: ghost coverage drawn in a scene that never declared it. `run()`
//     documents re-running a live map as a legitimate swap, so this is an ordinary
//     path, not an edge case.
//   * The coverage move-end listener kept resolving catalogues for a gone scene.
//   * `_coverageFieldShow` — the single authority `setCoverageFrame` gates on — was
//     cleared solely by `rebuildLayers`, a live-scene path neither teardown reaches.
//   * `rawDatasets` survived the swap, so the "not a declared coverage source" throw
//     that would have killed a ghost refresh tick never fired: the loop stayed
//     healthy forever instead of dying on its own error.
//
// `rawDatasets` is cleared wholesale on BOTH paths. A re-run writes only the
// INCOMING program's `load.name` keys, so anything scene B does not redeclare was
// otherwise kept for the map's remaining life — unbounded across swaps with distinct
// names, and date-keyed cells are exactly that — while `getCoverage(name)` went on
// answering with the previous scene's handle. Note the intent asymmetry this
// resolves: keeping state across a swap IS documented for the graphics registry
// (`_releaseGpuResources`); `rawDatasets`' own comment says the opposite.
//
// Taking the pieces as a record rather than the map itself keeps this module free of
// XGISMap (map.ts is at its LOC ceiling and this file is where the reasoning lives).

/** The map-owned pieces the stop-block touches. Structural, so `XGISMap` satisfies
 *  it by passing its own fields — no import of the map type. */
export interface CoverageTeardownTargets {
  /** Forecast-time playback timer (#1272 E-③). */
  readonly time: { pause(): void }
  /** Every coverage auto-refresh poll loop (#1158). */
  readonly refresh: { stopAll(): void }
  /** Per-source STAC catalogue residency state (#1453). */
  readonly catalogues: { clear(): void }
  /** Retained CPU payloads — decoded grids, host pushes, tiling markers. */
  readonly rawDatasets: { clear(): void }
  /** Remove the coverage catalogue's `moveend` listener, if installed. */
  readonly detachMoveEnd: () => void
  /** Drop the armed-field authority `setCoverageFrame` gates on. */
  readonly clearFieldShow: () => void
}

/** Stop every piece of coverage machinery a map started, and drop the CPU payloads
 *  it holds. Idempotent — every member is itself a no-op when already clear. */
export function stopCoverageMachinery(t: CoverageTeardownTargets): void {
  t.time.pause()
  t.refresh.stopAll()
  t.detachMoveEnd()
  t.catalogues.clear()
  t.clearFieldShow()
  t.rawDatasets.clear()
}
