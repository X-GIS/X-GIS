// ═══ S-111 forecast-hour PLAYBACK — the zero-network wiring (#1362) ═══
//
// The play button on the live S-111 demo animates the cell's hourly forecast groups WITHOUT
// touching the network: both the hour it is leaving and the hour it is heading to are decoded
// out of the region cell the mosaic already downloaded (s111-mosaic `peekTime`/`setTime`), and
// the frames in between are `interpolateVectorCoverage` blends pushed as TRANSIENT frames
// (`Map.setCoverageFrame`) — see coverage-time.ts for the engine-side contract.
//
// The CLOCK is not ours: it is the engine's `CoverageTimePlayer`, the same self-clocked,
// deadline-scheduled loop `Map.playCoverageTime` runs. That matters, and is why this module
// exists at all — the demo used to hand-roll `setInterval`-style playback whose fixed tick
// raced its own async work:
//
//   • one tick = decode the target hour (~160 ms for a 258k-cell CBOFS cell) + 5 blended
//     frames (each re-derives the whole arrow + particle field) + the real hour swap
//     (another decode + a layer rebuild) — comfortably MORE than the 900 ms dwell, so
//   • the next tick fired mid-transition, cancelled the in-flight sequence before it could
//     land the hour, and started its own: the displayed hour NEVER advanced (the same 0→1
//     blend replayed forever) while every 900 ms added one more concurrent decode + field
//     rebuild to the main thread — the "huge lag, and it never moves forward" report.
//
// The fix is structural, not a tuning knob: the loop only arms its next tick once the current
// one's work has settled (so work can never pile up), it aims each tick at an absolute
// deadline, and it DROPS a blended frame whose slot has already passed — the real hour swap is
// never dropped, so playback always advances even on a machine that cannot afford a single
// blended frame.

import { interpolateVectorCoverage, type CoverageHandle } from '@xgis/data'
import type { CoverageTimePlayer } from '@xgis/map'

/** Dwell per forecast hour (ms) — the pace the hour READOUT advances at. */
export const S111_PLAY_STEP_MS = 900
/** Sub-frames per hour-to-hour transition: `steps - 1` blended frames then the real hour.
 *  An upper bound, not a promise — the player drops the ones that do not fit the dwell. */
export const S111_PLAY_INTERP_STEPS = 6

/** Everything playback needs from the demo, as plain functions — so the wiring below is
 *  testable without a map, a GPU, or the network. */
export interface S111PlaybackPort {
  /** Live `{index, count}` of the DISPLAYED forecast hour, or null when there is no coverage. */
  axis(): { index: number; count: number } | null
  /** The displayed (persisted) hour's grid — the "from" side of a blend. */
  displayed(): CoverageHandle | null
  /** Decode `hour` of the cached cell WITHOUT displaying it (zero network); null if unavailable. */
  peek(hour: number): Promise<CoverageHandle | null>
  /** Display AND persist `hour` — resolves only once the swap has landed, so the loop never
   *  clocks the next hour off a stale time axis. */
  land(hour: number): Promise<void>
  /** Push a transient blended frame (never persisted). */
  frame(handle: CoverageHandle): void
}

/** Start looping `port` through its forecast hours on `player` (restarts cleanly; stop with
 *  `player.pause()`). The target hour is decoded ONCE per transition and reused by every
 *  blended frame of it. */
export function playS111Time(
  player: CoverageTimePlayer,
  port: S111PlaybackPort,
  opts?: { stepMs?: number; interpolateSteps?: number },
): void {
  const steps = Math.max(1, Math.floor(opts?.interpolateSteps ?? S111_PLAY_INTERP_STEPS))
  let cached: { hour: number; handle: CoverageHandle } | null = null

  player.play(
    () => port.axis(),
    async (hour) => {
      cached = null // the landing re-decodes through the map's own persisted read
      await port.land(hour)
    },
    opts?.stepMs ?? S111_PLAY_STEP_MS,
    steps > 1
      ? {
          steps,
          stepFraction: async (_fromHour, toHour, t) => {
            const from = port.displayed()
            if (!from) return
            let to = cached?.hour === toHour ? cached.handle : null
            if (!to) {
              to = await port.peek(toHour)
              if (!to) return // not decodable (region still loading) — the real swap still lands
              cached = { hour: toHour, handle: to }
            }
            try {
              port.frame(interpolateVectorCoverage(from, to, t))
            } catch {
              // The viewport mosaic swapped regions mid-transition, so the two hours are no
              // longer the same grid (interpolateVectorCoverage refuses a geometry mismatch by
              // design). Drop this frame and re-peek the new region on the next one — a frame
              // that cannot be blended must never stop playback.
              cached = null
            }
          },
        }
      : undefined,
  )
}
