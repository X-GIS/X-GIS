// ═══ Per-tile resolution decision ═══════════════════════════════
//
// The vector-tile-renderer's per-tile loop has long resolved each
// visible tile through a sequence of `if … continue` branches with
// implicit ordering and ~7 escape paths. Two regressions this session
// (commit-49d4801 and commit-71dd401) both lived inside that loop —
// in cases the linear flow's invariants quietly stopped holding.
//
// `classifyTile` is the pure-function half of that flow: given a
// snapshot of the inputs (visible tile + caches + source state),
// returns ONE explicit `TileDecision`. The caller is responsible for
// the side effects (upload, fallback push, fetch request, missed
// counter). Side effects + decision live in different functions; the
// decision is unit-testable with mock caches.

import { tileKeyChildren, tileKeyParent } from '@xgis/compiler'
import type { TileCoord } from '../loader/tiles'

/** What to do with a visible tile this frame. Tagged union so the
 *  TypeScript exhaustiveness check covers every branch — adding a new
 *  decision flags every consumer that has not yet handled it. */
export type TileDecision =
  /** Tile already on GPU — primary draw, no fallback. */
  | { kind: 'primary' }

  /** Visible tile is over-zoom (z > archive maxLevel). Parent at
   *  maxLevel is the camera-magnified rendering. The parent may need
   *  fetch (parentNeedsFetch) or upload (parentNeedsUpload). */
  | {
      kind: 'overzoom-parent'
      parentKey: number
      parentNeedsFetch: boolean
      parentNeedsUpload: boolean
    }

  /** Visible tile not on GPU but THIS layer's slice has data in
   *  catalog. Caller must request GPU upload (uploadVisible=true).
   *  The decision then proceeds as if the visible were not yet
   *  cached — see commit 49d4801 / e8cbf33. */
  | {
      kind: 'queued-with-fallback'
      uploadVisible: true
      fallback: TileDecision
    }

  /** Cached ancestor found (via per-layer walk). Render the parent
   *  stretched at the visible tile's bounds. */
  | {
      kind: 'parent-fallback'
      parentKey: number
      parentNeedsUpload: boolean
    }

  /** Children at z+1 found cached — deck.gl `best-available` /
   *  Mapbox `findLoadedChildren`. Cover with up to 4 children, the
   *  uncached quadrants stay blank for one frame. */
  | {
      kind: 'child-fallback'
      childKeys: number[]
      childrenNeedingUpload: number[]
    }

  /** Sliced source: tile loaded, this layer empty here. Skip
   *  silently — no fallback walk, no miss count. */
  | { kind: 'drop-empty-slice' }

  /** Tile + ancestors all outside archive index. Genuinely no data
   *  to render. Warn once. */
  | { kind: 'drop-no-archive' }

  /** Fetch needs to start (or continue) — visible tile not yet in
   *  catalog, no usable fallback. `requestKey` is what to fetch
   *  (visible if in archive, else the closest archive ancestor). */
  | { kind: 'pending'; requestKey: number | null }

export interface ClassifyTileInputs {
  visible: TileCoord
  visibleKey: number
  maxLevel: number
  /** Parent at maxLevel for over-zoom case. -1 if not applicable. */
  parentAtMaxLevel: number
  /** Closest archive-indexed ancestor key (regardless of cache state).
   *  -1 if no ancestor in archive. */
  archiveAncestor: number
  layerCache: Map<number, unknown>
  /** True iff THIS LAYER's slice for `key` is in the CPU catalog. */
  hasSliceInCatalog: (key: number) => boolean
  /** True iff ANY slice for `key` is in the CPU catalog (regardless of
   *  this layer). Used to detect "tile loaded but this layer empty". */
  hasAnySliceInCatalog: (key: number) => boolean
  /** True iff `key` exists in the source's archive index. */
  hasEntryInIndex: (key: number) => boolean
  sliceLayer: string
}

