// ═══ TileSelectionCache — per-frame visible-tile selection + readiness ═══
//
// Extracted from VectorTileRenderer (Cluster E-selection per
// .omc/plans/vtr-decomposition-2026-06-09.md Unit 1). This owner holds
// the per-frame visible-tile memo (`_frameTileCache`), the cross-frame
// zoom-transition hysteresis + readiness-gate state, the camera-idle
// snapshot, and the selection-only hot-path scratch collections. It
// touches ZERO GPU state — its only outputs are tile-set membership +
// the derived ancestor/world-offset arrays — which caps the blast radius
// to "wrong tile set" (visible, debuggable) rather than silent raster
// corruption.
//
// VTR injects it as `private readonly _selection = new TileSelectionCache()`
// and calls `selectForFrame(...)` once per render() (per ShowCommand). The
// returned Selection is consumed by the draw portion of render(); the
// memoized `_frameTileCache` is also read by `pumpPrefetch` + the label
// forwarders via `frameTileCache()`.
//
// The hysteresis (`_hysteresisZ` / `_czPendingAdvance`) + readiness-gate
// (`_gateSSECache` / `_gateSSECacheFrameId`) logic and the scratch
// `.clear()`-and-reuse pattern are moved VERBATIM — same branches, same
// thresholds, same order — per the plan's DO-NOT-SPLIT risk ledger
// (§5 items 2 + 6). `merc-high-pitch-drag-perf.test.ts` is the scratch
// guard; `_zoom-transition-*.spec.ts` are the hysteresis/readiness guards.

import { Camera } from '@xgis/engine'
import {
  visibleTilesFrustum, visibleTilesFrustumSampled, sortByPriority, makeTileCoord,
} from '../../data/tile-select'
import { visibleTilesSSE } from '../../loader/tiles-sse'
import { globeVisibleTiles } from '@xgis/engine'
import { tileKey, tileKeyParent } from '@xgis/compiler'
import { enumerateWorldCopies, routeToSphereSelector } from '@xgis/engine'
import {
  mercator as mercatorProj, getProjection, type Projection, mercatorYToLat,
} from '@xgis/engine'
import { SELECTOR_PROJ_NAMES, promotesToGlobeWhenTilted, representsCenterAs } from '@xgis/engine'
import type { TileCatalog } from '../../data/tile-catalog'
import type { FrameDrawStats } from './frame-draw-stats'

/** Cache of `visibleTilesFrustum()` + the derived neededKeys /
 *  worldOffsets arrays. With one source feeding N layer
 *  ShowCommands, each VTR.render() invocation would otherwise
 *  re-compute the same tile selection N times — the camera and
 *  canvas can't change between renders within a frame. Profiling
 *  showed pmtiles_layered (4 layers) burning ~30 ms / frame on
 *  redundant frustum walks. Cache keyed by frameId + culling
 *  margin (different stroke widths produce slightly different
 *  margins; a hit requires both to match). */
export interface FrameTileCache {
  frameId: number
  marginPx: number
  currentZ: number
  tiles: ReturnType<typeof visibleTilesFrustum>
  neededKeys: number[]
  /** Tile keys flagged `fallbackOnly` by the selector — protected
   *  from eviction (folded into stableKeys) but never rendered
   *  as primaries. Empty when the selector emits no fallback-only
   *  inject (e.g. low-pitch / sampled selector). */
  protectedAncestors: number[]
  worldOffDeg: number[]
  /** Source's `maxLevel` at the time the cache was populated.
   *  parentAtMaxLevel + archiveAncestor are computed against this
   *  level — if the source's archive depth changes between renders
   *  within a frame (rare but possible during initial load), the
   *  cache invalidates. */
  maxLevel: number
  /** For each tile i: when `tiles[i].z > maxLevel`, the maxLevel
   *  ancestor key (the over-zoom fallback parent). Else `-1`.
   *  Sliced layer-independent — depends only on tile coord +
   *  source maxLevel, so all 4 ShowCommands sharing this source
   *  read the same value. Eliminates the per-render
   *  `for (pz>maxLevel) parentKey = tileKeyParent(parentKey)`
   *  walk that dominated the per-tile loop at over-zoom. */
  parentAtMaxLevel: number[]
  /** For each tile i: the highest indexed ancestor (closest to
   *  the tile) found via `hasEntryInIndex` walk. `-1` if no
   *  ancestor is in the index. Sliced layer-independent —
   *  `hasEntryInIndex` is a property of the source index, not
   *  any layer's GPU/data cache. Replaces three quarters of the
   *  in-archive per-tile walk (`hasAnyAncestor` + `closestExisting`
   *  derived from this; only `cachedAncestorKey` still needs a
   *  per-layer `sliceCached` walk). */
  archiveAncestor: number[]
}

/** What `selectForFrame` returns to the render coordinator. Mirrors the
 *  produced-downstream set the selection block fed into the rest of
 *  render(): the visible tiles + derived ancestor/world-offset arrays,
 *  the resolved integer LOD, the frame's source maxLevel, and the
 *  camera-idle flag the Tier-2 prefetch gate reads further down. */
export interface Selection {
  tiles: ReturnType<typeof visibleTilesFrustum>
  neededKeys: number[]
  protectedAncestors: number[]
  worldOffDeg: number[]
  parentAtMaxLevel: number[]
  archiveAncestor: number[]
  currentZ: number
  maxLevel: number
  /** Camera-idle (no movement for IDLE_GRACE_MS) — read by the
   *  Tier-1/Tier-2 speculative prefetch gates in render(). */
  cameraIdle: boolean
}

