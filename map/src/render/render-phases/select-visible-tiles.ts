import type { VectorTileRenderer, GuardedFrame } from '../vector-tile-renderer'
import type { RenderArgs, LayerSlot, TileSelection } from '../vector-tile-renderer-types'
import type { Projection } from '@xgis/geo'
import { flatSelectorProjection } from '../flat-tile-selector'

/** #2508 phase 2 — select the visible tiles: the camera's view for this
 *  projection, the selector projection and frustum margins, then the cached
 *  selection (hysteresis-held drawn zoom, world copies, over-zoom parents,
 *  protected ancestors). Everything a later phase reads about "which tiles" is
 *  fixed here. Returns `null` when the selection cache has nothing for this
 *  layer (the source's data-zoom range excludes it) — `render()` stops there. */
export function selectVisibleTiles(
  vtr: VectorTileRenderer,
  args: RenderArgs,
  guard: GuardedFrame,
  slot: LayerSlot,
): TileSelection | null {
  // Promote pending uploads first — they're strictly older than anything
  // this frame's tile walk will queue, so servicing them now keeps the
  // "filling in" order correct (near-z-to-current first).
  vtr.drainPendingUploads()

  const maxLevel = guard.source.maxLevel
  // DSFUN precision lets sub-tiles work at any camera zoom. Clamp to 22
  // to match the camera's universal maxZoom, not the old maxLevel+6.
  // (Still used downstream by the Tier-2 prefetch gate below; the
  // selection method recomputes its own copy internally.)
  const maxSubTileZ = 22

  // Hoisted: visibleTilesFrustum inputs needed both by the selection
  // collaborator (passed into selectForFrame) and by the Tier-2
  // prefetch gate further down. Cheap pure derivations; safe to
  // compute once up here.
  const strokeOffsetPx_h = Math.abs(args.show.strokeOffset ?? 0)
  // Stroke width — zoom × time already collapsed by the bucket
  // scheduler. ResolvedShow is the SOLE per-frame source.
  const strokeWidthPx_h = args.resolvedShow.strokeWidth
  const alignDeltaPx_h =
    args.show.strokeAlign === 'inset' || args.show.strokeAlign === 'outset'
      ? strokeWidthPx_h / 2
      : 0
  const offsetMarginPx = Math.ceil(strokeOffsetPx_h + alignDeltaPx_h + strokeWidthPx_h / 2 + 2)
  // Projection-aware tile selection, through the ONE derivation
  // (flat-tile-selector.ts, which owns the prose for why).
  const selectorProj: Projection = flatSelectorProjection(
    args.projType,
    args.projCenterLon,
    args.projCenterLat,
  )

  // Per-frame visible-tile selection + zoom-transition hysteresis +
  // readiness gate. The selection collaborator owns the cross-frame
  // hysteresis/readiness state + the per-frame tile memo + the
  // selection scratch arrays; it touches ZERO GPU state. It returns
  // null when this layer's currentZ falls below the slice minzoom
  // (the per-MVT-layer cull that used to `return` inline here) —
  // skip the render() for this ShowCommand in that case.
  const sel = vtr._selection.selectForFrame(
    args.camera,
    args.projType,
    args.projCenterLon,
    args.projCenterLat,
    args.canvasWidth,
    args.canvasHeight,
    args.dpr,
    vtr.currentFrameId,
    guard.source,
    slot.sliceLayer,
    offsetMarginPx,
    maxLevel,
    vtr._drawStats,
  )
  if (!sel) return null
  const {
    tiles,
    neededKeys,
    protectedAncestors,
    worldOffDeg,
    parentAtMaxLevel,
    archiveAncestor,
    currentZ,
    targetZ,
    cameraIdle,
  } = sel

  if (currentZ !== vtr.lastZoom) vtr.lastZoom = currentZ
  vtr.currentCameraZoom = args.camera.zoom

  // Display-projection MVP: `getViewForProjection` returns the flat 2D
  // Mercator-plane MVP for flat Mercator (projType 0) and the ECEF-MVP
  // for 3D / globe (and, currently, every other projType). The polygon /
  // line VS branches on `proj_params.x` to consume the matching matrix
  // (flat → `project(abs)−cam` 2D-plane metres; 3D → ECEF-RTC). The
  // returned `matrix` reference is overwritten by the next call from the
  // same camera — copy into the uniform mirror immediately. Both paths
  // return the same far-plane in non-globe mode, so `logDepthFc` matches.
  const frame = args.camera.getViewForProjection(
    args.projType,
    args.canvasWidth,
    args.canvasHeight,
    args.dpr,
  )
  const mvp = frame.matrix
  vtr.logDepthFc = frame.logDepthFc
  return {
    mvp,
    frame,
    strokeWidthPx_h,
    tiles,
    neededKeys,
    maxLevel,
    parentAtMaxLevel,
    archiveAncestor,
    worldOffDeg,
    currentZ,
    targetZ,
    cameraIdle,
    maxSubTileZ,
    selectorProj,
    offsetMarginPx,
    protectedAncestors,
  }
}