/** Reusable decision singletons for the static / no-payload kinds.
 *  classifyTile fires for every (sliceLayer × visibleKey) combination
 *  per frame — Bright at z=14 with 25 unique sliceLayers × ~50
 *  effective keys (after horizon cull) × 60 fps × 6-second transition
 *  = 450 000 calls per session, of which most steady-state ones land
 *  on `primary` (already on GPU). Returning a fresh object literal
 *  per call burned through ~213 MB of GC churn (user profile flagged
 *  `Major GC` collecting that amount in one pass). Singletons drop
 *  the alloc to zero for the static decisions.
 *
 *  Object.freeze is intentional: the caller would never mutate a
 *  decision today, and freezing surfaces any future code that tries
 *  to (which would silently corrupt the shared instance). */
const PRIMARY_DECISION: TileDecision = Object.freeze({ kind: 'primary' })
const DROP_EMPTY_DECISION: TileDecision = Object.freeze({ kind: 'drop-empty-slice' })
const DROP_NO_ARCHIVE_DECISION: TileDecision = Object.freeze({ kind: 'drop-no-archive' })

/** Pure tile-resolution classifier. Replaces the per-tile loop's
 *  branched `if … continue` chain with a single decision return. */
export function classifyTile(input: ClassifyTileInputs): TileDecision {
  const { visible, visibleKey, maxLevel, parentAtMaxLevel,
    layerCache, hasSliceInCatalog, hasAnySliceInCatalog,
    sliceLayer } = input
  const tileZ = visible.z

  // 1. OVER-ZOOM FAST PATH — visible tile is past archive maxLevel.
  //    The parent at maxLevel is camera-magnified as fallback.
  if (tileZ > maxLevel) {
    const parentNeedsFetch = !hasSliceInCatalog(parentAtMaxLevel)
    const parentNeedsUpload = !parentNeedsFetch && !layerCache.has(parentAtMaxLevel)
    return {
      kind: 'overzoom-parent',
      parentKey: parentAtMaxLevel,
      parentNeedsFetch,
      parentNeedsUpload,
    }
  }

  // 2. PRIMARY — already on GPU. Hottest steady-state branch; reuse
  //    the frozen singleton to skip an allocation.
  if (layerCache.has(visibleKey)) return PRIMARY_DECISION

  // 3. THIS LAYER's slice in catalog → upload + walk for fallback.
  //    (Bug class commit-49d4801: walking the parent here is critical
  //    so the area is filled while uploadTile is queued behind the
  //    per-frame budget.)
  const thisSliceCached = hasSliceInCatalog(visibleKey)
  if (thisSliceCached) {
    return {
      kind: 'queued-with-fallback',
      uploadVisible: true,
      fallback: classifyFallback(input),
    }
  }

  // 4. SLICED EMPTY — tile loaded but this layer has no features.
  //    Drop silently. Only when tileZ <= maxLevel (over-zoom uses
  //    sub-tile gen which would be blocked otherwise — see comment in
  //    vector-tile-renderer.ts).
  if (sliceLayer && tileZ <= maxLevel && hasAnySliceInCatalog(visibleKey)) {
    return DROP_EMPTY_DECISION
  }

  // 5. Nothing in catalog yet. Walk for fallback.
  return classifyFallback(input)
}

/** Compute the eviction-protection key set for a frame. Implements
 *  the Cesium QuadtreePrimitive replacement invariant: every visible
 *  tile + up to `depth` levels of its ancestors stay in the catalog
 *  so the per-tile fallback walk always finds something to render.
 *
 *  Capped at `depth` levels (default 4) so the protected set stays
 *  bounded even at deep zooms — without a cap, mobile catalog can
 *  grow past MAX_CACHED_BYTES (visible 20 × log2 zoom ~ 200+ keys
 *  × ~2 MB ≫ 100 MB mobile cap). Beyond the cap, eviction is free;
 *  the children-stretch fallback (deck.gl best-available) covers the
 *  rare cold-start cases the depth cap leaves exposed.
 *
 *  Pure function — testable in isolation, no rendering or GPU state. */