export class TileSelectionCache {
  /** Hysteresis state for currentZ: persists across frames so the
   *  integer LOD doesn't oscillate when fractional zoom hovers near
   *  an integer boundary (pinch zoom can wiggle within ±0.05). See
   *  the currentZ derivation in selectForFrame for the threshold logic. */
  private _hysteresisZ = -1
  /** Pending cz advance — populated when the camera crosses a
   *  zoom-transition threshold but the target LOD's tiles aren't
   *  yet cached. The render keeps drawing at the OLD cz (so the
   *  user sees the previous LOD over-zoomed instead of blank tiles)
   *  until either every visible tile at `target` is cached OR
   *  `READINESS_TIMEOUT_MS` elapses. Cleared on advance + on any
   *  frame the threshold is no longer crossed. */
  private _czPendingAdvance: { target: number, since: number } | null = null
  /** Camera idle detection — prefetch is suppressed while the
   *  camera is actively moving (pinch zoom, pan) to keep mobile
   *  GPU + bandwidth budget on visible-only work. The moment the
   *  camera stops changing, the suppression times out and Tier 2
   *  + adjacent prefetch resume. User report: rapid pinch zoom-out
   *  + pan caused thermal throttling and forced refreshes; the
   *  GPU upload churn from prefetch on every frame was a major
   *  contributor on top of the visible-tile work. */
  private _lastCamSnap: { zoom: number; cx: number; cy: number; t: number } | null = null
  private _lastCamMoveAt = 0

  /** iter-254 (Plan AAA A.2) — per-frame scratch arrays for
   *  parentAtMaxLevel + archiveAncestor + ancestorMemo. These were
   *  allocated fresh on every render() call (`new Array(tiles.length)`
   *  + `new Map()`). At 60 fps with multiple shows per source =
   *  30+ allocations per second per VTR. Hoisted to scratch + reset
   *  via `.length = N` (Array) or `.clear()` (Map). V8 retains
   *  backing storage across resets. */
  private readonly _scratchParentAtMaxLevel: number[] = []
  private readonly _scratchArchiveAncestor: number[] = []
  private readonly _scratchAncestorMemo = new Map<number, boolean>()

  private _frameTileCache: FrameTileCache | null = null

  /** Frame-scoped memo for the zoom-transition readiness gate's SSE
   *  pass. When a transition is "wanted", the gate runs
   *  `visibleTilesSSE(camera, selectorProj, step, …)` once per
   *  ShowCommand to count cached-vs-total tiles at the step LOD.
   *  The selection is sourceLayer-INDEPENDENT — its only per-show
   *  inputs are `step` (the LOD being probed) and `marginPx` (stroke-
   *  derived cull margin); everything else (camera, canvas, dpr,
   *  projection) is frame-constant, captured by `frameId`. A
   *  Bright/Liberty style with ~13 shows sharing one source therefore
   *  re-ran an identical SSE walk up to 13× per frame during zoom.
   *
   *  Key = `step * 4096 + marginPx`, scoped by `frameId`. Distinct
   *  `step` values across a multi-LOD step-advance within one frame
   *  get distinct entries (correct — they probe different LODs);
   *  distinct stroke margins likewise. Cleared each frame so a camera
   *  / canvas change (which bumps `frameId`) invalidates every entry,
   *  keeping pan/zoom tile updates correct. */
  private readonly _gateSSECache = new Map<number, ReturnType<typeof visibleTilesSSE>>()
  private _gateSSECacheFrameId = -1

  /** The current frame's memoized tile selection, or null before the
   *  first render() of the frame populated it. Read by VTR's
   *  pumpPrefetch (visible-tile signal source) + the label forwarders
   *  (`?.neededKeys`). */
  frameTileCache(): FrameTileCache | null {
    return this._frameTileCache
  }

  /** Drop the per-frame memo. Called by VTR.beginFrame — the cache
   *  invalidates on each new frame via the frameId comparison in
   *  selectForFrame; explicit null isn't strictly needed, but
   *  releasing the GC reference here lets the previous frame's tile
   *  array drop sooner if the ShowCommand list shrinks (e.g. layer
   *  toggle). */
  invalidateFrame(): void {
    this._frameTileCache = null
  }

