// ═══ Forecast-time addressing for S-111 / S-104 coverages (#1272 E-③) ═══
//
// An S-100 forecast cell stores numGRP hourly groups (Group_001…Group_NNN, each a full grid
// at its own valid time). `Map.setCoverageTime` swaps the DISPLAYED group; this pure helper
// resolves the caller's request — a 0-based hour INDEX or an ISO valid-TIME — to the 1-based
// group number the reader takes (`readCoverageRange(url, { group })`), clamped to the axis.
// Kept off the GPU so it is unit-tested directly; the map method that re-reads + re-arms the
// textures is the thin `this`-coupled wrapper around it.

import type { CoverageTime } from '@xgis/data'

/** Resolve `indexOrISO` to a 1-based forecast group in `[1, time.count]`.
 *  - number → a 0-based hour index.
 *  - string → an ISO-8601 valid time mapped onto the REGULAR axis (`firstISO` +
 *    k·`intervalSeconds`); throws if the cell has no regular axis to map onto.
 *  Out-of-range clamps to the nearest end, so a wrap-around play loop lands on the last
 *  hour instead of throwing. */
export function resolveForecastGroup(time: CoverageTime, indexOrISO: number | string): number {
  let idx: number
  if (typeof indexOrISO === 'number') {
    idx = Math.round(indexOrISO)
  } else {
    const targetMs = Date.parse(indexOrISO)
    const firstMs = time.firstISO ? Date.parse(time.firstISO) : NaN
    if (Number.isNaN(targetMs) || Number.isNaN(firstMs) || !(time.intervalSeconds > 0)) {
      throw new Error(
        `[X-GIS] setCoverageTime: cannot map ISO "${indexOrISO}" — the coverage has no ` +
          `regular time axis (needs firstISO + intervalSeconds).`,
      )
    }
    idx = Math.round((targetMs - firstMs) / (time.intervalSeconds * 1000))
  }
  const last = Math.max(0, time.count - 1)
  return Math.min(Math.max(idx, 0), last) + 1 // reader groups are 1-based (Group_001)
}

/** Playback + concurrency state for `Map.setCoverageTime`/`playCoverageTime`, kept off the
 *  Map god-file. Holds (1) a monotonic EPOCH so a slow async re-read that a newer step has
 *  superseded never arms stale data, and (2) a wall-clock timer that steps forecast hours
 *  (each step is an async range re-read, so a timer — not the rAF loop). */
export class CoverageTimePlayer {
  private timer: ReturnType<typeof setTimeout> | null = null
  private epoch = 0

  /** Claim the next epoch for a re-read; `isCurrent(token)` is false once a later step ran. */
  nextEpoch(): number {
    return ++this.epoch
  }
  isCurrent(token: number): boolean {
    return token === this.epoch
  }

  /** Loop `step(nextIndex)` every `stepMs`, wrapping at `count`; `axis()` returns the live
   *  {index, count} of the currently-displayed group (or null to stop). Restarts cleanly. */
  play(
    axis: () => { index: number; count: number } | null,
    step: (index: number) => Promise<void>,
    stepMs: number,
  ): void {
    this.pause()
    const tick = async (): Promise<void> => {
      const a = axis()
      if (!a || a.count <= 1) return // source gone / single-group → stop
      try {
        await step((a.index + 1) % a.count)
      } catch {
        return // a failed step stops playback, never an unhandled rejection that crashes the app
      }
      this.timer = setTimeout(() => void tick(), stepMs)
    }
    this.timer = setTimeout(() => void tick(), stepMs)
  }

  /** Stop playback. Idempotent (safe from `pause()` and `destroy()`). */
  pause(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
