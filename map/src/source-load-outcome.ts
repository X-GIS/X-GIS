// ═══ Post-load-settle outcome policy ═══
//
// Extracted from XGISMap.run(), which sits on a shrink-only LOC ceiling. This
// is the decision the run makes once every source attach has settled, and it
// depends on nothing about the map instance beyond a way to raise an error
// event — so it lifts out cleanly and becomes directly testable, which the
// inline version was not (reaching it needed a live GPU context).

import { xlog } from '@xgis/shared'
import type { XGISMapErrorInfo } from './layer'

/** Decide what a batch of settled source attaches means for the run.
 *
 *  The loads run under `allSettled` (not `all`) so a single source that fails
 *  EPSG reprojection is ISOLATED rather than aborting every load. Every other
 *  rejection — HTTP, JSON parse, SSRF refusal — keeps the fail-the-run contract
 *  and is re-thrown here, which aborts `run()` before the render loop starts.
 *  That asymmetry is deliberate and unchanged.
 *
 *  What changed (#1364) is that failing the run used to be completely OPAQUE:
 *  `run()` rejected, the canvas was never sized, `loaded()` never went true,
 *  and the host got no typed signal naming WHICH source did it — the only
 *  evidence was a console line. A `phase: 'source'` event now fires before the
 *  throw, so a listener learns the cause even though the boot still dies.
 *
 *  `loads` is index-parallel with `results` (both come from the same `.map`
 *  over `commands.loads`), so the name is exact rather than guessed.
 *
 *  Throws the first non-isolated rejection reason; returns normally when every
 *  rejection was isolable. */
export function settleSourceLoads(
  results: PromiseSettledResult<unknown>[],
  loads: readonly { name: string }[],
  fireError: (info: XGISMapErrorInfo) => void,
): void {
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    if (r.status !== 'rejected') continue
    const reason = r.reason as { xgisReprojectFailure?: boolean } | undefined
    if (reason && reason.xgisReprojectFailure === true) {
      // Isolate: log the bad-CRS source and let the other loads stand.
      xlog.error(reason instanceof Error ? reason.message : String(reason))
      continue
    }
    fireError({ phase: 'source', source: loads[i]?.name, fatal: true, error: r.reason })
    throw r.reason
  }
}
