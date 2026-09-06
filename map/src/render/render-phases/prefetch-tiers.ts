import type { VectorTileRenderer, RenderFrameState } from '../vector-tile-renderer'
import type { RenderArgs } from '../vector-tile-renderer-types'
import { computeZoomDirectionPrefetchKeys } from '../../tile-decision'
import { adaptiveFarLodBoost } from '@xgis/engine'

/** #2508 phase 9 — prefetch tiers: the adjacent tiles (idle only, every 10th
 *  frame — the memo is what makes that per frame rather than per slice,
 *  #2309) and the zoom-direction next LOD while the camera is mid-zoom
 *  (#2013 — deliberately not idle-gated). Consumes only. */
export function prefetchTiers(
  vtr: VectorTileRenderer,
  args: RenderArgs,
  ctx: RenderFrameState,
): void {
  // Prefetch adjacent + next zoom (every 10th frame, idle only).
  // While the camera is actively moving the prefetched edge tiles
  // are likely to be invalidated within ~100 ms of being fetched
  // — wasted bandwidth + GPU upload pressure on mobile.
  // #2309 — the memo is what makes "every 10th frame" true; a bare
  // modulo fires per SLICE, not per frame (see _prefetchMemoFrame).
  if (vtr._prefetchMemoFrame !== vtr.currentFrameId) {
    vtr._prefetchMemoFrame = vtr.currentFrameId
    vtr._adjacentPrefetchZooms.clear()
    vtr._zoomPrefetchZooms.clear()
  }
  if (
    ctx.cameraIdle &&
    vtr.currentFrameId % 10 === 0 &&
    !vtr._adjacentPrefetchZooms.has(ctx.currentZ)
  ) {
    vtr._adjacentPrefetchZooms.add(ctx.currentZ)
    ctx.source.prefetchAdjacent(ctx.tiles, ctx.currentZ)
  }

  // Tier 2: zoom-direction prefetch.
  //
  // When the user is mid-zoom toward an integer boundary, request
  // the *next* LOD's visible tiles in the background so they're
  // GPU-resident by the time `currentZ` actually advances. Without
  // this, the integer boundary still produces a brief
  // missed-tile spike + parent-fallback period — visible as a
  // detail "pop" on the user's screen even with floor-based
  // currentZ + hysteresis (Tier 1).
  //
  // Triggers (only one fires per frame, never both — direction is
  // mutually exclusive at any instant):
  //   * Zoom-in:   camera.zoom > currentZ + 0.5 → prefetch z=cz+1
  //   * Zoom-out:  camera.zoom < currentZ      → prefetch z=cz-1
  //                (cz - 0.3 is the hysteresis switch threshold,
  //                so once user crosses below cz, the prior LOD
  //                is what they're heading toward)
  //
  // Throttled to every 6 frames (~100 ms) to keep the selector walk
  // amortised — the prefetch doesn't need per-frame freshness because
  // the camera typically moves slowly relative to the rAF cadence.
  //
  // #2013 — deliberately NOT gated on cameraIdle (unlike prefetchAdjacent
  // above). The idle gate made this block unreachable in the exact case it
  // exists for: during an ACTIVE zoom the camera moves every frame, so
  // cameraIdle stayed false for the whole gesture and every integer
  // boundary was crossed with zero next-LOD tiles in flight — the
  // measured fallback fan-out + blank-tile window on zoom-out (osm_style
  // z17 pitch 75, missedTiles 8→20). The zoom-direction target is the set
  // the camera is provably heading toward (same centre, next LOD), so the
  // pan-invalidation rationale behind the adjacent-prefetch idle gate does
  // not apply; cost is bounded by the 6-frame throttle, the isCached
  // filter, and the fetch queue's own concurrency cap.
  // #2309 — that throttle is the modulo AND the per-frame memo. The
  // modulo alone admitted ~17.7 selector walks a frame at 0.81 ms each
  // — 14.4 ms of a 16.7 ms budget, measured mid-zoom on OFM Bright.
  if (vtr.currentFrameId % 6 === 0 && !vtr._zoomPrefetchZooms.has(ctx.currentZ)) {
    vtr._zoomPrefetchZooms.add(ctx.currentZ)
    // Tile-set math extracted to tile-decision.computeZoomDirectionPrefetchKeys
    // (pure, unit-tested). Guard + prefetchTiles side-effect stay inline so
    // execution order/throttle is byte-identical to the prior inline block.
    const prefetchKeys = computeZoomDirectionPrefetchKeys({
      camera: args.camera,
      cameraZoom: args.camera.zoom,
      currentZ: ctx.currentZ,
      maxSubTileZ: ctx.maxSubTileZ,
      projType: args.projType,
      globeMode: args.camera.globeMode,
      centerX: args.camera.centerX,
      centerY: args.camera.centerY,
      pitch: args.camera.pitch ?? 0,
      bearing: args.camera.bearing ?? 0,
      canvasWidth: args.canvasWidth,
      canvasHeight: args.canvasHeight,
      dpr: args.dpr,
      selectorProj: ctx.selectorProj,
      offsetMarginPx: ctx.offsetMarginPx,
      isCached: ctx.sliceCached,
      // #1393/#2013 — probe the same far-field notch the drawing selection
      // runs at, so the prefetch set matches the renderer's actual demand.
      farTargetBoost: adaptiveFarLodBoost(),
    })
    if (prefetchKeys.length > 0) {
      ctx.source.prefetchTiles(prefetchKeys)
    }
  }
}
