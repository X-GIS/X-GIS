import type { VectorTileRenderer, RenderFrameState } from '../vector-tile-renderer'
import type { RenderArgs } from '../vector-tile-renderer-types'

/** #2508 phase 10 — epilogue. Records this layer's stable tile set (needed +
 *  fallback + selector-protected ancestors: every key whose buffers a draw
 *  recorded this frame still binds, so the deferred eviction cannot destroy
 *  one before `queue.submit()`), then emits the tile-based points. Consumes
 *  only. */
export function trackStableSetAndPoints(
  vtr: VectorTileRenderer,
  args: RenderArgs,
  ctx: RenderFrameState,
): void {
  // Track stable tile set for eviction protection and point rendering.
  // IMPORTANT: include fallbackKeys too — those tiles' buffers are bound
  // in bind groups used by the draw calls we just recorded. Evicting them
  // now would destroy their buffers before `queue.submit()` runs, causing
  // "Buffer used in submit while destroyed" validation errors.
  if (ctx.fallbackKeys.length > 0 || ctx.protectedAncestors.length > 0) {
    const merged = vtr._scratchMergedStableKeys
    merged.clear()
    for (const k of ctx.neededKeys) merged.add(k)
    for (const k of ctx.fallbackKeys) merged.add(k)
    // Selector-injected fallback-only ancestors (currently the
    // high-pitch parent inject) — protected from eviction so they
    // stay resident and the eviction-driven foreground ancestor-
    // block regression doesn't reappear under the mobile cap.
    for (const k of ctx.protectedAncestors) merged.add(k)
    vtr.stableKeys = [...merged]
  } else {
    vtr.stableKeys = ctx.neededKeys
  }

  // GPU cache eviction is deferred to beginFrame() — see the comment there
  // for why mid-frame eviction races the bucket scheduler's multi-render-
  // per-frame pattern. Bounded by the per-frame upload budget meanwhile.

  // Tile-based points via PointRenderer (if available); the single-
  // authority body lives in emitTilePointsRhi (#1057), shared with the twin.
  vtr.emitTilePointsRhi(
    args.rhiPass,
    args.camera,
    args.projType,
    args.projCenterLon,
    args.projCenterLat,
    args.canvasWidth,
    args.canvasHeight,
    args.dpr,
    args.show,
    args.pointRenderer,
  )
}
