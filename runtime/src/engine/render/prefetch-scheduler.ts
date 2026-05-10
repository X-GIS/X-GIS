// Speculative tile prefetch scheduler — extracted from
// VectorTileRenderer to keep that class focused on tile selection +
// classification + GPU upload + draw, rather than the side-channel
// "what tile is the camera ABOUT to need" routes.
//
// Two prefetch routes, both feeding `TileCatalog.prefetchTiles`:
//   1. loadSiblings — for every visible-tile we already need, pull
//      the tile's not-yet-cached sibling quadrants too. Bridges the
//      "next frame the camera nudges 1 px and a fresh tile becomes
//      visible" gap.
//   2. Pan-direction speculation — project the camera's current
//      velocity vector forward by a fixed lookahead, walk the future
//      frustum, fetch the tiles the camera is heading toward.
//
// Stateful: keeps the previous-frame camera snapshot so the velocity
// vector reflects whole-frame motion (the per-render `_lastCamSnap`
// in VTR overwrites many times per frame because the bucket scheduler
// invokes render() ~80× per frame on dense styles). Caller invokes
// `pump` exactly once per wall-clock frame.

import type { TileCatalog } from '../../data/tile-catalog'
import {
  collectSiblingPrefetchKeys, projectPanPrefetchTarget,
  type CameraSnapshot,
} from '../tile-decision'
import { visibleTilesFrustumSampled } from '../../data/tile-select'
import { Camera } from '../projection/camera'
import { mercator as mercatorProj } from '../projection/projection'
import type { Projection } from '../projection/projection'
import { tileKey } from '@xgis/compiler'

/** Inputs the scheduler reads from the surrounding render loop —
 *  decoupled so VTR's frame-tile cache shape is the only contract. */
export interface PrefetchFrameInputs {
  /** Tiles the visible-tile selector picked this frame. Empty array
   *  is a no-op signal (pre-attach state). */
  neededKeys: readonly number[]
}

export class PrefetchScheduler {
  /** Frame-stable previous-frame camera snapshot. Updated exactly
   *  once per `pump` call — the velocity vector built from
   *  (prev → cur) reflects whole-frame motion rather than the noise
   *  from VTR's intra-frame _lastCamSnap churn (overwritten 80× per
   *  frame on dense styles). */
  private prevPanCam: CameraSnapshot | null = null

  /** Issue speculative prefetch requests for the visible-tile set.
   *  Fire-and-forget; returns immediately. Callers (VTR) invoke this
   *  exactly once per wall-clock frame, AFTER the first render() of
   *  the frame populates `inputs.neededKeys`. */
  pump(
    source: TileCatalog,
    inputs: PrefetchFrameInputs,
    camera: Camera,
    projType: number,
    canvasWidth: number,
    canvasHeight: number,
    dpr: number,
  ): void {
    if (!source.hasData()) return

    const cur: CameraSnapshot = {
      cx: camera.centerX,
      cy: camera.centerY,
      zoom: camera.zoom,
      t: performance.now(),
    }
    const prev = this.prevPanCam
    this.prevPanCam = cur

    if (inputs.neededKeys.length === 0) return
    const needed = inputs.neededKeys

    // ─── Route 1: loadSiblings ───────────────────────────────────
    const siblings = collectSiblingPrefetchKeys(
      needed,
      (k) => source.hasTileData(k),
      (k) => source.hasEntryInIndex(k),
    )
    if (siblings.length > 0) source.prefetchTiles(siblings)

    // ─── Route 2: Google Earth pan-direction speculation ─────────
    if (prev === null) return
    const future = projectPanPrefetchTarget(prev, cur, camera.pitch ?? 0)
    if (future === null) return
    // Materialise a temporary Camera at the projected position. We
    // copy bearing / pitch / maxZoom from the live camera so the
    // frustum walk uses the same view direction the user is heading
    // toward. cheap — Camera's constructor is a few field assigns.
    const futureCam = new Camera(0, 0, future.zoom)
    futureCam.centerX = future.cx
    futureCam.centerY = future.cy
    futureCam.zoom = future.zoom
    futureCam.pitch = camera.pitch
    futureCam.bearing = camera.bearing
    futureCam.maxZoom = camera.maxZoom
    const targetZ = Math.max(0, Math.min(Math.floor(future.zoom), source.maxLevel))
    // Same selectorProj derivation as VTR.render — keeps the future-
    // frustum walk consistent with the live one.
    const selectorProj: Projection = projType === 0
      ? mercatorProj
      : { name: 'non-mercator', forward: mercatorProj.forward, inverse: mercatorProj.inverse }
    const futureTiles = visibleTilesFrustumSampled(
      futureCam, selectorProj, targetZ, canvasWidth, canvasHeight, 0, dpr,
    )
    if (futureTiles.length === 0) return
    const futureKeys: number[] = []
    for (const t of futureTiles) {
      const k = tileKey(t.z, t.x, t.y)
      if (source.hasTileData(k)) continue
      if (!source.hasEntryInIndex(k)) continue
      futureKeys.push(k)
    }
    if (futureKeys.length > 0) source.prefetchTiles(futureKeys)
  }
}
