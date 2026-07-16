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

/** Hard wall-clock cap from burst enter. Guarantees the raised caps can never
 *  stay elevated forever if the convergence signal never reports idle — e.g. an
 *  endless animated source keeps every frame busy and hasPendingSourceWork()
 *  never goes false. */
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
  /** Clock injection for the 10 s cap; defaults to performance.now. */
  now?: () => number
}

/** Cold-start burst state machine. Single owner of THIS map's burst state:
 *  the module-singleton MVT pool's refcount (getSharedMvtPool, shared across
 *  maps) + the per-source flags flip exactly once per on/off transition, guarded
 *  by the local `_on` bool, so a rapid re-run can't double-increment the shared
 *  refcount nor a double-exit underflow it. */
export class ColdStartBurstController {
  private _on = false
  private _enterTime = 0
  /** Rendered frames since enter. The exit hysteresis trusts the idle signal
   *  only after ≥1 render, because requestTiles (which makes
   *  hasPendingSourceWork true) runs INSIDE renderFrame — burst is entered
   *  before the loop starts, so a pre-first-frame check reads a transient
   *  all-false window and would exit immediately. */
  private _renderedFrames = 0
  /** Consecutive idle frame-starts counted toward COLD_START_BURST_IDLE_FRAMES;
   *  reset to 0 the moment work reappears. */
  private _consecutiveIdle = 0
  private readonly _now: () => number
  constructor(private readonly deps: ColdStartBurstDeps) {
    this._now = deps.now ?? (() => performance.now())
  }

  get isOn(): boolean {
    return this._on
  }

  /** Enter burst, or re-arm on a re-entry (a rapid style swap / device-loss
   *  recovery re-run). The pool refcount + source flags flip exactly once per
   *  on-transition (guarded by `_on`); the timers/counters ALWAYS reset so the
   *  10 s cap + hysteresis re-converge for the new scene. */
  enter(): void {
    if (!this._on) {
      this._on = true
      getSharedMvtPool().beginColdStartBurst()
      this.deps.applyToAllSources(true)
    }
    this._enterTime = this._now()
    this._renderedFrames = 0
    this._consecutiveIdle = 0
  }

  /** Leave burst. Idempotent (double-exit safe — the exit predicate and
   *  destroy() can both fire). Releases the pool refcount + clears source flags
   *  exactly once. Callers run this BEFORE source teardown so applyToAllSources
   *  iterates live entries. */
  exit(): void {
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

  /** Evaluate the exit at a frame-start: the hard 10 s cap first, then the idle
   *  hysteresis (only trusted after ≥1 rendered frame). Called from the map's
   *  render loop BEFORE its render gate so it keeps advancing on skipped frames
   *  once the scene settles. */
  tickExit(): void {
    if (!this._on) return
    if (this._now() - this._enterTime >= COLD_START_BURST_MAX_MS) {
      this.exit()
      return
    }
    if (this._renderedFrames < 1) return
    if (this.deps.hasPendingSourceWork()) this._consecutiveIdle = 0
    else if (++this._consecutiveIdle >= COLD_START_BURST_IDLE_FRAMES) this.exit()
  }
}
