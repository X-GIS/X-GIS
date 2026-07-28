// ═══ A `coverage` source's resident REGIONS and its forecast time axis (#1272, #1367) ═══
//
// Extracted from map.ts when the mosaic went multi-region (#1272 E-④): what used to be "swap
// the one coverage" became residency (push / drop / step N regions), a cohesive subsystem
// with its own invariants, and map.ts is a shrink-only god-file. The public methods stay on
// XGISMap — this owns their bodies.
//
// TWO invariants live here and both were paid for:
//
//  1. EPOCH-GUARDED PER REGION. Every async read claims a token before its await and bails
//     after it if a newer read of THAT region has started. Per-region because a mosaic loads
//     neighbours concurrently: on one shared counter each new region cancelled every other
//     region's in-flight decode, so only whichever started last survived — a multi-region
//     mosaic that silently collapses to one region (#1272 E-④).
//  2. NEVER `rebuildLayers()`. Re-deriving one coverage's field by rebuilding the entire
//     scene is what made every forecast-hour step freeze the map (#1367); the arm here is
//     that coverage arm with none of the rest.

import { readCoverage, readCoverageRange } from '@xgis/data'
import type { Bbox, CoverageHandle, CoverageTime } from '@xgis/data'
import { xlog } from '@xgis/shared'
import { fetchCoverageHandle } from './coverage-fetch'
import {
  decideRefresh,
  probeValidator,
  type CoverageRefreshScheduler,
  type RefreshReason,
} from './coverage-refresh'
import type { CoverageTimePlayer } from './coverage-time'
import { resolveForecastGroup } from './coverage-time'
import type { CoverageRenderer } from './render/coverage-renderer'
import { DEFAULT_REGION } from './render/coverage-renderer'
import { coverageCovers } from './render/coverage-bounds'
import type { CoverageRegionData, RawDataset } from './map-types'

/** What the region machinery needs from the map. An explicit dependency record rather than
 *  the map itself: every member here is something these functions genuinely drive, so the
 *  list doubles as the blast radius. */
export interface CoverageSourceDeps {
  rawDatasets: Map<string, RawDataset>
  /** LATE-BOUND, and it has to be: `XGISMap.coverageRenderer` is declared with a
   *  definite-assignment `!` and only assigned once the GPU boots — a value captured when
   *  the deps record is built is `undefined` forever — and it is REASSIGNED on a backend
   *  switch, so even a correctly-timed capture would go stale. */
  renderer: () => CoverageRenderer
  time: CoverageTimePlayer
  /** True when a `| arrow` / `| flow` field is armed — then a swap re-derives the field
   *  rather than only re-arming the fill. */
  fieldArmed: () => boolean
  /** Re-derive the armed field(s) for ONE region from a handle. */
  armFields: (handle: CoverageHandle, region: string) => void
  /** Arm a region that has NO armed display yet, straight from its LAYER's ShowCommand
   *  (#1426). Distinct from `armRegion` below on purpose: that one preserves the LIVE display
   *  opts across a swap, which is exactly wrong for a FIRST arm — there is no live paint to
   *  preserve, only the renderer's defaults, so a fill-only coverage would silently lose the
   *  `ramp:` / `range:` its layer declared. Used only by the deferred declared-source load. */
  armFromShow: (sourceId: string, handle: CoverageHandle, region: string) => void
  /** Drop one region's compiled arrow glyphs. */
  clearArrows: (region: string) => void
  invalidate: () => void
  /** Live-refresh state: last-seen validators + the poll timers (#1158). The POLICY
   *  (validator comparison, the decision table, the loop's lifecycle) lives in
   *  coverage-refresh.ts and is unit-tested there; this module only drives it. */
  refresh: CoverageRefreshScheduler
  /** The caller's SSRF-guarded fetch for `label`. Injected rather than reached for, so
   *  this module never picks a fetch itself — same contract coverage-fetch.ts holds. */
  guardedFetch: (label: string) => typeof fetch
  /** True once the map is destroyed — a re-read that lands afterwards must not arm. */
  destroyed: () => boolean
}

export interface PushCoverageOpts {
  ramp?: string
  range?: readonly [number, number]
  url?: string
  group?: number
  region?: string
}

/** The regions of a coverage source, or null when `sourceId` is not one. */
export function coverageRegions(
  deps: CoverageSourceDeps,
  sourceId: string,
): ReadonlyMap<string, CoverageRegionData> | null {
  const data = deps.rawDatasets.get(sourceId)
  return data && '_coverage' in data ? data._coverage : null
}