export function computeProtectedKeys(
  stableKeys: readonly number[],
  depth: number,
  tileKeyParent: (k: number) => number,
  out: Set<number> = new Set(),
): Set<number> {
  for (const k of stableKeys) {
    out.add(k)
    let pk = k
    for (let d = 0; d < depth && pk > 1; d++) {
      pk = tileKeyParent(pk)
      if (pk < 1) break
      out.add(pk)
    }
  }
  return out
}

/** Fallback selection: parent walk → children stretch → drop or
 *  pending. Shared between path 3 (queued-with-fallback) and path 5
 *  (cold) so both produce the same fallback structure. */
function classifyFallback(input: ClassifyTileInputs): TileDecision {
  const { visibleKey, maxLevel, archiveAncestor, layerCache,
    hasSliceInCatalog, hasEntryInIndex } = input
  const tileZ = input.visible.z

  // Per-layer walk: find the highest cached ancestor for this slice.
  // First sliceCached hit is the highest reachable.
  let cachedAncestorKey = -1
  {
    let walkKey = visibleKey
    for (let pz = tileZ - 1; pz >= 0; pz--) {
      walkKey = tileKeyParent(walkKey)
      if (hasSliceInCatalog(walkKey)) { cachedAncestorKey = walkKey; break }
    }
  }

  if (cachedAncestorKey >= 0) {
    return {
      kind: 'parent-fallback',
      parentKey: cachedAncestorKey,
      parentNeedsUpload: !layerCache.has(cachedAncestorKey),
    }
  }

  // Children stretch (deck.gl best-available).
  if (tileZ < maxLevel) {
    const childKeys: number[] = []
    const childrenNeedingUpload: number[] = []
    for (const ck of tileKeyChildren(visibleKey)) {
      if (hasSliceInCatalog(ck)) {
        childKeys.push(ck)
        if (!layerCache.has(ck)) childrenNeedingUpload.push(ck)
      }
    }
    if (childKeys.length > 0) {
      return { kind: 'child-fallback', childKeys, childrenNeedingUpload }
    }
  }

  // No ancestor or descendant exists in archive at all.
  if (archiveAncestor < 0 && !hasEntryInIndex(visibleKey)) {
    return DROP_NO_ARCHIVE_DECISION
  }

  // Pending: request the visible (or closest archive ancestor if the
  // visible itself is outside the index).
  return {
    kind: 'pending',
    requestKey: hasEntryInIndex(visibleKey) ? visibleKey : (archiveAncestor >= 0 ? archiveAncestor : null),
  }
}

// ═══ Anticipatory prefetch decisions ═══════════════════════════════
//
// `classifyTile` decides what to RENDER given a per-frame snapshot.
// The two pure functions below decide what to PREFETCH alongside
// rendering — Google Earth-style pan-direction speculation and
// AMMOS 3D Tiles Renderer-style `loadSiblings`. Both feed into
// `VectorTileRenderer.pumpPrefetch`, which is invoked by
// `map.ts:renderFrame` exactly once per wall-clock frame (NOT per
// ShowCommand — the bucket scheduler calls VTR.render() ~80× per
// frame on dense styles, and re-issuing prefetch in that loop would
// flood _evictShield + race visible-tile fetches for the catalog's
// maxConcurrent budget).

/** Frame-scope camera snapshot used by `projectPanPrefetchTarget`.
 *  Field naming matches `VectorTileRenderer._lastCamSnap`
 *  (`{cx, cy, zoom, t}`) so call sites don't need a translation
 *  layer. `t` is `performance.now()` ms, used to compute
 *  velocity-per-ms instead of velocity-per-frame — that keeps the
 *  prefetch horizon wall-clock-stable across 30 fps mobile and
 *  60 fps desktop. */
export interface CameraSnapshot {
  cx: number
  cy: number
  zoom: number
  t: number
}

