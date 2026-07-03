// ═══ CompileBudget — per-frame hybrid count-floor + time-ceiling gate ═══
//
// Extracted VERBATIM from tile-catalog.ts (docs/research/2026-06-20-repo-
// separability-map.md, C5 split). This is the self-contained per-frame
// scheduling concern TileCatalog used to own inline: the wall-clock
// deadline, the two per-frame call counters (compile + sub-tile), the
// tuning constants, and the hybrid floor/ceiling gate that decides
// whether the next compile / sub-tile clip is allowed this frame.
//
// Pure relocation — identical behavior, identical method bodies. The
// catalog keeps a thin owner reference (`this.budget`) and delegates;
// it still owns WHEN to reset (resetCompileBudget, which also ticks
// backends) and the budget owns the COUNTING + gate MECHANISM.
//
// Industry-standard approach adapted for our two cost regimes:
//
//   (1) Heavy raw-parts compiles (z=3, countries) — 5–100 ms each.
//       A pure time budget would allow only 1 per frame (the first
//       call always blows the deadline), regressing convergence
//       from 4/frame to 1/frame. A pure count cap was the old
//       design.
//   (2) Light sub-tile clips (z=15 at high pitch) — microseconds
//       each. A pure count cap of 8 throttles 270-tile bursts to
//       60 frames when the same work fits easily in 6 ms total.
//
// Hybrid policy (both regimes get the best of each):
//   • GUARANTEED FLOOR: always process up to `countFloor` calls
//     per frame regardless of time — preserves the old count-based
//     behaviour under heavy compiles and never starves progress.
//   • TIME-BUDGETED HEADROOM: beyond the floor, keep going until
//     the per-frame wall-clock deadline (6 ms) is hit. Light bursts
//     (sub-tile) can land 50+ per frame; heavy bursts stop at the
//     floor.
//   • HARD SAFETY CAP: `_MAX_PER_FRAME` blocks runaway timer bugs.
//
// Matches Mapbox GL's `MAX_PARALLEL_IMAGERY_REQUESTS` + frame-time
// scheduling in spirit; MapLibre and Deck.gl use analogous tile-
// budget patterns.
//
// Layer: L2 (data) — no imports.

export class CompileBudget {
  private _budgetDeadlineMs = 0
  private _compileCountThisFrame = 0
  private _subTileCountThisFrame = 0
  // Per-CALL budgets restored to original tuning. The earlier "tiles
  // disappear at over-zoom" symptom had two compounded root causes
  // BOTH inside generateSubTile (not in the budgets):
  //   1. _subTileCountThisFrame was incremented TWICE per call
  //      (once at line ~814 + once at line ~1061). Per-call cap
  //      effectively halved → late layers starved.
  //   2. Budget knobs were over-tightened in chase mitigations.
  // Fix 1 is in generateSubTile; restoring 1's worth of headroom
  // here returns single-source convergence speed to baseline
  // (matches the throughput-test targets).
  private static readonly _BUDGET_MS = 6
  static readonly COMPILE_FLOOR = 4
  static readonly SUBTILE_FLOOR = 8
  private static readonly _MAX_PER_FRAME = 128

  /** Reset per-frame counters + arm the wall-clock deadline. */
  reset(): void {
    this._budgetDeadlineMs = this._now() + CompileBudget._BUDGET_MS
    this._compileCountThisFrame = 0
    this._subTileCountThisFrame = 0
  }

  /** Wall-clock reader. Uses performance.now when available (browser +
   *  modern Node) and falls back to Date.now otherwise. */
  private _now(): number {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now()
  }

  /** Hybrid budget gate. `countFloor` calls are always permitted per
   *  frame (no-starvation guarantee); beyond that, calls proceed only
   *  while the wall-clock deadline has not been reached. Upper safety
   *  cap at `_MAX_PER_FRAME` blocks degenerate timer states. */
  private exceeded(callsThisFrame: number, countFloor: number): boolean {
    if (callsThisFrame >= CompileBudget._MAX_PER_FRAME) return true
    if (callsThisFrame < countFloor) return false // always allow under floor
    return this._now() > this._budgetDeadlineMs
  }

  /** True when this frame's compile budget is spent. */
  compileExceeded(): boolean {
    return this.exceeded(this._compileCountThisFrame, CompileBudget.COMPILE_FLOOR)
  }

  /** True when this frame's sub-tile budget is spent. */
  subTileExceeded(): boolean {
    return this.exceeded(this._subTileCountThisFrame, CompileBudget.SUBTILE_FLOOR)
  }

  /** Charge one compile against this frame's budget. */
  chargeCompile(): void {
    this._compileCountThisFrame++
  }

  /** Charge one sub-tile clip against this frame's budget. */
  chargeSubTile(): void {
    this._subTileCountThisFrame++
  }

  get subTileCountThisFrame(): number {
    return this._subTileCountThisFrame
  }
  get compileCountThisFrame(): number {
    return this._compileCountThisFrame
  }
}
