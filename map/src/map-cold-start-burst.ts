// ═══ #1155 F3 — Cold-start tile-pipeline burst controller ═══
//
// Cold-start TTFM has a fixed pacing tail AFTER network+decode are done: three
// per-frame caps (MVT resolve-drain, catalog compile-dispatch, GPU upload)
// spread the first-viewport tile cascade over ~8 frames desktop / ~30 mobile —
// pure pacing while there is nothing on screen to keep smooth. Entering "burst"
// raises all three caps in lockstep (pool drain 4→32, catalog tick 2→16, upload
// 4/1→8/4) so the first viewport fills in a couple of frames, then drops back to
// the steady interaction-smoothness caps once the pipeline converges.
//
// This owns the burst STATE MACHINE (enter / exit / hysteresis / 10 s cap).
// Isolated into its own module (mirrors device-lost-recovery.ts) so the logic is
// unit-testable without booting a map — and so map.ts stays under its LOC
// ceiling (#1003). XGISMap holds one instance and delegates its lifecycle hooks
// (run/runBinary enter, renderLoop tick + rendered-frame note + device-loss/halt
// exit, destroy/re-run exit) to it.

import { getSharedMvtPool } from '@xgis/data'

/** Hard wall-clock cap from burst enter, enforced by a NON-rAF timer
 *  (deps.setTimer, default setTimeout) armed on enter() and cleared on exit().
 *  This is what makes the cap real: the idle-hysteresis exit only advances on
 *  render-loop (rAF) ticks, and a hidden/occluded tab throttles rAF to ~0 Hz —
 *  the same reason the shared MVT pool already backstops its drain with a non-rAF
 *  timer (mvt-worker-pool.ts). Without this timer the raised caps stay elevated
 *  until the next rendering opportunity, i.e. indefinitely while hidden (#1167).
 *  An endless animated source (hasPendingSourceWork() never false) is capped here
 *  too. */
const COLD_START_BURST_MAX_MS = 10_000
/** Consecutive idle frame-starts required to end burst (hysteresis). A single
 *  all-false frame exists mid-cascade — releaseLoading fires when the worker
 *  compile resolves, but VTR enqueues the upload only on the NEXT renderFrame,
 *  and missedTiles is 0 whenever a cached ancestor covers the cell — so a
 *  first-false exit would drop burst before the last upload wave. 3 rides over
 *  that one-frame dip. */
const COLD_START_BURST_IDLE_FRAMES = 3

/** Collaborators the map supplies. Kept as an injected port so the controller
 *  holds no XGISMap back-reference (the same zero-coupling discipline
 *  device-lost-recovery.ts uses) and unit tests can drive it with stubs. */
