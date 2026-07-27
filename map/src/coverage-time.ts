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
  /** Per-region read epochs — see `nextEpoch`. */
  private readonly epochs = new Map<string, number>()
  /** Bumped by every `play()`/`pause()`. A tick that is mid-`await` when playback is paused (or
   *  restarted) holds a STALE generation and must not re-arm the timer — otherwise the orphaned
   *  tick resurrects the loop `pause()` just stopped, and a play/pause toggle leaves two loops
   *  stepping the same source (#1362). */
  private generation = 0

  /** Claim the next epoch for a re-read of `key`; `isCurrent(token, key)` is false once a
   *  later read of THAT key ran.
   *
   *  KEYED BY REGION, because a mosaic loads several regions concurrently (#1272 E-④). With
   *  one global counter every new region's read superseded every OTHER region's in-flight
   *  decode, so only whichever happened to start last ever arrived — the multi-region mosaic
   *  would have silently collapsed back to one region, and looked exactly like a bug in the
   *  selection logic. Supersession is per-region because that is the identity the guard is
   *  actually about: a newer hour of CBOFS invalidates an older hour of CBOFS, not DBOFS. */
  nextEpoch(key = ''): number {
    const next = (this.epochs.get(key) ?? 0) + 1
    this.epochs.set(key, next)
    return next
  }
  isCurrent(token: number, key = ''): boolean {
    return token === this.epochs.get(key)
  }

  /** Loop `step(nextIndex)` every `stepMs`, wrapping at `count`; `axis()` returns the live
   *  {index, count} of the currently-displayed group (or null to stop). Restarts cleanly.
   *
   *  `interp` (#1333) smooths the hour-to-hour cut: instead of one `step()` every `stepMs`, it
   *  ticks `interp.steps` times at `stepMs / interp.steps` — the first `steps - 1` ticks call
   *  `interp.stepFraction(fromIndex, toIndex, t)` (a TRANSIENT blended frame, `t ∈ (0,1)`
   *  exclusive of both ends), and the LAST tick calls the real `step(toIndex)`, landing exactly
   *  where non-interpolated playback would. Total dwell per hour is unchanged (`steps × subMs
   *  = stepMs`); only the number of visible increments grows. Omit (or `steps ≤ 1`) for the
   *  original one-tick-per-hour behaviour, byte-identical (this is the `steps` default).
   *
   *  The loop is SELF-CLOCKED and DEADLINE-scheduled (#1362): the next tick is armed only after
   *  the current one's async work settles, and it is armed for that sub-frame's DEADLINE
   *  (`hourStart + k·subMs`) rather than a fixed `subMs` after the work — so `stepMs` stays an
   *  honest dwell instead of drifting by however long a decode took. A blended sub-frame whose
   *  deadline has already passed is DROPPED (its work would only push the hour further behind);
   *  the real `step` is NEVER dropped, so playback always advances even when one hour's work
   *  costs more than its whole dwell. */
  play(
    axis: () => { index: number; count: number } | null,
    step: (index: number) => Promise<void>,
    stepMs: number,
    interp?: {
      steps: number
      stepFraction: (fromIndex: number, toIndex: number, t: number) => Promise<void>
    },
  ): void {
    this.pause() // bumps `generation`, orphaning any tick already mid-await
    const gen = this.generation
    const steps = Math.max(1, Math.floor(interp?.steps ?? 1))
    const subMs = stepMs / steps
    let sub = 0 // which sub-frame within the CURRENT hour-to-hour transition, 0-based
    let hourStart = Date.now() // when the CURRENT hour-to-hour transition began
    const tick = async (): Promise<void> => {
      if (gen !== this.generation) return // paused/restarted before this tick fired
      const a = axis()
      if (!a || a.count <= 1) return // source gone / single-group → stop
      const toIndex = (a.index + 1) % a.count
      sub++
      try {
        if (sub < steps) {
          // Drop a blended frame that is already past its slot: on a machine where one frame
          // costs more than `subMs`, rendering it anyway would stretch every hour further and
          // further past `stepMs`. Dropping keeps the dwell honest; the landing below still runs.
          if (Date.now() <= hourStart + sub * subMs) {
            await interp!.stepFraction(a.index, toIndex, sub / steps)
          }
        } else {
          await step(toIndex) // the real hour swap — lands exactly where non-interp play would
          sub = 0
          hourStart = Date.now() // the next transition's dwell starts where this one landed
        }
      } catch {
        return // a failed step stops playback, never an unhandled rejection that crashes the app
      }
      if (gen !== this.generation) return // paused/restarted while the work above was awaited
      const delay = Math.max(0, hourStart + (sub + 1) * subMs - Date.now())
      this.timer = setTimeout(() => void tick(), delay)
    }
    this.timer = setTimeout(() => void tick(), subMs)
  }

  /** Stop playback. Idempotent (safe from `pause()` and `destroy()`). */
  pause(): void {
    this.generation++ // orphan a tick that is mid-await, so it never re-arms the timer
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
