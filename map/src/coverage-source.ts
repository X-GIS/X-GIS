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

import { isHdf5, readCoverage, readCoverageRange } from '@xgis/data'
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
import {
  itemsForView,
  parseCoverageCatalogue,
  type CoverageCatalogueItem,
  type CoverageCatalogueState,
} from './coverage-catalogue'
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
   *  `ramp:` / `range:` its layer declared.
   *
   *  RETURNS whether any show claimed the source — `armRegion` needs that answer, because
   *  `fieldArmed` is a latch a FIRST push legitimately beats. */
  armFromShow: (sourceId: string, handle: CoverageHandle, region: string) => boolean
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
  /** Per-source catalogue residency state (#1453), for the sources whose `url:` named a STAC
   *  ItemCollection rather than a single cell. Empty for every other coverage source. */
  catalogues: Map<string, CoverageCatalogueState>
  /** The current viewport as `[W, S, E, N]` degrees, or null before the camera can answer.
   *  A thunk for the same reason `renderer` is one — it is read per resolve, never captured. */
  view: () => Bbox | null
  /** Start re-resolving catalogue residency on camera move. Called when the FIRST catalogue
   *  registers, idempotently — a map whose coverage is a single cell (or which declares none)
   *  never subscribes, so it cannot pay for, or be observed to hold, a listener it has no use
   *  for. */
  watchViewport: () => void
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

/** Arm the renderer for one region, honouring a caller's ramp/range override.
 *
 *  THREE arms, and the middle one is why this is not two lines (#1449):
 *
 *  1. A field is already armed and the caller overrode nothing → re-derive it from the live
 *     display opts. The steady state: a forecast step, a host frame push.
 *  2. `fieldArmed()` is FALSE but a layer DECLARES a field → arm from the SHOWS, the same
 *     authority the deferred declared-source read uses. `fieldArmed` is a latch set by
 *     `rebuildLayers`, and the rebuild only reaches its coverage branch once the source HAS
 *     data — so the very first push, which is what puts the data there, always finds the latch
 *     false and used to fall through to the raw `setCoverage` below. That bypasses
 *     `armCoverageDrape` entirely: no `hidden`, no `flowOnly`, no arrows. Under the arrows
 *     portrayal a first-loaded region therefore showed the ramp drape it was supposed to hide
 *     and none of its glyphs, until some later interaction re-armed it — and a viewport mosaic
 *     pushes several regions in that same first batch, which is where it was most visible.
 *  3. No field declared, or an imperative paint override → the plain fill arm.
 */
