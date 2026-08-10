// ═══ Map teardown helpers — the stop-block, the read cancellation, the source release ═══
//
// ─── The coverage stop-block: ONE teardown spine for two paths (#1569) ───
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

/** Owns the map-scoped `AbortController` every coverage HTTP read carries (#1570).
 *
 *  The coverage chain had no `AbortSignal` anywhere — `stopAll()` cleared setTimeouts
 *  and nothing cancelled the reads those timers had already started — and a
 *  signal-less `fetch` is uncancellable BY SPEC. So an in-flight cell read (10-250 MB,
 *  capped at 256 MB) streamed to completion, was fully buffered and parsed, and only
 *  then discarded at a landing guard, on a map the host had already destroyed,
 *  competing for bandwidth with the replacement scene's own fetches.
 *
 *  `cancelAll` REPLACES the controller rather than only aborting it, so a scene swap
 *  cancels the outgoing scene's reads and the incoming one is not born pre-aborted. */
export class CoverageReadCancellation {
  private controller = new AbortController()

  get signal(): AbortSignal {
    return this.controller.signal
  }

  cancelAll(): void {
    this.controller.abort()
    this.controller = new AbortController()
  }
}

// ── Per-source GPU release ─────────────────────────────────────────────────
//
// The one piece of `_releaseGpuResources` that needs nothing from the map but the
// registry itself, so it lives here rather than in map.ts (at its LOC ceiling).

/** The shape a `vtSources` entry must have to be torn down. Structural, so the map's
 *  real entry type satisfies it without this module importing anything. */
export interface ReleasableSourceEntry {
  readonly renderer: { destroy(): void }
  readonly source: { destroy(): void }
}

/** Destroy the GPU renderer + tile catalog of every `vtSources` entry belonging to
 *  `sourceId`, INCLUDING its filtered variants (keyed `id__N`), and drop them from the
 *  registry. Reached by both `destroy()` and `_teardownForReinit()`. */
export function teardownSources(
  vtSources: Map<string, ReleasableSourceEntry>,
  sourceId: string,
): void {
  for (const [key, entry] of vtSources) {
    if (key === sourceId || key.startsWith(`${sourceId}__`)) {
      entry.renderer.destroy()
      entry.source.destroy()
      vtSources.delete(key)
    }
  }
}

// ═══ The in-flight GPU boot nobody has claimed yet (#1577) ═══
//
// `_runProgram` kicks off `bootGpuContext` and awaits it ~300 lines later, and that
// window is linear — no try/catch/finally. A resolved `GPUContext` is reachable ONLY
// through that promise, so anything that throws in between (a semantically invalid style:
// an import that fails to resolve, one of `lower()`'s six user-reachable throws, an emit
// failure) exited without awaiting it, while `requestDevice` resolved 100-500 ms later
// into a promise nobody held. `ctx` was never set and `_ctxOwned` was false, so the next
// run's teardown gate skipped it and `destroy()` freed only the published ctx — one live
// GPUDevice leaked per failed run, unreclaimable by any lifecycle path. WebGPU devices
// are reclaimed only by an explicit `destroy()`.
//
// The invariant is the authors' own, stated twice in map.ts: D2/A1 moved lex/parse above
// the kickoff so "a parse throw must never orphan a freshly-minted device", and the G1
// stale-exit awaits and destroys for the same reason. The throw route between them was
// the one exit with no equivalent.

/** The pending-boot promise's settled shape: a context, the boot's own error, or nothing. */
export type PendingGpuBoot = Promise<unknown> | null

/** Destroy a boot that resolved but was never adopted.
 *
 *  `liveCtx` is compared BY IDENTITY, so the successful path — where the very same
 *  context became the map's — is never destroyed out from under a running map. A
 *  rejection was already value-wrapped by the kickoff's `.catch`, so awaiting here cannot
 *  throw and this is safe to call from an error path. */
export async function disposeOrphanedBoot(
  pending: PendingGpuBoot,
  liveCtx: unknown,
): Promise<void> {
  if (!pending) return
  const settled = await pending
  if (!settled || settled instanceof Error || settled === liveCtx) return
  ;(settled as { rhi?: { destroy(): void } }).rhi?.destroy()
}

/** Promote `baseUrl` to an absolute URL. `new URL(path, base)` requires an absolute
 *  `base` — a bare path like '/data/' throws `TypeError: Invalid base URL`. Accepts '',
 *  '/data/', a relative URL, or a fully-qualified one. */
export function absoluteBaseUrl(baseUrl: string): string {
  if (typeof window === 'undefined') return baseUrl // SSR / tests
  if (!baseUrl) return window.location.href
  try {
    return new URL(baseUrl, window.location.href).href
  } catch {
    return window.location.href
  }
}
