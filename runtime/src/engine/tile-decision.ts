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

import { tileKey, tileKeyChildren, tileKeyParent } from '@xgis/compiler'
import type { TileCoord } from '../data/tile-select'
import { visibleTilesFrustum, visibleTilesFrustumSampled, makeTileCoord } from '../data/tile-select'
import type { Camera } from '@xgis/engine'
import { type Projection, mercatorYToLat } from '@xgis/engine'
import { routeToSphereSelector } from '@xgis/engine'
import { globeVisibleTiles } from '@xgis/engine'
import { representsCenterAs } from '@xgis/engine'

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
   *  stretched at the visible tile's bounds. `wantsRequestKey` is
   *  the next-deeper archive key to fetch (typically the visible
   *  tile itself) so the parent-fallback loop advances toward
   *  proper-z resolution instead of stalling on the parent forever
   *  — the bug class where z=14 never loaded on desktop because
   *  z=13 parent was always good enough to skip the pending path. */
  | {
      kind: 'parent-fallback'
      parentKey: number
      parentNeedsUpload: boolean
      wantsRequestKey: number | null
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
  /** True iff THIS LAYER's slice for `key` is in the CPU catalog AND
   *  carries real geometry (not an empty placeholder). Single-layer
   *  GeoJSON stores an EMPTY placeholder under the default '' slice for
   *  tiles with no overlapping features (geojson-runtime-backend
   *  acceptResult(key,null)); hasSliceInCatalog reports those as cached
   *  (slot.size>0) so path-3 would force them into queued-with-fallback
   *  and never reach drop-empty. This predicate lets path-3 ignore the
   *  empty placeholder. Defaults to hasSliceInCatalog when omitted —
   *  multi-layer sources never store an empty placeholder under a named
   *  slice, so their behavior is unchanged (back-compat). */
  hasNonEmptySliceInCatalog?: (key: number) => boolean
  /** True iff ANY slice for `key` is in the CPU catalog (regardless of
   *  this layer). Used to detect "tile loaded but this layer empty". */
  hasAnySliceInCatalog: (key: number) => boolean
  /** True iff `key` exists in the source's archive index. */
  hasEntryInIndex: (key: number) => boolean
  sliceLayer: string
  /** True iff some slice for `visibleKey` is still in the renderer's
   *  deferred-upload queue. When set, even if THIS layer's slice is
   *  already on the GPU we treat the tile as not-yet-ready and route
   *  through the parent-walk path — keeps zoom levels coherent across
   *  every layer consuming the same source. Without it, the upload
   *  cap (`MAX_UPLOADS_PER_FRAME` 4 desktop / 1 mobile) splits a
   *  tile's per-MVT-layer slices across multiple frames, so a sliver
   *  of layers sit on `primary` (z=N) while their peers walk back to
   *  `parent-fallback` (z=N-1) — same screen position, two zoom
   *  levels rendering simultaneously. Default false (back-compat). */
  hasOtherSliceHeld?: boolean
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
  // Default the non-empty predicate to hasSliceInCatalog (back-compat:
  // multi-layer sources never store an empty placeholder under a named
  // slice, so the two predicates coincide there).
  const hasNonEmptySliceInCatalog = input.hasNonEmptySliceInCatalog ?? hasSliceInCatalog
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
  //    the frozen singleton to skip an allocation. The
  //    `hasOtherSliceHeld` guard suppresses primary when ANY slice
  //    for this tile is still held in the renderer's deferred-upload
  //    queue — see the field doc on ClassifyTileInputs.
  if (layerCache.has(visibleKey) && !input.hasOtherSliceHeld) return PRIMARY_DECISION

  // Coherence override — visible slice is on GPU but a peer slice
  // for the same tile is still queued. Skip the
  // `queued-with-fallback` path below (which would re-fire an
  // upload we don't need) and go straight to parent-walk so this
  // layer stretches alongside its peers until the held queue
  // drains.
  if (input.hasOtherSliceHeld && layerCache.has(visibleKey)) {
    return classifyFallback(input)
  }

  // 3. THIS LAYER's slice in catalog → upload + walk for fallback.
  //    (Bug class commit-49d4801: walking the parent here is critical
  //    so the area is filled while uploadTile is queued behind the
  //    per-frame budget.)
  //    An EMPTY placeholder (single-layer GeoJSON default '' slice,
  //    geojson-runtime-backend acceptResult(key,null)) reports as
  //    cached via hasSliceInCatalog but carries no geometry — uploading
  //    it is a no-op and would block the drop-empty branch below. Gate
  //    path-3 on the non-empty predicate so an empty placeholder falls
  //    through to the drop-empty / fallback logic instead.
  const thisSliceCached = hasNonEmptySliceInCatalog(visibleKey)
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
  //
  //    iter-284 — Prefer ancestor / child fallback over silent drop
  //    when an ancestor's slice IS cached. User-reported (OFM Bright
  //    z=0-5): blue ocean missing because PMTiles MVT at S. Atlantic
  //    z=2 tile decoded WITH landcover features but ZERO water
  //    features (real archive data — some ocean tiles carry only
  //    boundary/coastline geometry, not full water polygon). Without
  //    this guard, every such tile silently drops water even when the
  //    z=1 or z=0 ancestor has the proper water polygon clipped to
  //    its bounds — visible regression as missing ocean.
  //
  //    classifyFallback's parent-fallback / child-fallback paths
  //    only fire when `hasSliceInCatalog(ancestor)=true` — i.e. the
  //    other tile actually carries water in catalog. If no ancestor
  //    has the slice either, classifyFallback returns 'pending' /
  //    'drop-no-archive', and we fall through to DROP_EMPTY. So this
  //    branch never refetches the visible tile unnecessarily — the
  //    catalog's per-key dedupe (`hasTileData(visibleKey)=true`
  //    because landcover slice is present) blocks repeat loadTile.
  //    Single-layer GeoJSON (sliceLayer='') reaches this branch too:
  //    its visible slice is present in catalog but empty (the
  //    placeholder filtered out of path-3 above), so
  //    thisSlicePresentButEmpty captures the default-slice empty tile
  //    that the `sliceLayer && hasAnySliceInCatalog` multi-layer guard
  //    would otherwise skip.
  const thisSlicePresentButEmpty = hasSliceInCatalog(visibleKey) && !hasNonEmptySliceInCatalog(visibleKey)
  if (tileZ <= maxLevel && (thisSlicePresentButEmpty || (sliceLayer && hasAnySliceInCatalog(visibleKey)))) {
    const fb = classifyFallback(input)
    if (fb.kind === 'parent-fallback' || fb.kind === 'child-fallback') {
      return fb
    }
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
    hasSliceInCatalog, hasAnySliceInCatalog, hasEntryInIndex } = input
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
    // Identify the next-deeper fetch frontier so the algorithm
    // advances beyond `cachedAncestorKey`. Without this push, once
    // any ancestor lands in catalog the parent-fallback short-
    // circuits classifyFallback BEFORE the pending walk runs — and
    // the visible-z tile is never requested. Symptom: desktop
    // DPR=1 osm_style at zoom=16 over Manhattan stays at z=13
    // forever because z=14/15 fetches are never triggered.
    //
    // Strategy: prefer the visible-z if in archive; otherwise walk
    // (cachedAncestor+1 .. visible-1) for the shallowest unloaded
    // indexed key. Mirrors the original pending-path intent
    // (line 265-276 comment in this file: "Once it lands, the
    // next frame's parent-walk renders it as fallback while the
    // next-deeper level becomes the new pending").
    let wantsRequestKey: number | null = null
    if (!hasSliceInCatalog(visibleKey) && hasEntryInIndex(visibleKey)) {
      wantsRequestKey = visibleKey
    }
    return {
      kind: 'parent-fallback',
      parentKey: cachedAncestorKey,
      parentNeedsUpload: !layerCache.has(cachedAncestorKey),
      wantsRequestKey,
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

  // Pending: Cesium-style replace refinement — request the SHALLOWEST
  // ancestor in the archive index that is not yet in catalog, never
  // request a child until its parent has loaded. Walk root → visible:
  // the first key that is `hasEntryInIndex && !hasAnySliceInCatalog`
  // is the next fetch frontier. Once it lands, the next frame's
  // parent-walk renders it as fallback while the next-deeper level
  // becomes the new pending — guarantees the per-frame fallback walk
  // always finds something to render after at most z round-trips
  // (worst case cold-start). Without this rule, a cold-start at z=N
  // fires N requests for visible-z tiles in parallel and the screen
  // is empty for the entire fetch latency window because no parent
  // exists to magnify as fallback (user-visible "white tiles" symptom).
  const chain: number[] = []
  {
    let walk = visibleKey
    while (true) {
      chain.push(walk)
      if (walk <= 1) break
      walk = tileKeyParent(walk)
    }
    chain.reverse()  // root → visible
  }
  let requestKey: number | null = null
  for (const k of chain) {
    if (hasAnySliceInCatalog(k)) continue   // already loaded; deeper level is the next frontier
    if (!hasEntryInIndex(k)) continue        // this z not in archive (below sourceMinzoom etc.)
    requestKey = k
    break
  }
  // Fallback to the legacy choice if the walk found nothing indexed
  // (defensive: archiveAncestor>=0 implies the loop should have hit it).
  if (requestKey === null) {
    requestKey = hasEntryInIndex(visibleKey) ? visibleKey : (archiveAncestor >= 0 ? archiveAncestor : null)
  }
  return { kind: 'pending', requestKey }
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

/** Tier-2 zoom-direction prefetch tile-key set.
 *
 *  When the camera is mid-zoom toward an integer boundary, this builds
 *  the *next* LOD's visible tile keys so the caller can request them in
 *  the background (GPU-resident before `currentZ` advances). Direction
 *  is mutually exclusive per instant:
 *    * Zoom-in:   cameraZoom > currentZ + 0.5 → prefetch z=currentZ+1
 *    * Zoom-out:  cameraZoom < currentZ       → prefetch z=currentZ-1
 *  Returns `[]` when neither fires (stable zoom / clamped at the LOD
 *  range ends) or when no candidate tile is uncached.
 *
 *  Mirrors the main selector's routing so the prefetch set matches what
 *  the render path will ask for: centre-relative projections (azimuthal
 *  family, oblique, globe) route through `globeVisibleTiles`; the
 *  cylindrical ones use the projection-aware flat frustum selectors
 *  (sampled below pitch 30, exact at/above). `isCached` is the caller's
 *  slice-cache predicate (already-loading keys are KEPT in the set so
 *  the catalog's prefetch shield survives across rounds — the caller's
 *  predicate decides what counts as cached).
 *
 *  Pure: testable in isolation. The caller is responsible for the
 *  `TileCatalog.prefetchTiles` side effect and the per-frame throttle.
 *
 *  `camera` is the LIVE Camera instance — the flat frustum selectors
 *  call its `getRTCMatrix` / `unprojectToZ0` methods and read matrix /
 *  cap state beyond the scalar snapshot, so it is passed straight
 *  through (byte-identical to the inline render() block). The scalar
 *  `cameraZoom` / `centerX` / `centerY` / `pitch` / `bearing` /
 *  `projType` / `globeMode` fields drive the direction thresholds, the
 *  routing decision, and the `globeVisibleTiles` lon/lat path. */
export function computeZoomDirectionPrefetchKeys(input: {
  camera: Camera
  cameraZoom: number
  currentZ: number
  maxSubTileZ: number
  projType: number
  globeMode: boolean
  centerX: number
  centerY: number
  pitch: number
  bearing: number
  canvasWidth: number
  canvasHeight: number
  dpr: number
  selectorProj: Projection
  offsetMarginPx: number
  isCached: (k: number) => boolean
}): number[] {
  const {
    camera, cameraZoom, currentZ, maxSubTileZ, projType, globeMode,
    centerX, centerY, pitch, bearing,
    canvasWidth, canvasHeight, dpr, selectorProj, offsetMarginPx, isCached,
  } = input
  let prefetchZ = -1
  if (cameraZoom > currentZ + 0.5 && currentZ + 1 <= maxSubTileZ) {
    prefetchZ = currentZ + 1
  } else if (cameraZoom < currentZ && currentZ - 1 >= 0) {
    prefetchZ = currentZ - 1
  }
  if (prefetchZ < 0) return []
  // Mirror the main selector's routing so the prefetch tile set matches
  // what the render path will ask for: the centre-relative projections
  // (azimuthal family, oblique, globe) go through globeVisibleTiles; the
  // cylindrical ones use the projection-aware flat selectors. Otherwise
  // prefetch loads doomed-to-be-unused tiles into the GPU.
  const prefetchTiles = routeToSphereSelector(projType, globeMode)
    ? (() => {
        const R = 6378137
        const lonPF = centerX / R * (180 / Math.PI)
        // For sphere-family projections read the true centre latitude from
        // camera.centerLatDeg — it reaches the pole (±90°) past the Mercator
        // saturation limit of ±85.051129.  Mirrors the same fix in
        // tile-selection-cache.ts so prefetch and render stay in lockstep.
        const latPF = representsCenterAs(projType) === 'lat-deg'
          ? camera.centerLatDeg
          : mercatorYToLat(centerY)
        const cssWPF = canvasWidth / dpr
        const cssHPF = canvasHeight / dpr
        return globeVisibleTiles(
          lonPF, latPF, cameraZoom, prefetchZ, cssWPF, cssHPF,
          pitch, bearing,
        ).map(t => makeTileCoord(t.z, t.x, t.y, 0))
      })()
    : pitch < 30
    ? visibleTilesFrustumSampled(
        camera, selectorProj, prefetchZ,
        canvasWidth, canvasHeight, offsetMarginPx, dpr,
      )
    : visibleTilesFrustum(
        camera, selectorProj, prefetchZ,
        canvasWidth, canvasHeight, offsetMarginPx, dpr,
      )
  const prefetchKeys: number[] = []
  for (const t of prefetchTiles) {
    const k = tileKey(t.z, t.x, t.y)
    // Skip already-loaded keys; KEEP already-loading ones in the
    // intent set so catalog's _prefetchKeys protection covers
    // them across cancelStale calls. catalog.requestTiles
    // dedupes loadingTiles internally, so passing duplicates is
    // free. Without the in-flight keys here, the second
    // prefetch round (6 frames later) would yield an empty
    // array → catalog's age-out clears the shield → next frame
    // aborts the still-in-flight prefetch.
    if (!isCached(k)) {
      prefetchKeys.push(k)
    }
  }
  return prefetchKeys
}
