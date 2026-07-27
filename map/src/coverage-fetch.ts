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