/** The handle answering for a point, or the primary region's when no point is given.
 *  See `XGISMap.getCoverage`. */
export function coverageHandleAt(
  deps: CoverageSourceDeps,
  sourceId: string,
  at?: readonly [number, number],
): CoverageHandle | null {
  const regions = coverageRegions(deps, sourceId)
  if (!regions) return null
  if (!at) return regions.values().next().value?.handle ?? null
  for (const { handle } of regions.values()) {
    if (coverageCovers(handle, at[0], at[1])) return handle
  }
  return null
}

/** The forecast axis of the PRIMARY (first-armed) region — the cursor playback reports. */
export function primaryCoverageTime(
  deps: CoverageSourceDeps,
  sourceId: string,
): CoverageTime | undefined {
  const first = coverageRegions(deps, sourceId)?.values().next().value
  return first?.handle.meta.sourceMeta?.time as CoverageTime | undefined
}

/** Replace one region's entry, leaving every other region of the source untouched — this is
 *  what makes distinct keys ACCUMULATE into a mosaic. Re-reads `rawDatasets` at call time
 *  rather than trusting a pre-await snapshot, because concurrent region loads interleave and
 *  rebuilding from a stale copy silently drops a sibling's write. */
function writeRegion(
  deps: CoverageSourceDeps,
  sourceId: string,
  region: string,
  entry: CoverageRegionData,
): boolean {
  const cur = deps.rawDatasets.get(sourceId)
  if (!cur || !('_coverage' in cur)) return false
  const regions = new Map(cur._coverage)
  regions.set(region, entry)
  deps.rawDatasets.set(sourceId, { _coverage: regions })
  return true
}

/** Arm the renderer for one region, honouring a caller's ramp/range override. */
function armRegion(
  deps: CoverageSourceDeps,
  handle: CoverageHandle,
  region: string,
  override?: { ramp?: string; range?: readonly [number, number] },
): void {
  // ramp/range/opacity are LAYER paint (#1158 INC-D) — an imperative swap keeps the
  // renderer's armed display unless the caller overrides; a later rebuild re-arms.
  if (deps.fieldArmed() && !override?.ramp && !override?.range) {
    deps.armFields(handle, region)
    return
  }
  const renderer = deps.renderer()
  const cur = renderer.displayOpts()
  renderer.setCoverage(
    handle,
    {
      ramp: override?.ramp ?? cur.ramp,
      rangeLo: override?.range?.[0] ?? cur.rangeLo,
      rangeHi: override?.range?.[1] ?? cur.rangeHi,
      opacity: cur.opacity,
    },
    region,
  )
}

/** Read a DECLARED `type: coverage` source's cell and arm it — the BACKGROUND half of the
 *  attach (#1426).
 *
 *  The attach itself returns the moment the (empty) source is registered, because a coverage
 *  cell is the one source type that is BOTH multi-megabyte (10-250 MB) and irrelevant to the
 *  first frame: it never drives camera-fit, and every other layer draws without it. Awaiting
 *  it inside run()'s load barrier put it in front of `rebuildLayers` + the first
 *  `renderLoop()`, so the WHOLE map — the satellite basemap under a NOAA S-111 cell included
 *  — stayed black for the entire stream, and a cell that could not be reached rethrew out of
 *  the barrier and aborted the mount rather than degrading to imagery-only.
 *
 *  Guarded exactly like every other async read in this module: the per-REGION epoch (a host
 *  push or a forecast step can genuinely beat this read — the network is the slow one, and
 *  whoever asked LAST must win), the destroy latch, and the caller's superseded-run probe.
 *
 *  Never `rebuildLayers()` (the module invariant): the arm below is that one coverage's arm. */
export async function loadDeclaredCoverage(
  deps: CoverageSourceDeps,
  sourceId: string,
  url: string,
  isStale?: () => boolean,
): Promise<void> {
  const region = DEFAULT_REGION
  const label = `coverage source "${sourceId}"`
  const token = deps.time.nextEpoch(region)
  let handle: CoverageHandle
  try {
    // The range-then-whole-file ladder lives in coverage-fetch.ts, shared with
    // `refreshCoverage` (#1158): read the same way at attach and at refresh, or a
    // Range-hostile server works once and breaks on the first re-read.
    handle = await fetchCoverageHandle(url, label, deps.guardedFetch(label))
  } catch (e) {
    // ISOLATED, never fatal. The scene is already running — that is the whole point of
    // reading in the background — so an unreachable cell leaves every other layer drawing,
    // which is the imagery-only fallback the live demos document. Same isolate-and-log
    // contract run()'s load barrier gives a source with an unusable declared CRS.
    xlog.error(`[X-GIS] ${label} — ${(e as Error).message}`)
    return
  }
  if (!deps.time.isCurrent(token, region) || deps.destroyed() || isStale?.()) return
  if (!writeRegion(deps, sourceId, region, { handle, url })) return
  deps.armFromShow(sourceId, handle, region)
  deps.invalidate()
}