  /** Given camera + canvas + frameId, return the protected/needed/
   *  world-offset tile selection for this frame, memoized. Returns
   *  null when this layer's currentZ falls below the slice's minzoom
   *  — the caller skips the render() for that ShowCommand. The
   *  resolved hysteresis state (`_hysteresisZ`) is written even on the
   *  null (skip) path, matching the original inline ordering.
   *
   *  `drawStats` carries the iter-142 globeVisibleTiles-count
   *  diagnostic side-effect (set only on the globe branch, exactly as
   *  the inline block did). */
  selectForFrame(
    camera: Camera,
    projType: number,
    projCenterLon: number,
    projCenterLat: number,
    canvasWidth: number,
    canvasHeight: number,
    dpr: number,
    frameId: number,
    source: TileCatalog,
    sliceLayer: string,
    offsetMarginPx: number,
    maxLevel: number,
    drawStats: FrameDrawStats,
  ): Selection | null {
    const { centerX, centerY } = camera
    const R = 6378137
    const centerLon = (centerX / R) * (180 / Math.PI)
    const centerLat = mercatorYToLat(centerY)

    // DSFUN precision lets sub-tiles work at any camera zoom. Clamp to 22
    // to match the camera's universal maxZoom, not the old maxLevel+6.
    const maxSubTileZ = 22

    // Projection-aware tile selection: the flat selectors project tile
    // corners through THIS projection's forward (relative to the projected
    // centre), matching the GPU vertex path, so equirect / natural_earth
    // select the right tiles at the poles + dateline (previously they used
    // Mercator's forward and went blank at high latitude — user report
    // project_projection_issues_2026_05_18 #4). Built with the same centre
    // (projCenterLon/Lat) the GPU uses as proj_params.y/z. The azimuthal
    // family (3/4/5), oblique (6) and globe (7) sphere-route, so their
    // selectorProj is unused — fall back to mercatorProj (globe has no
    // flat-projection entry in the registry).
    const selectorProj: Projection = (projType >= 1 && projType <= 6)
      ? getProjection(SELECTOR_PROJ_NAMES[projType]!, projCenterLon, projCenterLat)
      : mercatorProj

    // Round-based currentZ with anti-oscillation hysteresis. Diagnosis:
    // pinch-zoom input on iOS Safari delivers fractional camera.zoom
    // updates that wiggle within ±0.05 around the integer-half
    // boundary (e.g., 4.49 ↔ 4.51), and `Math.round` flips currentZ
    // 4 ↔ 5 each frame — forcing a wholesale tile-set swap that
    // the user perceives as flicker.
    //
    // Hysteresis: the LOD switch threshold is offset by ±HYST_MARGIN
    // from the half-integer, so once zoom crosses 4.5 going up,
    // currentZ stays 5 until zoom drops below 4.4 (asymmetric on the
    // way back). Sub-frame jitter within the dead zone leaves
    // currentZ alone.
    //
    // We deliberately keep `Math.round` semantics (not floor) so the
    // user sees the higher-detail LOD as soon as zoom is closer to
    // it than to the lower one. Floor would magnify the lower LOD
    // until the integer boundary, visibly losing detail at fractional
    // zooms (verified against the smoke-test bucket_order baseline,
    // which renders at zoom 0.75 — floor would drop currentZ to 0,
    // losing the country-boundary detail z=1 carries).
    // Camera-idle detection. Tier 2 + adjacent prefetch are
    // suppressed for IDLE_GRACE_MS after the last detected camera
    // movement so rapid pinch / pan doesn't drown mobile GPU + net
    // budget in speculative LOD/edge fetches that the user is
    // about to invalidate anyway. 200 ms catches the gesture's
    // settle moment without delaying prefetch on a deliberate
    // pause. Movement threshold: > 0.005 zoom or > 1 m centre
    // delta — well above floating-point noise, well below any
    // visible navigation step.
    const IDLE_GRACE_MS = 200
    const nowCam = performance.now()
    if (this._lastCamSnap) {
      const dz = Math.abs(camera.zoom - this._lastCamSnap.zoom)
      const dx = Math.abs(camera.centerX - this._lastCamSnap.cx)
      const dy = Math.abs(camera.centerY - this._lastCamSnap.cy)
      if (dz > 0.005 || dx > 1 || dy > 1) {
        this._lastCamMoveAt = nowCam
      }
    }
    this._lastCamSnap = { zoom: camera.zoom, cx: camera.centerX, cy: camera.centerY, t: nowCam }
    const cameraIdle = nowCam - this._lastCamMoveAt > IDLE_GRACE_MS

    // Was 0.1 — added originally to suppress iOS-Safari pinch-zoom
    // jitter at the integer-half boundary (camera.zoom oscillates
    // 4.49 ↔ 4.51 producing a 4 ↔ 5 cz flip every frame). User
    // 2026-05-12 review: MapLibre advances tile-zoom at the exact
    // round boundary (z=4.5 → tile-z=5) so X-GIS at z=4.6 was still
    // serving the lower-z tile while MapLibre had already switched.
    // Match the reference: zero margin = pure Math.round semantics.
    // The jitter case is now handled by IDLE_GRACE_MS suppression
    // of speculative fetches during active gestures — actually
    // selecting the right cz still matters for what gets rendered.
    const HYST_MARGIN = 0
    // Readiness-gate timeout: once a transition is "wanted" (camera
    // has crossed the hysteresis threshold), we hold the OLD cz —
    // so the user keeps seeing the previous LOD over-zoomed — until
    // every visible tile at the new LOD is cached. That prevents
    // blank-canvas flashes during fast zoom moves. The timeout is
    // a safety net for hung networks / unbounded archives: after
    // 5 s of holding, advance anyway so the user isn't stuck on a
    // permanently-stale LOD if the upstream is broken.
    const READINESS_TIMEOUT_MS = 5_000
    const z = camera.zoom
    let cz: number
    if (this._hysteresisZ < 0) {
      // MapLibre vector-source LOD: tile zoom = floor(camera zoom).
      // The earlier 2026-05-12 attempt to "load next tile earlier"
      // shipped floor(z + 0.7), which actually loads ONE LOD DEEPER
      // than ML at every fractional zoom (z=4.96 → z=5 vs ML's z=4).
      // Diagnosis 2026-05-15: forest-polygon over-exposure and
      // label-density drift on Liberty Korea z=4.96 trace to that
      // off-by-one. Reverted to plain floor for vector parity.
      cz = Math.floor(z)
      this._czPendingAdvance = null
    } else if (Math.abs(Math.floor(z) - this._hysteresisZ) > 4) {
      // Bulk camera move (URL hash, programmatic camera reset,
      // jumpTo). The gate is designed for incremental user-driven
      // transitions; for jumps spanning more than ~4 LODs we'd
      // otherwise spend ~1 s per LOD climbing step-by-step, which
      // looks broken. Snap straight to target and let the normal
      // visible-tile pipeline + parent walk render whatever
      // ancestors happen to be cached on the way.
      cz = Math.floor(z)
      this._czPendingAdvance = null
    } else {
      cz = this._hysteresisZ
      const target = Math.floor(z)
      let wantAdvance = false
      // Match MapLibre's floor(z) promotion: advance the tile LOD
      // when the camera crosses the integer boundary. The earlier
      // z+0.3 threshold paired with the +0.7 selector — both
      // produced the off-by-one over-detail. Zoom-out hysteresis
      // (z < cz - 0.4) keeps the prior LOD alive briefly to avoid
      // flicker when crossing back below an integer.
      const zoomingIn = target > cz && z >= cz + 1 + HYST_MARGIN
      const zoomingOut = target < cz && z < cz - 0.4 + HYST_MARGIN
      if (zoomingIn) wantAdvance = true
      else if (zoomingOut) {
        // Zoom-out: do NOT gate. Holding cz at the higher LOD while
        // the camera shows a lower zoom forces visibleTilesFrustum
        // to enumerate hundreds of small tiles to cover the now-
        // much-larger viewport — measured 140 → 92 tilesVisible
        // peak in _mobile-zoom-out-load.spec.ts (35 % drop). User
        // reported severe heat + forced page refresh on mobile; the
        // tile fan-out is the underlying GPU/CPU stressor. The
        // reason gating helped in the zoom-IN direction was that
        // one parent tile covers the whole viewport over-zoomed,
        // producing 1-30 visible tiles. Zoom-out has no such
        // symmetry: a parent tile does NOT compose from cached
        // children in our render pipeline, so holding the child cz
        // means rendering children-of-children until the parent
        // fetches. Just advance; the parent walk magnifies the
        // nearest cached ancestor (or fetches if needed) — same
        // mechanism the renderer uses for any cache miss.
        cz = target
        this._czPendingAdvance = null
      }

      // Per-layer minzoom skip: layers like protomaps `roads` (z≥6)
      // and `buildings` (z≥14) carry no features below their minzoom.
      // When the gate's step LOD is below that floor, no fetch will
      // ever satisfy `hasTileData(k, sliceLayer)` and the gate would
      // stall forever. Treat below-minzoom steps as already ready —
      // catalog has nothing to wait on.
      const layerRange = sliceLayer
        ? source.getLayerZoomRange?.(sliceLayer)
        : null
      if (wantAdvance) {
        const now = performance.now()
        // Step-by-step advance: never jump cz multiple LODs in one
        // frame. The gate examines readiness of cz±1 (one step
        // toward target) and advances only that one LOD; on the
        // next frame, cz±1 → cz±2 if the next step is ready, and
        // so on. Two reasons we don't jump straight to target:
        //   1. Multi-LOD jumps (URL hash sets zoom=16 from initial
        //      camera at zoom=1) would force the gate to wait for
        //      z=16 cached, but we only fetch what's at currentZ
        //      → cz=1 forever, fetching z=1 only. Stepping makes
        //      cz climb through LODs as each becomes ready.
        //   2. Single-step keeps the user's view transitioning
        //      smoothly (cz=13 → 14 → 15 → 16) instead of stalling
        //      at the old LOD until the final target is fully
        //      cached.
        const step = target > cz ? cz + 1 : cz - 1
        // Timer tracks the whole transition (target stays fixed
        // until camera.zoom rounds to a different integer). step
        // changes every time we advance one LOD, so resetting the
        // timer on step change would let us never time out — the
        // 4 sourceLayer renders per frame can each see slightly
        // different cz, churning step → since constantly reset. We
        // bind to `target` so the 5 s safety net actually applies
        // across the full transition.
        if (!this._czPendingAdvance || this._czPendingAdvance.target !== target) {
          this._czPendingAdvance = { target, since: now }
        }
        // Readiness check at the STEP LOD (cz±1), not target.
        // Below-minzoom step → instantly ready (no data exists to
        // wait on).
        const belowLayerMinzoom = !!(layerRange && step < layerRange.minzoom)
        const aboveLayerMaxzoom = !!(layerRange && step > layerRange.maxzoom)
        let total = 0, ready = 0
        let stepTiles: ReturnType<typeof visibleTilesFrustum> = []
        if (!belowLayerMinzoom && !aboveLayerMaxzoom) {
          // Readiness gate uses the SAME selector as the main render
          // path (SSE default since `1ab9ab0`). Falling back to the
          // old frustum / sampled selectors here would (a) duplicate
          // tile-selection cost — the user's profile flagged this as
          // 33 % of frame time during zoom transitions, classifyTile
          // + visit + toScreen all in `tiles.ts` — and (b) emit a
          // DIFFERENT tile set than the renderer asks for, so the
          // readiness check wouldn't actually predict the renderer's
          // demand. SSE is faster AND consistent.
          //
          // Frame-scoped memo: with one source feeding ~13 layer
          // ShowCommands, every show whose camera crosses an integer
          // zoom boundary re-ran this identical SSE walk. The selection
          // depends only on `step` (the probed LOD) and `offsetMarginPx`
          // (per-show stroke margin) — all other inputs (camera, canvas,
          // dpr, selectorProj) are frame-constant. Cache on those two,
          // scoped by `currentFrameId`; the per-show `total/ready` count
          // below is still recomputed (it reads the live catalog cache),
          // only the quadtree walk is shared. Cleared on frameId change
          // so a camera/canvas move re-selects (panning still updates).
          if (this._gateSSECacheFrameId !== frameId) {
            this._gateSSECache.clear()
            this._gateSSECacheFrameId = frameId
          }
          const gateKey = step * 4096 + offsetMarginPx
          const cachedStep = this._gateSSECache.get(gateKey)
          if (cachedStep !== undefined) {
            stepTiles = cachedStep
          } else {
            stepTiles = visibleTilesSSE(
              camera, selectorProj, step,
              canvasWidth, canvasHeight, offsetMarginPx, dpr,
            )
            this._gateSSECache.set(gateKey, stepTiles)
          }
          for (const t of stepTiles) {
            if (t.z !== step) continue
            total++
            // Catalog-level cache check (no sourceLayer arg) — any
            // layer slice cached counts as "tile fetched". Per-layer
            // check would stall forever on tiles where this layer
            // has no features (e.g. buildings slice absent in a
            // water-only z=14 cell), since the backend never emits
            // acceptResult for empty-feature layers.
            if (source.hasTileData(tileKey(t.z, t.x, t.y))) ready++
          }
        }
        const stepReady = belowLayerMinzoom || aboveLayerMaxzoom
          || total === 0 || ready === total
        const timedOut = now - this._czPendingAdvance.since > READINESS_TIMEOUT_MS

        if (stepReady || timedOut) {
          cz = step
          // Don't null out — next frame may want to step again
          // toward the still-distant target. The step-change branch
          // above will reset the timer for the new step.
          if (cz === target) this._czPendingAdvance = null
        } else {
          // Hold at the current cz, but kick off prefetch for the
          // step LOD so it can ready up. Tier 2 prefetch further
          // down does the same for cz+1 in zoom-in, but it's gated
          // on `camera.zoom > currentZ + 0.5` which is always
          // true here, so the two paths overlap harmlessly. We
          // still issue here directly because Tier 2 only fires
          // every 6 frames, while we want the prefetch to start
          // on the very first held frame.
          const stepKeys: number[] = []
          for (const t of stepTiles) {
            if (t.z !== step) continue
            stepKeys.push(tileKey(t.z, t.x, t.y))
          }
          if (stepKeys.length > 0) source.prefetchTiles(stepKeys)
        }
      } else {
        this._czPendingAdvance = null
      }
    }
    // Clamp cz at sourceMaxLevel BEFORE recording hysteresis or
    // deriving currentZ — otherwise the selector still requests
    // z > maxLevel tiles (via the `step` derivation at line 1357)
    // and we re-enter the over-zoom path we're trying to avoid.
    //
    // Beyond archive maxLevel, sub-tile generation recursively
    // clips parent geometry into virtual children — same data,
    // smaller tile rect. The rendered RESULT is visually identical
    // to drawing the parent directly because no new detail enters
    // from the archive past maxLevel.
    //
    // The user-reported Tokyo z=17.07 issue (osm_style, archive
    // maxLevel=15) reproduced as foreground rendered as oversized
    // ancestor blocks because the deep over-zoom chain
    // (z=17 → z=16 → z=15) was sub-tile-gen-throttled and most
    // tiles fell back two-three levels. iOS Safari additionally
    // failed to render the polygon fills altogether (likely a
    // TBDR / sub-tile-gen pipeline incompatibility, unverified
    // without device access). Capping at maxLevel sends the
    // selector requests directly to archive-loadable tiles —
    // foreground draws as primary z=maxLevel with no sub-tile-gen
    // path and no fallback chain.
    //
    // Cost: lose sub-tile-gen's coordinate-precision benefit at
    // extreme over-zoom. DSFUN precision in a z=15 tile-local
    // frame is ~mm at z=22 anyway (TILE_EXTENT / 2^7 ≈ 0.3 m / f32
    // mantissa bits remaining), well below visible pixel scale.
    // The win: foreground always draws actual archived geometry
    // instead of an artefact-prone clip pyramid.
    const sourceMaxLevel = source.maxLevel
    if (cz > sourceMaxLevel) cz = sourceMaxLevel
    this._hysteresisZ = cz
    const currentZ = Math.max(0, Math.min(maxSubTileZ, cz))

    // Per-MVT-layer minzoom culling — when the source publishes
    // metadata.vector_layers (PMTiles), each layer's `minzoom` is
    // a HARD bound below which the archive carries no features for
    // it (protomaps v4: roads z≥6, buildings z≥14). Skip render()
    // entirely below that threshold: no missed-tile bookkeeping,
    // no sub-tile gen, no fetches, no FLICKER chatter.
    //
    // `maxzoom` is intentionally NOT used as a cull bound — it's
    // a SOFT bound on raw archive data, but sub-tile generation
    // continues to upscale the maxzoom data for over-zoom views.
    // Culling on maxzoom would freeze rendering past z=15 on
    // protomaps v4 (every layer reports maxzoom=15), defeating the
    // whole over-zoom pipeline.
    if (sliceLayer) {
      const range = source.getLayerZoomRange?.(sliceLayer)
      if (range && currentZ < range.minzoom) {
        return null
      }
    }

    // Quadtree-based frustum selection works at every pitch, including 0.
    // The legacy AABB-based `visibleTiles` path silently drifted from the
    // VTR cache pipeline and broke at low pitch, so it is no longer used.
    //
    // (Culling margin + selectorProj hoisted above the hysteresis
    // block so the readiness gate can call visibleTilesFrustum at
    // the target LOD without duplicating the derivation. See those
    // definitions for the rationale on margin sizing + projection
    // shim.)
    // Frame-scoped cache: every layer render in the same frame
    // produces the same visible-tile set unless the culling margin
    // differs (per-layer stroke width). marginPx is part of the cache
    // key — typical demos have the same margin across layers (small
    // strokes) so all renders past the first hit. profiled: pmtiles_
    // layered (4 layers) used to spend ~30 ms / frame redundantly
    // walking visibleTilesFrustum + sortByPriority + tileKey loop.
    let tiles: ReturnType<typeof visibleTilesFrustum>
    let neededKeys: number[]
    let protectedAncestors: number[] = []
    let worldOffDeg: number[]
    let parentAtMaxLevel: number[]
    let archiveAncestor: number[]
    const cache = this._frameTileCache
    if (cache && cache.frameId === frameId
        && cache.marginPx === offsetMarginPx
        && cache.currentZ === currentZ
        && cache.maxLevel === maxLevel) {
      tiles = cache.tiles
      neededKeys = cache.neededKeys
      protectedAncestors = cache.protectedAncestors
      worldOffDeg = cache.worldOffDeg
      parentAtMaxLevel = cache.parentAtMaxLevel
      archiveAncestor = cache.archiveAncestor
    } else {
      // Phase 3 selector: Cesium-style screen-space-error DFS at every
      // pitch — supersedes the prior split (sampled-grid for low pitch,
      // quadtree-DFS for high pitch). SSE is projection-invariant by
      // construction (perceptual error metric), so a single algorithm
      // covers the full pitch range without the pitchMul kludge or the
      // 30° industry-split heuristic. A/B measured Bright at z=14 Tokyo:
      //
      //   pitch=  0°  frustum 15.5 ms / SSE  7.2 ms  (2.1× faster)
      //   pitch= 40°  frustum 25.4 ms / SSE  7.0 ms  (3.6×)
      //   pitch= 60°  frustum 67.0 ms / SSE 16.3 ms  (4.1×)
      //   pitch= 80°  frustum 66.6 ms / SSE 55.2 ms  (1.2×)
      //
      // SSE is now default. `__XGIS_USE_SSE_SELECTOR = false` rolls
      // back to the prior frustum + sampled pair as a safety hatch
      // (real-browser visual regression escape valve while Phase 3
      // bakes in usage).
      const _pitchDeg = camera.pitch ?? 0
      const sseDisabled = typeof window !== 'undefined'
        && (window as unknown as { __XGIS_USE_SSE_SELECTOR?: boolean }).__XGIS_USE_SSE_SELECTOR === false
      // Sphere-aware tile selection for the centre-relative projections.
      // Globe (projType 7, via globeMode), oblique_mercator (6) and the
      // azimuthal family (ortho=3, azimuthal=4, stereographic=5) all
      // project relative to the camera centre (clon,clat → 0,0), so the
      // flat selectors hand them the WRONG tile set once the camera pans
      // (user reports #4 / #6). They route through globeVisibleTiles,
      // which culls by sphere visibility and matches the catalog's
      // Mercator-pyramid tile IDs.
      //
      // The cylindrical projections (mercator=0, equirect=1,
      // natural_earth=2) do NOT sphere-route: the flat selectors are now
      // projection-aware (selectorProj carries the real forward/inverse),
      // so they select correctly at the poles AND cover both sides of the
      // dateline via world-copy enumeration — no hemisphere cull, which
      // would have dropped the back-of-sphere tiles a full-world flat
      // projection still displays.
      const projType = (camera as { projType?: number }).projType ?? 0
      if (routeToSphereSelector(projType, camera.globeMode)) {
        // Globe (projType 7): sphere-aware tile selection. The
        // mercator selectors below all reason about a flat viewport
        // and don't know about hemisphere culling or the antimeridian
        // wrap that globe needs. globeVisibleTiles walks the same
        // web-mercator pyramid (so tile IDs match the catalog the
        // downstream code expects) but culls by sphere visibility
        // and keeps tiles on BOTH sides of the dateline when the
        // camera faces the antimeridian.
        const R = 6378137
        const lon = camera.centerX / R * (180 / Math.PI)
        // Sphere family reads the true centre latitude (centerLatDeg reaches the
        // pole; mercatorYToLat(centerY) saturates at ±85.051, diverging from the
        // rendered sphere past that). Mirrors buildGlobeFrame/getECEFCenter.
        const lat = representsCenterAs(projType) === 'lat-deg' ? camera.centerLatDeg : mercatorYToLat(camera.centerY)
        const cssW = canvasWidth / dpr
        const cssH = canvasHeight / dpr
        // Disc projections (ortho/azi/stereo) fill the viewport even at low
        // camera zoom — the cap pins the whole hemisphere on screen across
        // camera zoom 0..~2.3 — so the raw camera zoom under-selects tile
        // detail: a screen-filling hemisphere drawn from a single coarse z0
        // tile shows straight-edge coastlines (headed: ortho z0 Australia).
        // Boost the SELECTION zoom toward the screen-space tile resolution
        // (a hemisphere spans ≈ half the world across cssW px → z ≈
        // log2(cssW/128)). Gated to the flat disc set + only when camera.zoom
        // is below that floor, so higher zoom is a strict no-op (camera.zoom
        // already exceeds it) and there is no high-zoom over-select
        // interaction. globe(7)/oblique(6)/cylindrical are unaffected.
        let selZoom = camera.zoom
        let selMaxZ = currentZ
        if (promotesToGlobeWhenTilted(projType)) {
          const discDetailFloor = Math.log2(Math.max(cssW, cssH) / 128)
          if (camera.zoom < discDetailFloor) {
            selZoom = discDetailFloor
            selMaxZ = Math.max(currentZ, Math.ceil(discDetailFloor))
          }
        }
        const globeTiles = globeVisibleTiles(
          lon, lat, selZoom, selMaxZ, cssW, cssH,
          camera.pitch ?? 0, camera.bearing ?? 0,
        )
        // iter 142 diagnostic: raw selection count BEFORE world-copy
        // fan-out / makeTileCoord, so the harness can split
        // selection-empty from selected-but-culled.
        drawStats.setGlobeTilesSelected(globeTiles.length)
        // GlobeTile (z/x/y/ox) matches the TileCoord shape exactly;
        // makeTileCoord wraps with the absolute-x contract.
        //
        // Iter 127: enumerate WORLD_COPIES for the cylindrical /
        // pseudocyl projections that route through globeVisibleTiles
        // (equirect / NE at antimeridian, oblique-merc always). For
        // ortho/azimuth/stereo + globe (single-disc / true sphere),
        // single-world is correct and ox stays = x.
        // World-copy enumeration for the periodic projections is
        // gated to low zoom — see enumerateWorldCopies (gpu-shared)
        // for the full rationale + iter history. Extracted to a pure
        // predicate so the iter-139 user-bug fix is unit-pinned.
        if (enumerateWorldCopies(projType, camera.zoom)) {
          tiles = []
          for (const wc of [-2, -1, 0, 1, 2]) {
            for (const t of globeTiles) {
              tiles.push(makeTileCoord(t.z, t.x, t.y, wc))
            }
          }
        } else {
          tiles = globeTiles.map(t => makeTileCoord(t.z, t.x, t.y, 0))
        }
      } else {
        tiles = !sseDisabled
          ? visibleTilesSSE(
              camera,
              selectorProj,
              currentZ,
              canvasWidth,
              canvasHeight,
              offsetMarginPx,
              dpr,
            )
          : _pitchDeg < 30
          ? visibleTilesFrustumSampled(
              camera,
              selectorProj,
              currentZ,
              canvasWidth,
              canvasHeight,
              offsetMarginPx,
              dpr,
            )
          : visibleTilesFrustum(
              camera,
              selectorProj,
              currentZ,
              canvasWidth,
              canvasHeight,
              offsetMarginPx,
              dpr,
            )
      }

      // Non-Mercator z=0 root-tile split. The z=0 root tile covers the
      // whole world in a single mercator tile; rings that physically
      // cross the antimeridian (Antarctica, Aleutians, ocean wrap
      // polygons) live INTACT inside it because no tile boundary cuts
      // them apart. The vertex shader's `project_geom` then projects
      // the edge between, say, vertex lon=+175 and vertex lon=-175
      // along the LONG way around the world — a ~340° smear that
      // sweeps across the entire equirect / natural_earth / oblique_
      // mercator viewport at low zoom. Mercator is unaffected because
      // its 5-world-copy enumeration draws the same ring at the
      // wrap-shifted position too, hiding the long edge.
      //
      // Fix: for any non-mercator projection, swap any z=0 root tile in
      // the selector output for its 4 z=1 children. The z=1 tile
      // boundary at lon=0 forces geojson-vt's clip stage to split AM-
      // crossing rings into two halves (one in tile x=0 / lon=-180..0,
      // one in tile x=1 / lon=0..180) — no single tile contains the
      // long edge any more and the smear disappears. Globe already
      // goes through `globeVisibleTiles` above (different branch).
      const projTypeForSplit = (camera as { projType?: number }).projType ?? 0
      if (projTypeForSplit !== 0 && projTypeForSplit !== 7 && !camera.globeMode) {
        // Iter 126: enumerate z=0 → 4 z=1 children PER WORLD COPY.
        // Pre-iter-126 dropped every z=0 entry and pushed 4 z=1 children
        // with hard-coded ox=0 — collapsed world-copy variants into the
        // primary world and made equirect / NE world-copy invisible.
        const withoutRoot: typeof tiles = []
        const worldCopiesWithRoot = new Set<number>()
        for (const t of tiles) {
          if (t.z === 0 && t.x === 0 && t.y === 0) {
            // ox - x for z=0 root = ox (since x = 0). Track per world.
            worldCopiesWithRoot.add(t.ox ?? 0)
            continue
          }
          withoutRoot.push(t)
        }
        for (const wc of worldCopiesWithRoot) {
          // makeTileCoord(z, wrappedX, y, worldCopy) computes
          // ox = wrappedX + worldCopy * 2^z. Pass wc directly as
          // worldCopy — NOT wc*2 (that doubled the offset and pushed
          // world+1 children into world+2 slots, which fell outside
          // the viewport and left only world 0 + world-1 rendering
          // visibly on a fresh wc-enabled run).
          withoutRoot.push(makeTileCoord(1, 0, 0, wc))
          withoutRoot.push(makeTileCoord(1, 0, 1, wc))
          withoutRoot.push(makeTileCoord(1, 1, 0, wc))
          withoutRoot.push(makeTileCoord(1, 1, 1, wc))
        }
        if (worldCopiesWithRoot.size > 0) tiles = withoutRoot
      }

      // Phase 2 selector-shape invariant — single-zoom emission was
      // an artefact of the Mapbox/MapLibre sampled-grid path and only
      // applied when that selector was active. Phase 3's SSE selector
      // emits mixed-LOD at every pitch by design, so the invariant
      // only fires on the sseDisabled fallback path.
      if (sseDisabled
          && (globalThis as { __XGIS_INVARIANTS?: boolean }).__XGIS_INVARIANTS
          && _pitchDeg < 30) {
        for (const t of tiles) {
          if (t.z !== currentZ) {
            throw new Error(
              `[XGIS INVARIANT] flat-pitch (${_pitchDeg.toFixed(1)}°) selector emitted `
              + `tile z=${t.z} expected currentZ=${currentZ}. The dispatch should be `
              + `routing to visibleTilesFrustumSampled which is single-zoom by design.`,
            )
          }
        }
      }
      const n = Math.pow(2, currentZ)
      const ctX = Math.floor((centerLon + 180) / 360 * n)
      const ctY = Math.floor((1 - Math.log(Math.tan(centerLat * Math.PI / 180) + 1 / Math.cos(centerLat * Math.PI / 180)) / Math.PI) / 2 * n)
      sortByPriority(tiles, ctX, ctY)
      // Build neededKeys + worldOffsets + sliceLayer-INDEPENDENT
      // ancestor lookups in one pass so the entire derived set
      // caches together. parentAtMaxLevel + archiveAncestor depend
      // only on (tile coord, source maxLevel, source index) — none
      // of which vary across same-frame ShowCommand renders, so all
      // 4 layers reuse the precomputed arrays. This is the
      // sliceLayer-independent half of the per-tile parent walk
      // hoisted out of the hot path.
      neededKeys = []
      worldOffDeg = []
      // `fallbackOnly: true` tiles from the selector (the high-pitch
      // parent inject in `visibleTilesFrustum`) exist solely to keep
      // the parent slice resident under eviction pressure — they MUST
      // NOT enter `neededKeys` or they'd be promoted to PRIMARY draws
      // (STENCIL_WRITE, compare='always') and overlap their own
      // children at the same screen pixels, blowing up triangle
      // counts. Strip them out into a separate `protectedAncestors`
      // list that the eviction policy folds into `stableKeys` later.
      protectedAncestors = []
      const renderTiles: typeof tiles = []
      for (const t of tiles) {
        if (t.fallbackOnly) {
          protectedAncestors.push(tileKey(t.z, t.x, t.y))
        } else {
          renderTiles.push(t)
        }
      }
      tiles = renderTiles
      // iter-254 — scratch reuse. `.length = N` truncates the JS
      // array; backing storage stays + future index writes reuse it.
      parentAtMaxLevel = this._scratchParentAtMaxLevel
      parentAtMaxLevel.length = tiles.length
      archiveAncestor = this._scratchArchiveAncestor
      archiveAncestor.length = tiles.length
      // Per-frame-populate hasEntry memo. Adjacent tiles share
      // ancestors so memoization keeps the index lookup count
      // sub-linear in tiles.length.
      const ancestorMemo = this._scratchAncestorMemo
      ancestorMemo.clear()
      const ancestorHasEntry = (k: number): boolean => {
        let v = ancestorMemo.get(k)
        if (v === undefined) {
          v = source.hasEntryInIndex(k)
          ancestorMemo.set(k, v)
        }
        return v
      }
      for (let i = 0; i < tiles.length; i++) {
        const tz = tiles[i].z
        const k = tileKey(tz, tiles[i].x, tiles[i].y)
        neededKeys.push(k)
        const ox = tiles[i].ox ?? tiles[i].x
        const tileN = Math.pow(2, tz)
        worldOffDeg.push((ox - tiles[i].x) * (360 / tileN))
        if (tz > maxLevel) {
          // Over-zoom: walk to maxLevel ancestor. Coordinate-only;
          // archive existence is checked per-layer via sliceCached.
          let pk = k
          for (let pz = tz; pz > maxLevel; pz--) pk = tileKeyParent(pk)
          parentAtMaxLevel[i] = pk
          archiveAncestor[i] = -1
        } else {
          parentAtMaxLevel[i] = -1
          // In-archive: walk parents until first hasEntry hit.
          // First hit is highest indexed ancestor (closestExisting).
          let pk = k
          let found = -1
          for (let pz = tz - 1; pz >= 0; pz--) {
            pk = tileKeyParent(pk)
            if (ancestorHasEntry(pk)) { found = pk; break }
          }
          archiveAncestor[i] = found
        }
      }
      this._frameTileCache = {
        frameId,
        marginPx: offsetMarginPx,
        currentZ,
        tiles, neededKeys, protectedAncestors, worldOffDeg,
        maxLevel,
        parentAtMaxLevel, archiveAncestor,
      }
    }

    return {
      tiles,
      neededKeys,
      protectedAncestors,
      worldOffDeg,
      parentAtMaxLevel,
      archiveAncestor,
      currentZ,
      maxLevel,
      cameraIdle,
    }
  }
}