export interface ColdStartBurstDeps {
  /** Set/clear the burst flag on EVERY currently-registered source's catalog +
   *  renderer. The map iterates its `vtSources` map here. Called at each on/off
   *  transition; a source registered mid-burst is flagged by the map at
   *  registration time, not through this hook. */
  applyToAllSources: (on: boolean) => void
  /** True while any source still has pipeline work that didn't fit last frame's
   *  budgets (XGISMap.hasPendingSourceWork — HTTP fetches, deferred uploads,
   *  last-frame missed tiles). The idle hysteresis reads this each tick. */
  hasPendingSourceWork: () => boolean
  /** #1167 — viewport-class gate. Burst engages ONLY when this returns true.
   *  Returns false on mobile-class viewports: the raised caps overload a phone's
   *  narrow per-frame budget and push the FIRST frame (= TTFM) out (+262 ms
   *  measured on RTX 2080 mobile emulation, #1167), so mobile keeps the steady
   *  4/1 pacing and never enters burst. Defaults to always-eligible (the
   *  device-free unit tests have no viewport). */
  viewportEligible?: () => boolean
  /** Non-rAF wall-clock timer for the hard cap (defaults to setTimeout /
   *  clearTimeout). The cap must NOT ride rAF — a hidden/occluded tab throttles
   *  rAF to ~0 Hz and would leave burst elevated indefinitely. Injected so the
   *  unit test drives it deterministically. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

/** Cold-start burst state machine. Single owner of THIS map's burst state:
 *  the module-singleton MVT pool's refcount (getSharedMvtPool, shared across
 *  maps) + the per-source flags flip exactly once per on/off transition, guarded
 *  by the local `_on` bool, so a rapid re-run can't double-increment the shared
 *  refcount nor a double-exit underflow it. */
export class ColdStartBurstController {
  private _on = false
  /** Rendered frames since enter. The exit hysteresis trusts the idle signal
   *  only after ≥1 render, because requestTiles (which makes
   *  hasPendingSourceWork true) runs INSIDE renderFrame — burst is entered
   *  before the loop starts, so a pre-first-frame check reads a transient
   *  all-false window and would exit immediately. */
  private _renderedFrames = 0
  /** Consecutive idle frame-starts counted toward COLD_START_BURST_IDLE_FRAMES;
   *  reset to 0 the moment work reappears. */
  private _consecutiveIdle = 0
  /** Handle for the non-rAF wall-clock backstop; null when burst is off. */
  private _capTimer: ReturnType<typeof setTimeout> | null = null
  private readonly _viewportEligible: () => boolean
  private readonly _setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly _clearTimer: (handle: ReturnType<typeof setTimeout>) => void
  constructor(private readonly deps: ColdStartBurstDeps) {
    this._viewportEligible = deps.viewportEligible ?? (() => true)
    this._setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this._clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle))
  }

  get isOn(): boolean {
    return this._on
  }

  /** Enter burst, or re-arm on a re-entry (a rapid style swap / device-loss
   *  recovery re-run). The pool refcount + source flags flip exactly once per
   *  on-transition (guarded by `_on`); the timers/counters ALWAYS reset so the
   *  10 s cap + hysteresis re-converge for the new scene. */
  enter(): void {
    // #1167 — desktop-only. A mobile-class viewport never enters burst; enter()
    // is fully inert (no refcount, no source flags, no backstop) so the caps stay
    // at the steady 4/1 pacing a phone's frame budget can absorb.
    if (!this._viewportEligible()) return
    this._armCapTimer()
    if (!this._on) {
      this._on = true
      getSharedMvtPool().beginColdStartBurst()
      this.deps.applyToAllSources(true)
    }
    this._renderedFrames = 0
    this._consecutiveIdle = 0
  }

  /** Leave burst. Idempotent (double-exit safe — the exit predicate and
   *  destroy() can both fire). Releases the pool refcount + clears source flags
   *  exactly once. Callers run this BEFORE source teardown so applyToAllSources
   *  iterates live entries. */
  exit(): void {
    this._clearCapTimer()
    if (!this._on) return
    this._on = false
    getSharedMvtPool().endColdStartBurst()
    this.deps.applyToAllSources(false)
  }

  /** One rendered frame elapsed (called after a successful renderFrame). Gates
   *  the exit hysteresis on ≥1 render — see `_renderedFrames`. */
  noteRenderedFrame(): void {
    if (this._on) this._renderedFrames++
  }

  /** Evaluate the idle-hysteresis exit at a frame-start (only trusted after ≥1
   *  rendered frame). Called from the map's render loop BEFORE its render gate so
   *  it keeps advancing on skipped frames once the scene settles. The hard
   *  wall-clock cap is NOT here — it rides a non-rAF timer (see `_armCapTimer`) so
   *  a hidden tab whose rAF is throttled to ~0 Hz still ends burst on time. */
  tickExit(): void {
    if (!this._on) return
    if (this._renderedFrames < 1) return
    if (this.deps.hasPendingSourceWork()) this._consecutiveIdle = 0
    else if (++this._consecutiveIdle >= COLD_START_BURST_IDLE_FRAMES) this.exit()
  }

  /** Arm (or re-arm) the non-rAF wall-clock backstop. Clears any prior timer so a
   *  re-entry resets the cap window for the new scene, matching the counter reset. */
  private _armCapTimer(): void {
    this._clearCapTimer()
    this._capTimer = this._setTimer(() => this.exit(), COLD_START_BURST_MAX_MS)
  }

  private _clearCapTimer(): void {
    if (this._capTimer !== null) {
      this._clearTimer(this._capTimer)
      this._capTimer = null
    }
  }
}
