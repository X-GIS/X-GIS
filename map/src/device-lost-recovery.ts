// ═══ Device-lost bounded auto-recovery (#1153 B) ═══
//
// When the GPU device is lost mid-session (driver reset, tab backgrounding, iOS
// GPU reclaim on a hidden tab), the render loop stops issuing work into the dead
// device (render-loop.ts) but cannot revive itself — the rAF chain is dead and
// `running` stays true, so invalidate()/resize() can't restart it. The verified
// recovery is a FRESH run() through initGPU: a new device is acquired and
// RenderTargets.syncDevice reattaches the targets. The engine calls
// `ctx.onDeviceLostInternal` (rhi-webgpu gpu.ts) on loss; the map wires that slot
// to the policy below.
//
// Isolated into its own module so the budget/visibility policy is unit-testable
// without booting a map (and so map.ts stays under its LOC ceiling, #1003).
//
// ## #1576 — the failure paths inside the recovery machinery
//
// #1153 built this and #1359 re-verified it healthy, and both are right about the SUCCESS
// path: the budget, the visibility deferral and the epoch guards all work. What neither
// covered is what happens when the re-init itself FAILS — which is precisely when it is
// most likely to, because the GPU is mid-reset.
//
// TWO wedges used to hold after such a failure, and together they made the map
// permanently dead while the budget still had room:
//
//  • `XGISMap._deviceLostResumePending` was cleared only by `_armDeviceLostRecovery`,
//    which runs strictly AFTER `this.ctx = result`. A re-run that threw before ctx
//    publication left the latch true forever, so every later visibilitychange→visible
//    failed its `!pending` test and returned — contradicting this module's own documented
//    "repeated hide/show cycles with a failing re-init exhaust budget.max".
//  • the stored recover closure captured the epoch of the run that armed it, and the
//    failed attempt's own entry bump (`_runProgram` claims an epoch at entry) made that
//    capture stale — so even a cleared latch would no-op at `_epochStale`.
//
// `XGISMap._settleRecovery` closes both: it clears the latch on EVERY exit and re-points
// the recovery epoch at the one the failed attempt claimed, so a bad attempt no longer
// poisons the next. A genuinely newer run re-arms the closure wholesale, so this cannot
// resurrect a superseded scene. It also stops the re-run being a floating `void` — a
// re-boot failing at the data-load barrier used to produce an unhandled rejection and no
// event at all.
//
// The third gap was the report itself: see the `fatal` handling below.

import type { RhiDeviceLostInfo } from '@xgis/engine'
import type { XGISMapErrorInfo } from './layer'

/** The render-context slot the engine calls on device loss (gpu.ts). */
export interface DeviceLostSink {
  onDeviceLostInternal?: (info: RhiDeviceLostInfo) => void
}

/** Mutable recovery budget — held by the map so it PERSISTS across re-runs. A
 *  recovery re-wires the hook on the fresh ctx, but the counter must NOT reset,
 *  or a device stuck in a loss loop would re-init forever. */
export interface DeviceLostBudget {
  recoveries: number
  readonly max: number
}

/** Collaborators the map supplies to the recovery policy. */
export interface DeviceLostRecoveryDeps {
  /** Fire the observability `'error'` event. */
  fireError: (info: XGISMapErrorInfo) => void
  /** Re-run the last source through a fresh initGPU (the verified recovery path). */
  recover: () => void
  /** Page-visibility gate — a hidden tab (iOS reclaim is routine while hidden)
   *  must not thrash re-inits; a loss deferred while hidden is re-armed by
   *  {@link resumeDeviceLostRecovery} from the map's visibilitychange→visible
   *  handler (invalidate() alone does NOT revive a dead rAF chain, so the map
   *  would otherwise stay dead forever on return). Defaults to
   *  {@link documentIsVisible}. */
  isVisible?: () => boolean
}

/** Default visibility gate: visible unless a DOM reports the page hidden. */
export function documentIsVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible'
}

/** Wire bounded device-lost auto-recovery onto a freshly-resolved render ctx.
 *  On loss: fire the typed `'error'` event ({phase:'devicelost', fatal:false}),
 *  then — if the budget still allows AND the page is visible — schedule a fresh
 *  run() in a microtask. Intentional teardown never reaches here (gpu.ts guards
 *  the 'destroyed' reason before calling the internal hook). */
export function wireDeviceLostRecovery(
  ctx: DeviceLostSink,
  budget: DeviceLostBudget,
  deps: DeviceLostRecoveryDeps,
): void {
  const isVisible = deps.isVisible ?? documentIsVisible
  ctx.onDeviceLostInternal = (info) => {
    // Visibility FIRST: a loss on a hidden tab (routine iOS reclaim while
    // backgrounded) skips the attempt WITHOUT burning budget — otherwise two
    // background reclaims exhaust the budget before the user ever returns. The
    // deferred re-init that this defers to is resumeDeviceLostRecovery below,
    // wired by the map's visibilitychange→visible handler (#1153 M5).
    const visible = isVisible()
    const willRecover = visible && budget.recoveries++ < budget.max
    // #1576 B — the event fires AFTER the budget is evaluated, and `fatal` reports
    // whether the map is actually DEAD. It used to fire unconditionally with
    // `fatal: false`, so budget exhaustion — the one moment the map becomes
    // permanently unusable — was reported with the identical payload as a fault the
    // engine went on to auto-recover from, and nothing anywhere fired `fatal: true`.
    // `layer.ts` defines `fatal` as exactly that distinction. A loss while HIDDEN is
    // NOT fatal: it burned no budget and `resumeDeviceLostRecovery` will pick it up.
    deps.fireError({ phase: 'devicelost', fatal: visible && !willRecover, error: info })
    if (willRecover) queueMicrotask(deps.recover)
  }
}

/** Deferred device-lost recovery — the #1153 M5 companion to the visibility gate
 *  above. A device lost while the tab was HIDDEN skips its recovery (to protect
 *  the budget) and the engine's loss hook never re-fires; `invalidate()` only
 *  sets flags and does NOT re-arm a dead rAF chain — so without this the map would
 *  stay permanently dead after an iOS hidden-tab GPU reclaim. The map's
 *  visibilitychange→visible handler calls this when `ctx.deviceLost`. Same bounded
 *  budget as the live path: it burns one unit per attempt (so repeated hide/show
 *  cycles with a failing re-init exhaust `budget.max` and the map goes dead BY
 *  DESIGN — bounded recovery is the P0 contract). Returns whether a recovery was
 *  scheduled. */
export function resumeDeviceLostRecovery(
  ctx: { deviceLost: boolean },
  budget: DeviceLostBudget,
  deps: { recover: () => void; fireError?: (info: XGISMapErrorInfo) => void },
): boolean {
  if (!ctx.deviceLost) return false
  if (budget.recoveries++ < budget.max) {
    queueMicrotask(deps.recover)
    return true
  }
  // #1576 B — budget spent on the DEFERRED path too. The host has to be able to tell
  // "we recovered" from "the map is dead", and this exit is the second way to die.
  deps.fireError?.({
    phase: 'devicelost',
    fatal: true,
    error: new Error(
      `[X-GIS] device-lost recovery budget exhausted (${budget.max} attempts) — the map is stopped`,
    ),
  })
  return false
}
