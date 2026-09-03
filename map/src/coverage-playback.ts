// ═══ Forecast-time playback — the interpolating step loop (#1272 E-③, #1333) ═══
//
// Extracted from map.ts (#1569), which is at its LOC ceiling; the public
// `XGISMap.playCoverageTime` doc and signature stay there, this is the body.
//
// Nothing moved changed except the post-await destroyed re-check, which is the
// point: `stepFraction` snapshots the region set BEFORE its await and used to
// re-check nothing after it. Every OTHER coverage landing re-checks
// `deps.destroyed()` (coverage-source.ts) or fails at `writeRegion`; this path
// deliberately bypasses `writeRegion`/`rawDatasets` — that is what makes it a
// TRANSIENT frame — so it was the one landing with no reachable guard, and exactly
// one arm could mint samplers and textures on a destroyed device.

import { interpolateVectorCoverage, type CoverageHandle } from '@xgis/data'
import { coverageRegions, primaryCoverageTime, readRegionsAtGroup } from './coverage-source'
import type { CoverageSourceDeps } from './coverage-source'
import type { CoverageTimePlayer } from './coverage-time'

/** What playback needs from the map. Structural, so map.ts hands over its own
 *  fields and this module never imports `XGISMap`. */
export interface CoveragePlaybackHost {
  readonly player: CoverageTimePlayer
  readonly deps: CoverageSourceDeps
  readonly destroyed: () => boolean
  /** Land on a REAL forecast hour — persists, re-reads, re-derives. */
  readonly stepTo: (index: number) => Promise<unknown> | unknown
  /** Push a TRANSIENT interpolated frame — no persistence, no re-read. */
  readonly pushFrame: (handle: CoverageHandle, region: string) => void
}

export function startCoverageTimePlayback(
  host: CoveragePlaybackHost,
  sourceId: string,
  opts?: { stepMs?: number; interpolateSteps?: number },
): void {
  const steps = Math.max(1, Math.floor(opts?.interpolateSteps ?? 1))
  // Keyed by region: a mosaic blends every resident domain, so the "to" hour is decoded
  // once PER REGION per transition and reused across that transition's sub-frames.
  let cachedTo: { toIndex: number; handles: Map<string, CoverageHandle> } | null = null
  host.player.play(
    () => {
      // The PRIMARY region's axis drives the cursor. Regions step in lockstep
      // (`setCoverageTime` steps all of them), and a neighbour with a shorter forecast
      // simply stops advancing on its own — it must not shorten everyone else's timeline.
      const t = primaryCoverageTime(host.deps, sourceId)
      return t ? { index: t.index, count: t.count } : null
    },
    (index) => {
      cachedTo = null // the real landing re-derives via setCoverageTime's own read
      return host.stepTo(index) as Promise<void>
    },
    opts?.stepMs ?? 700,
    steps > 1
      ? {
          steps,
          stepFraction: async (_fromIndex, toIndex, t) => {
            const prev = coverageRegions(host.deps, sourceId)
            if (!prev) return
            if (!cachedTo || cachedTo.toIndex !== toIndex) {
              // #2375 F-5 — the transition read rides the map's guarded fetch, so
              // `_coverageAbort.cancelAll()` can stop a playback read in flight.
              const handles = await readRegionsAtGroup(
                prev,
                toIndex + 1, // groups are 1-based
                host.deps.guardedFetch(`coverage source "${sourceId}" playback`),
              )
              if (host.destroyed()) return // #1569 — the missing post-await re-check
              cachedTo = { toIndex, handles }
            }
            for (const [region, entry] of prev) {
              const to = cachedTo.handles.get(region)
              if (!to) continue
              host.pushFrame(interpolateVectorCoverage(entry.handle, to, t), region)
            }
          },
        }
      : undefined,
  )
}
