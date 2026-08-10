// #1581 leg A — the tile-selection memo's validity key, extracted from
// tile-selection-cache.ts (which sits at its LOC ceiling).

import type { Camera } from '../camera'

/** Camera + canvas + projection a selection was computed against. Compared
 *  field-by-field for exact equality (a static camera holds identical
 *  primitives frame to frame). Replaces `frameId`, which bumped on every
 *  RENDERED frame, not only on camera/canvas change. `proj` (not `projType`)
 *  avoids tripping the #996 projType-branching ratchet on this plain field
 *  compare. */
export interface CamSig {
  centerX: number
  centerY: number
  zoom: number
  bearing: number
  pitch: number
  canvasWidth: number
  canvasHeight: number
  dpr: number
  proj: number
  projCenterLon: number
  projCenterLat: number
}

export function buildCamSig(
  camera: Camera,
  projType: number,
  projCenterLon: number,
  projCenterLat: number,
  canvasWidth: number,
  canvasHeight: number,
  dpr: number,
): CamSig {
  return {
    centerX: camera.centerX,
    centerY: camera.centerY,
    zoom: camera.zoom,
    bearing: camera.bearing,
    pitch: camera.pitch,
    canvasWidth,
    canvasHeight,
    dpr,
    proj: projType,
    projCenterLon,
    projCenterLat,
  }
}

export function camSigEqual(a: CamSig, b: CamSig): boolean {
  return (
    a.centerX === b.centerX &&
    a.centerY === b.centerY &&
    a.zoom === b.zoom &&
    a.bearing === b.bearing &&
    a.pitch === b.pitch &&
    a.canvasWidth === b.canvasWidth &&
    a.canvasHeight === b.canvasHeight &&
    a.dpr === b.dpr &&
    a.proj === b.proj &&
    a.projCenterLon === b.projCenterLon &&
    a.projCenterLat === b.projCenterLat
  )
}