/** Host-push a cell into one region of a coverage source. See `XGISMap.setCoverageData`. */
export async function pushCoverageRegion(
  deps: CoverageSourceDeps,
  sourceId: string,
  bytes: ArrayBuffer,
  opts?: PushCoverageOpts,
): Promise<void> {
  if (!coverageRegions(deps, sourceId)) {
    throw new Error(
      `[X-GIS] setCoverageData: "${sourceId}" is not a declared coverage source ` +
        `(declare \`source ${sourceId} { type: coverage, url: … }\` first).`,
    )
  }
  const region = opts?.region ?? DEFAULT_REGION
  // `group` (1-based) re-decodes a DIFFERENT forecast hour of the SAME pushed bytes — the
  // whole cell is already in memory (the mosaic cached it), so stepping the time axis costs
  // one CPU decode, no network (#1272 E-③). Defaults to the first group.
  const token = deps.time.nextEpoch(region)
  const handle = await readCoverage(
    bytes,
    undefined,
    opts?.group ? { group: opts.group } : undefined,
  )
  if (!deps.time.isCurrent(token, region)) return
  // Keep the URL when the caller names the pushed cell's (the viewport mosaic passes the
  // region it fetched) so a later range read can address the same cell at another hour.
  if (!writeRegion(deps, sourceId, region, { handle, url: opts?.url })) return
  armRegion(deps, handle, region, opts)
  deps.invalidate()
}

/** Drop one region — its GPU textures and arrow glyphs go with it.
 *  See `XGISMap.removeCoverageRegion`. */
export function dropCoverageRegion(
  deps: CoverageSourceDeps,
  sourceId: string,
  region: string,
): void {
  const cur = coverageRegions(deps, sourceId)
  if (!cur?.has(region)) return
  const regions = new Map(cur)
  regions.delete(region)
  deps.rawDatasets.set(sourceId, { _coverage: regions })
  deps.renderer().clearRegion(region)
  deps.clearArrows(region)
  deps.invalidate()
}

/** Step EVERY resident region to the same forecast hour. See `XGISMap.setCoverageTime`. */
export async function stepCoverageRegions(
  deps: CoverageSourceDeps,
  sourceId: string,
  indexOrISO: number | string,
): Promise<void> {
  const regions = coverageRegions(deps, sourceId)
  if (!regions)
    throw new Error(`[X-GIS] setCoverageTime: "${sourceId}" is not a declared coverage source.`)
  // Concurrently and independently: a region without a URL, or already on the requested hour,
  // skips itself without holding up its neighbours.
  await Promise.all(
    [...regions].map(([region, entry]) => stepOneRegion(deps, sourceId, region, entry, indexOrISO)),
  )
}

async function stepOneRegion(
  deps: CoverageSourceDeps,
  sourceId: string,
  region: string,
  entry: CoverageRegionData,
  indexOrISO: number | string,
): Promise<void> {
  const time = entry.handle.meta.sourceMeta?.time as CoverageTime | undefined
  if (!entry.url || !time || time.count <= 1) return // nothing to step
  const group = resolveForecastGroup(time, indexOrISO)
  if (group - 1 === time.index) return // already showing this hour
  // Re-read the same, already-validated URL (declared source) — one group of it. No new SSRF
  // surface; the whole-file fallback isn't needed (Range worked at first load).
  const token = deps.time.nextEpoch(region)
  const handle = await readCoverageRange(entry.url, { group })
  if (!deps.time.isCurrent(token, region)) return // superseded by a newer step
  if (!writeRegion(deps, sourceId, region, { handle, url: entry.url })) return
  armRegion(deps, handle, region)
  deps.invalidate()
}

/** Decode `group` of every region that has a URL, keyed by region — the "to" side of a
 *  playback transition, read once and reused across its sub-frames. */
