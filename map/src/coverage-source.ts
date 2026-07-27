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
import type { CoverageHandle, CoverageTime } from '@xgis/data'
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
  renderer: CoverageRenderer
  time: CoverageTimePlayer
  /** True when a `| arrow` / `| flow` field is armed — then a swap re-derives the field
   *  rather than only re-arming the fill. */
  fieldArmed: () => boolean
  /** Re-derive the armed field(s) for ONE region from a handle. */
  armFields: (handle: CoverageHandle, region: string) => void
  /** Drop one region's compiled arrow glyphs. */
  clearArrows: (region: string) => void
  invalidate: () => void
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
  const cur = deps.renderer.displayOpts()
  deps.renderer.setCoverage(
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
  deps.renderer.clearRegion(region)
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