function armRegion(
  deps: CoverageSourceDeps,
  sourceId: string,
  handle: CoverageHandle,
  region: string,
  override?: { ramp?: string; range?: readonly [number, number] },
): void {
  // ramp/range/opacity are LAYER paint (#1158 INC-D) — an imperative swap keeps the
  // renderer's armed display unless the caller overrides; a later rebuild re-arms.
  const overridden = override?.ramp != null || override?.range != null
  if (deps.fieldArmed() && !overridden) {
    deps.armFields(handle, region)
    return
  }
  if (!overridden && deps.armFromShow(sourceId, handle, region)) return
  const renderer = deps.renderer()
  const cur = renderer.displayOpts()
  renderer.setCoverage(
    handle,
    {
      ramp: override?.ramp ?? cur.ramp,
      rangeLo: override?.range?.[0] ?? cur.rangeLo,
      rangeHi: override?.range?.[1] ?? cur.rangeHi,
      opacity: cur.opacity,
      filter: cur.filter,
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
 *  The URL may name ONE CELL or a CATALOGUE of them (#1453); which it is is decided by the
 *  bytes, not the URL — see `probeCoverageUrl` below.
 *
 *  Never `rebuildLayers()` (the module invariant): the arm below is that one coverage's arm. */
export async function loadDeclaredCoverage(
  deps: CoverageSourceDeps,
  sourceId: string,
  url: string,
  isStale?: () => boolean,
): Promise<void> {
  const label = `coverage source "${sourceId}"`
  const catalogue = await probeCoverageUrl(deps, sourceId, url, label)
  if (catalogue === 'failed') return
  if (catalogue) {
    // The catalogue owns residency from here: resolve for whatever the camera can answer now,
    // and every move-end after (`syncCoverageResidency`, driven by map.ts).
    await syncCoverageResidency(deps, sourceId, isStale)
    return
  }
  const region = DEFAULT_REGION
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

// ── Catalogue-driven residency: the engine decides what is resident, from the viewport (#1453) ──

/** Read at most `n` leading bytes of a response, then cancel the rest.
 *
 *  Bounded on purpose: a server that ignores `Range` answers 200 with the WHOLE body, and for
 *  an S-100 cell that is 10-250 MB downloaded to look at eight bytes. Streaming the first
 *  chunk and cancelling costs the same on a compliant 206 and bounds the non-compliant 200. */
async function readHead(res: Response, n: number): Promise<Uint8Array> {
  const reader = res.body?.getReader()
  if (!reader) return new Uint8Array((await res.arrayBuffer()).slice(0, n))
  const out = new Uint8Array(n)
  let got = 0
  try {
    while (got < n) {
      const { done, value } = await reader.read()
      if (done || !value) break
      const take = Math.min(n - got, value.length)
      out.set(value.subarray(0, take), got)
      got += take
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return out.subarray(0, got)
}

/** Is this coverage URL a CATALOGUE (registers it and returns true) or ONE CELL (false)?
 *  `'failed'` when the URL could not be read or is neither — already logged, already isolated.
 *
 *  The discriminator is the leading bytes, not the URL: an S-100 cell begins with the HDF5
 *  signature, so a content sniff needs no file extension, no new `type:`, and therefore no DSL
 *  change at all. The alternative — deciding by `.json` vs `.h5` — is a guess about a server's
 *  naming taste, and the S-111 bridge's own `/opendata/s111/latest/<model>.h5` route shows how
 *  little a path says about what answers it. */
async function probeCoverageUrl(
  deps: CoverageSourceDeps,
  sourceId: string,
  url: string,
  label: string,
): Promise<boolean | 'failed'> {
  const safe = deps.guardedFetch(label)
  try {
    const res = await safe(url, { headers: { Range: 'bytes=0-7' } })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    if (isHdf5(await readHead(res, 8))) return false
  } catch (e) {
    // ISOLATED, never fatal — the same contract the single-cell read below holds.
    xlog.error(`[X-GIS] ${label} — ${(e as Error).message}`)
    return 'failed'
  }
  try {
    const res = await safe(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const items = parseCoverageCatalogue(await res.json(), url, label)
    deps.catalogues.set(sourceId, {
      url,
      items,
      wanted: [],
      suppressed: new Set(),
      inFlight: new Set(),
    })
    deps.watchViewport() // from here the camera, not the host, decides what is resident
    return true
  } catch (e) {
    xlog.error(`[X-GIS] ${label} — ${(e as Error).message}`)
    return 'failed'
  }
}

/** Read one catalogue cell and arm it under its item id. A FIRST arm for that region, so it
 *  goes through `armFromShow` (the layer's declared ramp/range) rather than `armRegion`, which
 *  preserves a live display this region does not have yet — see the deps note on `armFromShow`. */
async function armCatalogueItem(
  deps: CoverageSourceDeps,
  sourceId: string,
  item: CoverageCatalogueItem,
  state: CoverageCatalogueState,
  isStale?: () => boolean,
): Promise<void> {
  // The STAC item id IS this cell's region key — named so, because every epoch claim and check
  // in this module must be visibly region-scoped (a single global counter let each newly
  // loading region cancel its neighbours' in-flight decodes, collapsing a mosaic to whichever
  // domain started last, #1272 E-④). `coverage-timestep-cost.test.ts` enforces exactly that.
  const region = item.id
  const label = `coverage source "${sourceId}" region "${region}"`
  const token = deps.time.nextEpoch(region)
  state.inFlight.add(region)
  let handle: CoverageHandle
  try {
    handle = await fetchCoverageHandle(item.href, label, deps.guardedFetch(label))
  } catch (e) {
    // One unreachable cell must not cost the mosaic its neighbours; a later move retries it.
    xlog.error(`[X-GIS] ${label} — ${(e as Error).message}`)
    return
  } finally {
    state.inFlight.delete(region)
  }
  // STILL WANTED? A cell is multi-megabyte, so the camera can easily move a continent away
  // while one streams, and the epoch guard cannot see that: it is per REGION, and this read
  // was never superseded by another read of THIS region — what changed is that nobody wants
  // the region at all. Arming anyway put Delaware on screen over San Francisco, drawing
  // nothing and holding a GPU slot the wanted cell needed. Found by the live render gate;
  // `coverage-residency-driver.test.ts` now holds the fetch open to reproduce it.
  if (!state.wanted.includes(region)) return
  if (!deps.time.isCurrent(token, region) || deps.destroyed() || isStale?.()) return
  if (!writeRegion(deps, sourceId, region, { handle, url: item.href })) return
  deps.armFromShow(sourceId, handle, region)
  deps.invalidate()
}

/** Bring one catalogue-backed source's resident regions in line with the current viewport.
 *  Called at attach and on every move-end. A no-op for a source whose `url:` named a cell.
 *
 *  Arms SEQUENTIALLY, most-relevant first. That is not a missing concurrency cap: the budget
 *  rule below only means anything if the arms are ordered — with parallel reads, "stop when
 *  the budget speaks" is a race — and the cell actually under the cursor should never queue
 *  behind a neighbour. */
export async function syncCoverageResidency(
  deps: CoverageSourceDeps,
  sourceId: string,
  isStale?: () => boolean,
): Promise<void> {
  const state = deps.catalogues.get(sourceId)
  const view = deps.view()
  if (!state || !view) return
  const wanted = itemsForView(state.items, view)
  const keys = wanted.map((i) => i.id)
  // A changed wanted SET is the only event that can make room, so it is what lifts the budget
  // suppression. A pure reorder (a zoom over the same cells) must not, or the thrash returns.
  if (keys.length !== state.wanted.length || keys.some((k) => !state.wanted.includes(k)))
    state.suppressed.clear()
  state.wanted = keys

  // Drop what left the view BEFORE arming what entered, so the peak resident set never
  // exceeds what the budget would otherwise have to evict mid-pan.
  for (const region of [...(coverageRegions(deps, sourceId) ?? new Map()).keys()])
    if (!keys.includes(region)) dropCoverageRegion(deps, sourceId, region)

  for (const item of wanted) {
    if (deps.destroyed() || isStale?.()) return
    // A NEWER resolve has replaced `state.wanted` — this loop is walking a list the camera
    // has moved past, so every remaining fetch would be work for a viewport nobody is looking
    // at. Stop; the newer resolve is already arming the right cells.
    if (!state.wanted.includes(item.id)) return
    if (state.suppressed.has(item.id) || state.inFlight.has(item.id)) continue
    if (coverageRegions(deps, sourceId)?.has(item.id)) continue
    await armCatalogueItem(deps, sourceId, item, state, isStale)
    if (state.suppressed.size === 0) continue

    // THE BUDGET SPOKE — and it evicted the WRONG cell, so this backs the arm out.
    //
    // The renderer's LRU evicts the least-recently-ARMED region. Arms go in relevance order,
    // so the most relevant cell is the oldest and is exactly what gets evicted: over San
    // Francisco, arming the basin-wide `wcofs` threw out the local `sfbofs` that had just been
    // armed for it, leaving a coarse cell drawing 2% of the frame where the right one had
    // drawn 45%. Recency and relevance run in opposite directions; no arming order fixes that
    // (least-relevant-first would make the user wait for a cell they do not need).
    //
    // So the arm that overflowed the budget is undone and its victims restored. That leaves
    // exactly the invariant the resolve is for — the resident set is the most-relevant PREFIX
    // that fits — while the budget itself stays the one authority: it still decides WHEN the
    // set is full, this only declines the trade it offered. Bounded to once per resolve,
    // because the loop returns immediately after.
    dropCoverageRegion(deps, sourceId, item.id)
    const victims = [...state.suppressed].filter((r) => r !== item.id)
    state.suppressed.clear()
    // THE CELL THAT DID NOT FIT is what gets suppressed — not (only) its victims. Suppressing
    // the victims instead left this loop re-trying the same over-budget arm on every move-end:
    // arm it, evict the good cell, back out, restore, and again on the next resolve — four
    // wasted reads per move for a cell that provably does not fit. The suppression lifts when
    // the wanted SET changes, which is the only event that can make room.
    state.suppressed.add(item.id)
    for (const key of victims) {
      const victim = wanted.find((w) => w.id === key)
      if (victim) await armCatalogueItem(deps, sourceId, victim, state, isStale)
      // A victim that could not be restored must not be retried every move-end either.
      if (!coverageRegions(deps, sourceId)?.has(key)) state.suppressed.add(key)
    }
    return
  }
}

/** Re-resolve EVERY catalogue-backed source against the current viewport — the move-end
 *  listener's whole body. Inert (one empty-map iteration) while no source declared a
 *  catalogue, which is why the map installs it unconditionally rather than lazily. */
export function resolveCoverageCatalogues(deps: CoverageSourceDeps): void {
  for (const sourceId of deps.catalogues.keys()) void syncCoverageResidency(deps, sourceId)
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
        `(declare \`source ${sourceId} { type: coverage }\` first — \`url:\` is optional, ` +
        `and omitting it is how you say THIS host owns residency).`,
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
  armRegion(deps, sourceId, handle, region, opts)
  deps.invalidate()
}

/** Everything a dropped region must take with it, whoever dropped it.
 *
 *  Wired to `CoverageRenderer.onRegionDropped`, so it runs for BOTH kinds of drop: the
 *  explicit `removeCoverageRegion` below, and — the reason it exists — the LRU evictions the
 *  renderer makes on its own under its GPU byte budget, which nothing else observes (#1419).
 *
 *  ONE function rather than the two identical closures map.ts used to write (the initial
 *  renderer build and the backend-switch rebuild), because everything a drop must clean up now
 *  lives on one line of sight instead of two that can drift. */
export function onCoverageRegionDropped(deps: CoverageSourceDeps, region: string): void {
  deps.clearArrows(region)
  // …and the CPU-side region map goes with it, so residency has ONE authority: the renderer's
  // GPU byte budget. Before this, an LRU eviction left the region listed here forever —
  // `getCoverage` answered with a handle for a region that had no GPU state, and a viewport
  // driver reading this map would never re-push it, because it still believed it was resident.
  // Reacting to the eviction beats predicting it: a second byte budget one layer up would be
  // counting FILE bytes against the renderer's GPU bytes, two numbers that cannot agree.
  //
  // Scans every source because the renderer's region keys are one flat space shared by the
  // whole map, while `rawDatasets` keys regions per source; the scan is over a scene's
  // sources, and only a coverage source can hold the key at all.
  for (const [sourceId, data] of deps.rawDatasets) {
    if (!('_coverage' in data) || !data._coverage.has(region)) continue
    const regions = new Map(data._coverage)
    regions.delete(region)
    deps.rawDatasets.set(sourceId, { _coverage: regions })
  }
  // An eviction of something the catalogue driver still WANTS is the budget telling it the
  // resident set is full (#1453). Re-arming would only evict a neighbour and bounce back on
  // the next move, so the driver stops until the wanted set actually changes.
  for (const state of deps.catalogues.values())
    if (state.wanted.includes(region)) state.suppressed.add(region)
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
  armRegion(deps, sourceId, handle, region)
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
  armRegion(deps, sourceId, handle, region)
  deps.invalidate()
  return { changed: true, reason: decision.reason }
}