export async function readRegionsAtGroup(
  regions: ReadonlyMap<string, CoverageRegionData>,
  group: number,
): Promise<Map<string, CoverageHandle>> {
  const out = new Map<string, CoverageHandle>()
  await Promise.all(
    [...regions].map(async ([region, entry]) => {
      if (!entry.url) return // a urlless host push has no hour to read
      out.set(region, await readCoverageRange(entry.url, { group }))
    }),
  )
  return out
}

// ── Live refresh: re-read a rolling URL only when its content changed (#1158) ──
//
// RE-HOMED here from map.ts by the multi-region merge (#1272 E-④ / #1399). It was written
// against the one-coverage model and now serves the SAME residency the push and step paths
// do, which is what lets the three share `writeRegion` / `armRegion` and — crucially — ONE
// epoch counter per region. On separate counters a refresh landing after a forecast step
// would silently revert the hour, the exact failure that counter exists to prevent.
//
// Validators are keyed per (source, REGION), not per source: a mosaic's regions are
// different URLs, and one shared validator would let a probe of one region decide for
// another. The poll TIMER stays keyed by source — one loop per source, refreshing every
// region it holds.

/** Validator key for one region of one source. The scheduler is a generic keyed store, so
 *  the composite lives here rather than leaking a region concept into it. */
const validatorKey = (sourceId: string, region: string): string => `${sourceId}::${region}`

export interface RefreshCoverageOpts {
  force?: boolean
  bbox?: Bbox
  group?: number
}

/** Re-read every region of `sourceId` whose content changed. See `XGISMap.refreshCoverage`.
 *
 *  Reports `changed: true` when ANY region re-read, with the reason of the first region that
 *  decided to read — a per-region reason list would be a bigger API than the one caller
 *  needs, and a mosaic's regions are the same URL family. */
export async function refreshCoverageSource(
  deps: CoverageSourceDeps,
  sourceId: string,
  opts?: RefreshCoverageOpts,
): Promise<{ changed: boolean; reason: RefreshReason }> {
  const regions = coverageRegions(deps, sourceId)
  if (!regions)
    throw new Error(`[X-GIS] refreshCoverage: "${sourceId}" is not a declared coverage source.`)
  if (![...regions.values()].some((e) => e.url))
    throw new Error(
      `[X-GIS] refreshCoverage: "${sourceId}" was host-pushed without a URL — there is ` +
        `nothing to re-read (pass \`url\` to setCoverageData, or declare a \`coverage\` source).`,
    )
  // Concurrently: a mosaic's neighbours are independent URLs, and each carries its own
  // region epoch, so one slow re-read cannot cancel another's.
  const results = await Promise.all(
    [...regions].map(([region, entry]) =>
      refreshOneRegion(deps, sourceId, region, entry.url, opts),
    ),
  )
  return results.find((r) => r.changed) ?? results[0] ?? { changed: false, reason: 'unchanged' }
}

async function refreshOneRegion(
  deps: CoverageSourceDeps,
  sourceId: string,
  region: string,
  url: string | undefined,
  opts?: RefreshCoverageOpts,
): Promise<{ changed: boolean; reason: RefreshReason }> {
  // A urlless host push has nothing to re-read; its siblings still refresh.
  if (!url) return { changed: false, reason: 'unchanged' }
  const label = `coverage source "${sourceId}"`
  const safe = deps.guardedFetch(label)
  // Revalidation is a cheap HEAD probe, NOT a conditional GET: the read path is HTTP Range,
  // and a 304 on a ranged read is not something the reader can consume.
  const probed = opts?.force ? null : await probeValidator(url, safe)
  const key = validatorKey(sourceId, region)
  const decision = decideRefresh(deps.refresh.validator(key), probed, opts?.force)
  if (!decision.read) return { changed: false, reason: decision.reason }

  const token = deps.time.nextEpoch(region)
  const handle = await fetchCoverageHandle(url, label, safe, {
    ...(opts?.bbox ? { bbox: opts.bbox } : {}),
    ...(opts?.group ? { group: opts.group } : {}),
  })
  // Superseded by a newer read of THIS region, or the map went away — never arm stale data.
  if (!deps.time.isCurrent(token, region) || deps.destroyed())
    return { changed: false, reason: decision.reason }
  deps.refresh.rememberValidator(key, probed)
  if (!writeRegion(deps, sourceId, region, { handle, url }))
    return { changed: false, reason: decision.reason }
  armRegion(deps, handle, region)
  deps.invalidate()
  return { changed: true, reason: decision.reason }
}
