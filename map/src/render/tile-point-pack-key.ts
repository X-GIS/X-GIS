// #1581 leg B — the tile-point dirty-check key, extracted (point-renderer.ts
// and vector-tile-renderer.ts both sit at their LOC ceilings).
//
// `emitTilePointsRhi` → `flushTilePointsRhi` reran unconditionally every
// rendered frame: a fresh object per point, the size AST re-evaluated per
// point, a full instance repack, and three GPU buffers retired + recreated —
// even at a static camera with an unchanged tile set and style. Everything
// that feeds the packed vertex/index/feat buffers is captured here; camera
// zoom/pitch are compared EXACTLY (not bucketed) — a static camera holds the
// identical primitive floats frame to frame, so exact equality already
// catches "unchanged" without a precision-losing bucket.

import type { Camera } from '../camera'
import type { RhiRenderPass } from '@xgis/engine'

/** The per-call frame args shared by `redrawTilePointsCached` and the shared
 *  uniform-refresh+draw tail — one shape instead of a 9-param signature
 *  repeated per method (point-renderer.ts sits at its LOC ceiling). */
export interface TilePointFrameArgs {
  pass: RhiRenderPass
  camera: Camera
  projType: number
  projCenterLon: number
  projCenterLat: number
  canvasWidth: number
  canvasHeight: number
  show: TilePointShow
  dpr: number
}

/** The `show` fields `flushTilePointsRhi`/`redrawTilePointsCached` read — pulled
 *  out so point-renderer.ts (at its LOC ceiling) states it once, not per method. */
export interface TilePointShow {
  fill?: string | null
  stroke?: string | null
  strokeWidth?: number
  size?: number | null
  sizeExpr?: { ast?: unknown } | null
  shape?: string | null
  sizeUnit?: string | null
  anchor?: 'center' | 'bottom' | 'top'
  billboard?: boolean
  opacity?: number
  circleTranslateX?: number
  circleTranslateY?: number
  circleBlur?: number
  circlePitchScaleMap?: boolean
  circleTranslateXShape?: import('@xgis/compiler').PropertyShape<number> | null
  circleTranslateYShape?: import('@xgis/compiler').PropertyShape<number> | null
  circleStrokeOpacityShape?: import('@xgis/compiler').PropertyShape<number> | null
}

export interface TilePointPackKey {
  stableKeysHash: number
  sliceLayer: string
  fill: string | null | undefined
  stroke: string | null | undefined
  strokeWidth: number | undefined
  size: number | null | undefined
  sizeAst: unknown
  shape: string | null | undefined
  sizeUnit: string | null | undefined
  anchor: string | undefined
  billboard: boolean | undefined
  opacity: number | undefined
  zoom: number
  pitch: number
}

/** Cheap order-independent hash over a source's `stableKeys` (numeric tile
 *  keys) — stands in for "the same tile set", without a sort or an array
 *  compare. Tile keys are already interleaved bit-packed encodings (z/x/y),
 *  so XOR-folding them is exactly as collision-safe as summing them and
 *  costs the same O(T). */
export function hashStableKeys(keys: readonly number[]): number {
  let h = 0
  for (const k of keys) h = (h ^ k) | 0
  return h
}

export function buildTilePointPackKey(
  stableKeysHash: number,
  sliceLayer: string,
  show: TilePointShow,
  cameraZoom: number,
  cameraPitch: number,
): TilePointPackKey {
  return {
    stableKeysHash,
    sliceLayer,
    fill: show.fill,
    stroke: show.stroke,
    strokeWidth: show.strokeWidth,
    size: show.size,
    sizeAst: show.sizeExpr?.ast ?? null,
    shape: show.shape,
    sizeUnit: show.sizeUnit,
    anchor: show.anchor,
    billboard: show.billboard,
    opacity: show.opacity,
    zoom: cameraZoom,
    pitch: cameraPitch,
  }
}

export function tilePointPackKeyEqual(a: TilePointPackKey | null, b: TilePointPackKey): boolean {
  return (
    a !== null &&
    a.stableKeysHash === b.stableKeysHash &&
    a.sliceLayer === b.sliceLayer &&
    a.fill === b.fill &&
    a.stroke === b.stroke &&
    a.strokeWidth === b.strokeWidth &&
    a.size === b.size &&
    a.sizeAst === b.sizeAst &&
    a.shape === b.shape &&
    a.sizeUnit === b.sizeUnit &&
    a.anchor === b.anchor &&
    a.billboard === b.billboard &&
    a.opacity === b.opacity &&
    a.zoom === b.zoom &&
    a.pitch === b.pitch
  )
}
