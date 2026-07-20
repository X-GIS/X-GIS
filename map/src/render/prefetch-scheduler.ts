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

import type { TileCatalog } from '@xgis/data'
import {
  collectSiblingPrefetchKeys,
  projectPanPrefetchTarget,
  type CameraSnapshot,
} from '../tile-decision'
import { visibleTilesFrustumSampled } from '@xgis/data'
import { Camera } from '../camera'
import { mercator as mercatorProj } from '@xgis/geo'
import type { Projection } from '@xgis/geo'
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

  /** Wall-clock frame counter driving the route-2 throttle below.
   *  `pump` has exactly ONE call site (render-loop.ts:467, once per
   *  frame per source) and each VTR owns its own scheduler
   *  (vector-tile-renderer.ts:261), so counting pumps counts frames. */
  private pumpCount = 0

  /** Route-2 walk stride, in frames. 6 (~100 ms at 60 fps) copied from
   *  the Tier-2 zoom-direction gate's throttle
   *  (vector-tile-renderer.ts:3683) — same amortised cost, same reason. */
  private static readonly PAN_WALK_FRAME_STRIDE = 6

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
    const frame = this.pumpCount++
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
    //
    // Throttled to every 6th frame (~100 ms at 60 fps), mirroring the
    // Tier-2 zoom-direction gate at vector-tile-renderer.ts:3683 — the
    // amortised cost is the same one: a full `visibleTilesFrustumSampled`
    // quadtree walk (+ a temp Camera) below. Route 2 was the last
    // per-frame walk with no gate at all, while both of its siblings in
    // VTR (prefetchAdjacent :3657, Tier-2 :3683) were already throttled.
    // It shows up during a wheel zoom: the camera changes every rAF
    // (~19 frames per notch) and map.ts:3790 compares zoom by exact float
    // equality, so all 19 frames full-render AND re-walk here — measured
    // 15.0 ms median / 165.7 ms max, against 6.9 ms on frames that walk
    // nothing (identical to at-rest).
    //
    // Deliberately NOT the `cameraIdle` half of that precedent: idle and
    // route 2 are mutually exclusive BY CONSTRUCTION. `cameraIdle` means
    // "centre/zoom unmoved for IDLE_GRACE_MS = 200" (tile-selection-cache
    // .ts:312); `projectPanPrefetchTarget` bails below minSpeedSq ≈ 1.9
    // m/ms (tile-decision.ts:485). An idle-gated route 2 could never fire
    // once — that deletes pan speculation rather than amortising it.
    // Route 1 above stays per-frame for the mirror-image reason: it is
    // O(neededKeys) with no walk, and its whole job ("the camera nudged
    // 1 px and a fresh tile became visible") only exists in motion.
    //
    // The `cur` snapshot likewise stays per-frame, and MUST: throttling it
    // would stretch prev→cur dt to 6 frames, and projectPanPrefetchTarget
    // discards dt ≥ 200 ms (tile-decision.ts:474) — exactly 6 frames at the
    // 30 fps mobile cadence, i.e. the throttle would silently kill the very
    // route it means to preserve. Only the WALK is strided; velocity stays
    // a 1-frame measurement with its lookahead semantics untouched.
    if (frame % PrefetchScheduler.PAN_WALK_FRAME_STRIDE !== 0) return
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
    // Sync the maintained true-centre latitude from the projected centerY so
    // this temp camera is internally consistent (it only drives the flat
    // frustum prefetch walk, but keep the invariant intact).
    futureCam.syncCenterLat()
    futureCam.zoom = future.zoom
    futureCam.pitch = camera.pitch
    futureCam.bearing = camera.bearing
    futureCam.maxZoom = camera.maxZoom
    const targetZ = Math.max(0, Math.min(Math.floor(future.zoom), source.maxLevel))
    // Same selectorProj derivation as VTR.render — keeps the future-
    // frustum walk consistent with the live one.
    const selectorProj: Projection =
      projType === 0
        ? mercatorProj
        : { name: 'non-mercator', forward: mercatorProj.forward, inverse: mercatorProj.inverse }
    const futureTiles = visibleTilesFrustumSampled(
      futureCam,
      selectorProj,
      targetZ,
      canvasWidth,
      canvasHeight,
      0,
      dpr,
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
