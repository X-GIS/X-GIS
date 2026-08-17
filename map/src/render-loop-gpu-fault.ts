// ═══ Per-frame GPU-fault drain — validation queue → the typed map 'error' event ═══
//
// A WebGPU validation / out-of-memory fault is ASYNCHRONOUS: it surfaces on
// `device.onuncapturederror` (or a popped error scope) long after the call that
// caused it returned. So it never throws out of `renderFrame`, and the 3-strike
// halt (map.ts, `_frameFailures >= 3`) — whose try/catch is the only thing that
// fires a typed `'error'` event from the render path — cannot see it. Before
// #1599 the whole class reached `console.error` and nothing else: a host had no
// programmatic signal that its GPU work was being rejected.
//
// Everything needed was already in place. `ctx._validationErrors` is the one
// capped sink all three fault origins write:
//   • the WebGPU `uncapturederror` listener      (rhi-webgpu/src/gpu.ts)
//   • the WebGL2 `takeGlErrors` frame drain      (render-loop.ts)
//   • a popped validation scope                  (render-loop-helpers.ts, #1599)
// This module is the missing consumer: once per frame it diffs the queue and
// re-emits the NEW entries as `{ phase: 'gpufault', fatal: false }`.
//
// Non-fatal by construction: the frame that produced the fault still presented,
// and the loop keeps running. `'gpufault'` is observability, not a stop signal —
// an unrecoverable stop stays `'boot'` / `'halt'`, and device loss `'devicelost'`.

import type { RenderContext } from '@xgis/engine'
import type { XGISMapErrorInfo } from './layer'

/** One entry of `ctx._validationErrors`. Derived from the context type so the
 *  shape cannot drift from the queue this drain reads. */
type ValidationEntry = RenderContext['_validationErrors'][number]

/** The single method the drain needs off `MapEventBus`. Structural so a test can
 *  hand it a recorder without building a bus (and so this module stays free of a
 *  value dependency on the event bus). */
export interface ErrorEventSink {
  fireErrorEvent(info: XGISMapErrorInfo): void
}

/** Log the first {@link RATE_BURST} faults, then every {@link RATE_EVERY}th.
 *  Byte-for-byte the policy the console sink already applies in
 *  rhi-webgpu/src/gpu.ts (`validationLogCount < 10 || % 100 === 0`), so the typed
 *  channel and the console agree on what a sustained defect reports. A defect
 *  re-hit every frame would otherwise dispatch ~60 events/s into host code. */
const RATE_BURST = 10
const RATE_EVERY = 100

/** Per-RenderLoop drain state. Owns the two counters the policy needs and
 *  nothing else; one instance lives on the loop for the map's lifetime. */
export class GpuFaultDrain {
  /** The last queue entry already surfaced as an event, held BY IDENTITY.
   *
   *  Not a length watermark: `_validationErrors` is a capped ring
   *  (`VALIDATION_ERROR_CAP`, splice-trimmed from the FRONT) and the e2e helpers
   *  clear it in place, so its length stops growing exactly when a sustained
   *  defect is firing — the case this drain exists for. Identity survives both:
   *  a trim that keeps the entry only moves its index (everything after it is
   *  still new), and a trim or clear that DROPS it means every remaining entry
   *  is newer than it, which is what `lastIndexOf → -1` already yields. */
  private _seen: ValidationEntry | null = null
  /** Faults observed since boot — the rate policy's clock. Counts EVERY new
   *  entry, not just the dispatched ones, so "every 100th" means every 100th
   *  fault (matching the console counter), not every 100th dispatch. */
  private _count = 0

  /** Faults observed since boot. Exposed so a gate can assert the drain ran
   *  (the "a diagnostic nothing can reach is not a diagnostic" lesson). */
  get faultCount(): number {
    return this._count
  }

  /** Re-emit the queue entries that appeared since the previous call. Cheap on a
   *  clean frame: an empty queue costs one length read. */
  drain(ctx: RenderContext, sink: ErrorEventSink): void {
    const q = ctx._validationErrors
    if (q.length === 0) {
      // Cleared (or never written) — the next entry starts a fresh diff.
      this._seen = null
      return
    }
    const seen = this._seen
    const start = seen === null ? 0 : q.lastIndexOf(seen) + 1
    for (let i = start; i < q.length; i++) {
      if (this._count < RATE_BURST || this._count % RATE_EVERY === 0) {
        sink.fireErrorEvent({ phase: 'gpufault', fatal: false, error: q[i]!.message })
      }
      this._count++
    }
    this._seen = q[q.length - 1]!
  }
}