/** Project the camera `lookAheadMs` past `cur.t` along its current
 *  velocity vector when panning is decisive (mirrors Google Earth's
 *  pan-direction speculative prefetch). Returns null when the
 *  existing Tier 1/2 idle-prefetch tiers cover the case better:
 *
 *    - prev null (first frame, no velocity yet)
 *    - zoom in transition (Tier 2 owns this case)
 *    - pitch above the horizon-cull cap (low-pitch only — high pitch
 *      shows so much of the horizon that pan-direction tiles wrap
 *      around the screen and the AMMOS-style sibling fetch covers it
 *      better)
 *    - dt out of band (paused tab, debugger break, first hot frame)
 *    - speed below threshold (camera near-still — no need to project)
 *
 *  Pure: testable in isolation. The caller is responsible for
 *  feeding the result into `visibleTilesFrustumSampled` and routing
 *  the resulting in-archive keys through `TileCatalog.prefetchTiles`. */
export function projectPanPrefetchTarget(
  prev: CameraSnapshot | null,
  cur: CameraSnapshot,
  pitchDeg: number,
  options: {
    lookAheadMs?: number
    minSpeedSqPerMs?: number
    maxPitchDeg?: number
  } = {},
): CameraSnapshot | null {
  if (prev === null) return null
  // Defer to Tier 2 prefetch during zoom transitions — its quadtree
  // re-walk is already paid for the next-LOD frustum.
  if (Math.abs(cur.zoom - prev.zoom) > 0.05) return null
  if (pitchDeg > (options.maxPitchDeg ?? 45)) return null
  const dtMs = cur.t - prev.t
  // dt > 0 guards against debugger pauses and reordered frames; the
  // upper bound (default 200 ms ≈ 12 frames at 60 fps) trims away
  // tab-resume / first-hot-frame outliers where velocity would be
  // wildly inflated.
  if (dtMs <= 0 || dtMs >= 200) return null
  const dx = cur.cx - prev.cx
  const dy = cur.cy - prev.cy
  // Speed in Mercator metres per ms. The default threshold corresponds
  // to ≈ 30 m/frame at 60 fps over 16 ms — noisier than that and the
  // projected camera is meaningless.
  const vxPerMs = dx / dtMs
  const vyPerMs = dy / dtMs
  const speedSq = vxPerMs * vxPerMs + vyPerMs * vyPerMs
  // Default 30 m / 16 ms ≈ 1.875 m/ms → speedSq ≈ 3.5.
  const minSpeedSq = options.minSpeedSqPerMs ?? 3.5
  if (speedSq < minSpeedSq) return null
  const lookAheadMs = options.lookAheadMs ?? 50
  return {
    cx: cur.cx + vxPerMs * lookAheadMs,
    cy: cur.cy + vyPerMs * lookAheadMs,
    zoom: cur.zoom,
    t: cur.t + lookAheadMs,
  }
}

/** AMMOS 3D Tiles Renderer `loadSiblings` — for each visible key,
 *  collect the (≤ 3) quad siblings that are not already visible,
 *  not already cached, and confirmed in the source's archive index.
 *  Capped at `maxKeys` (default 16) so dense viewports don't
 *  exhaust the catalog's `maxConcurrentLoads` budget on mobile (8
 *  concurrent) — visible-tile fetches must keep priority.
 *
 *  Pure: testable in isolation. Dedupes via an internal Set so
 *  adjacent visible tiles sharing the same parent never push the
 *  same sibling twice. */
export function collectSiblingPrefetchKeys(
  visibleKeys: readonly number[],
  hasTileData: (key: number) => boolean,
  hasEntryInIndex: (key: number) => boolean,
  maxKeys = 16,
): number[] {
  if (visibleKeys.length === 0 || maxKeys <= 0) return []
  const visibleSet = new Set(visibleKeys)
  const out = new Set<number>()
  for (const k of visibleKeys) {
    if (out.size >= maxKeys) break
    const parent = tileKeyParent(k)
    if (parent < 1) continue
    const sibs = tileKeyChildren(parent)
    for (const s of sibs) {
      if (s === k) continue
      if (visibleSet.has(s)) continue
      if (out.has(s)) continue
      if (hasTileData(s)) continue
      if (!hasEntryInIndex(s)) continue
      out.add(s)
      if (out.size >= maxKeys) break
    }
  }
  return [...out]
}
