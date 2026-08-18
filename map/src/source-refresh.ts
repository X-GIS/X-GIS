// ═══ Source refresh — the declarative `refresh:` polling timer (#1304) ═══
//
// A `.xgis` source may declare `refresh: <seconds>` — periodic re-fetch/re-load for
// a live source (the NOAA CO-OPS motivating case: observations updating every few
// minutes). This owns just the polling loop: a self-re-arming timer per source,
// restart-safe via a generation guard so a tick that outlives a restart cannot
// re-arm on top of the new loop. Mirrors `CoverageRefreshScheduler`
// (coverage-refresh.ts, #1158) minus the ETag/Last-Modified validator + epoch
// machinery that scheduler needs for conditional HEAD-probe revalidation — a
// declared source refresh always re-loads (there is no conditional-GET primitive
// for a plain GeoJSON URL or a custom `SourceLoader`), so this file is the timer
// alone. `source-manager.ts` owns what a tick actually DOES (re-fetch + swap via
// the existing `setSourceData` re-seed path).

import { xlog } from '@xgis/shared'

export class SourceRefreshScheduler {
  private readonly timers = new Map<string, { timer: ReturnType<typeof setTimeout>; gen: number }>()
  private generation = 0

  /** Poll `tick` every `intervalMs`, re-arming only after each tick settles so a
   *  tick slower than the interval cannot stack up. Restarts cleanly if already
   *  running for this source. `intervalMs` is clamped to ≥ 1000 — a sub-second
   *  poll of a remote source is never the right answer. A failed tick does NOT
   *  stop the loop (a poll of a live network is allowed to blip); `tick` itself
   *  is responsible for surfacing the failure (source-manager fires the typed
   *  `'source'` error event) — this is only a last-resort net so a tick that
   *  throws unexpectedly can't silently kill the loop. */
  start(sourceId: string, intervalMs: number, tick: () => Promise<void>): void {
    this.stop(sourceId)
    const delay = Math.max(1000, Math.floor(intervalMs))
    const gen = ++this.generation
    const run = async (): Promise<void> => {
      try {
        await tick()
      } catch (err) {
        xlog.error('[X-GIS] source refresh tick threw', err)
      }
      // Re-arm only if THIS loop still owns the source — a stop() during the
      // tick drops the entry, and a restart replaces `gen`, so neither can be
      // re-armed over (mirrors CoverageRefreshScheduler.start).
      if (this.timers.get(sourceId)?.gen === gen)
        this.timers.set(sourceId, { timer: setTimeout(() => void run(), delay), gen })
    }
    this.timers.set(sourceId, { timer: setTimeout(() => void run(), delay), gen })
  }

  stop(sourceId: string): void {
    const entry = this.timers.get(sourceId)
    if (entry !== undefined) {
      clearTimeout(entry.timer)
      this.timers.delete(sourceId)
    }
  }

  stopAll(): void {
    for (const entry of this.timers.values()) clearTimeout(entry.timer)
    this.timers.clear()
  }

  isRunning(sourceId: string): boolean {
    return this.timers.has(sourceId)
  }
}
