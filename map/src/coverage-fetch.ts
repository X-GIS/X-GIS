// ═══ Coverage fetch — the ONE way a coverage URL becomes a CoverageHandle ═══
//
// Both entry points that read a coverage from the network — the `type: coverage` source
// attach (source-manager) and `Map.refreshCoverage` — must read it the SAME way, or a
// Range-hostile server works at attach and breaks on the first refresh. So the
// range-then-whole-file ladder lives here once instead of twice.
//
// The ladder: HTTP Range first (metadata + the grid the handle needs, not the whole
// multi-timestep cell), falling back to a capped whole-file fetch when the server does
// not honour Range. `fetchFn` carries the caller's SSRF guard — this module never picks
// a fetch itself.
//
// ## Cancellation (#1570) — why there is no `signal` parameter here
//
// This chain had NO `AbortSignal` anywhere, and a signal-less `fetch` is uncancellable
// BY SPEC. `map.destroy()` ran `_coverageRefresh.stopAll()`, which clears setTimeouts
// and nothing else — so a read those timers had already begun streamed to completion,
// was fully buffered and parsed, and only then discarded at a landing guard, on a map
// the host had already unmounted. Cells are 10-250 MB (capped at 256 MB below), so a
// route change mid-load was a quarter-gigabyte transient allocation and a bandwidth
// burst competing with the replacement scene's own fetches; the pending continuations
// also pinned the `deps` closure, and through it the map graph, until every region
// settled.
//
// The signal is injected into `fetchFn` itself (map.ts's `guardedFetch`, cancelled by
// `CoverageReadCancellation` in map-teardown.ts) rather than threaded as a parameter
// through this module, the range reader and the whole-file fallback. One injection
// point covers the WHOLE ladder — the range probe, every chunk read, and the fallback
// — including code paths inside `@xgis/data` that never took an options bag, and
// aborting mid-transfer also cancels the response body stream `readBodyCapped` is
// draining. A `signal` parameter here would cover strictly less and cost more.

import { readCoverage, readCoverageRange, type Bbox, type CoverageHandle } from '@xgis/data'
import { readBodyCapped } from '@xgis/shared'

/** Whole-file fallback cap — the attach path's long-standing budget, kept as one authority. */
const MAX_COVERAGE_BYTES = 256 * 1024 * 1024

export interface CoverageFetchOptions {
  /** Forecast group (1-based) for a multi-timestep cell. */
  group?: number
  /** Geographic read window; the handle keeps full geometry, outside reads NaN. */
  bbox?: Bbox
}

/** Read a coverage URL into a CoverageHandle: Range first, capped whole-file on fallback.
 *  `label` names the source in errors; `fetchFn` MUST be the caller's guarded fetch. */
export async function fetchCoverageHandle(
  url: string,
  label: string,
  fetchFn: typeof fetch,
  opts?: CoverageFetchOptions,
): Promise<CoverageHandle> {
  try {
    return await readCoverageRange(url, { fetch: fetchFn, ...opts })
  } catch {
    // The server does not honour Range (or the ranged read failed) — whole-file path.
    const response = await fetchFn(url)
    if (!response.ok) throw new Error(`[X-GIS] ${label} — HTTP ${response.status}`)
    const raw = await readBodyCapped(response, MAX_COVERAGE_BYTES, label)
    const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
    return readCoverage(buf, url, opts)
  }
}
