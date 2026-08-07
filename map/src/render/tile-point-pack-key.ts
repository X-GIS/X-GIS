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
  /** #1616 — `TileCatalog.contentGeneration()`. `stableKeysHash` answers WHICH tiles
   *  are selected, never what they now contain: re-tiling a key already in the set
   *  (a host data push, a PMTiles refetch, a moving feature) leaves the hash, the
   *  index-entry count and the key set all identical. A cache hit skips the
   *  `getTileData` re-read that used to pick such a replacement up for free on the
   *  very next frame, so without this the superseded points redraw indefinitely. */
  contentGeneration: number
  /** #1616 — bitmask of the visible Mercator world copies (offset −2..+2 → bits 0..4).
   *  `flushTilePointsRhi` BAKES this set into the packed buffer (`totalN = N *
   *  COPIES.length`, each copy offset by `worldCopyMercX`), and the set is derived by
   *  unprojecting the canvas corners — so it moves with pan/bearing/canvas size/DPR,
   *  none of which the other fields carry. Keyed on the DERIVED set rather than on
   *  those inputs: it is exactly the dependency, so it cannot over-invalidate on a pan
   *  that leaves the copy set alone, nor drift from the real rule the way a
   *  hand-mirrored input list would. Always 0b00100 (copy 0 only) off Mercator. */
  worldCopyMask: number
  /** #1616 — resolved per-frame into `stroke_a` AND folded into the opaque/translucent
   *  pipeline `variant`, so a stale one is the wrong blend state, not just a wrong
   *  alpha. Compared by reference like `sizeAst`: both are compiler-set once. */
  strokeOpacityShape: unknown
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

/** Pack the visible world-copy offsets into one comparable scalar. Offsets are
 *  clamped to −2..+2 by `computeVisibleWorldCopies`, so five bits hold the set
 *  exactly — no allocation, no ordering assumption, no collision. */
export function worldCopyMaskOf(copies: readonly number[]): number {
  let mask = 0
  for (const c of copies) {
    if (c >= -2 && c <= 2) mask |= 1 << (c + 2)
  }
  return mask
}

export function buildTilePointPackKey(
  stableKeysHash: number,
  sliceLayer: string,
  show: TilePointShow,
  cameraZoom: number,
  cameraPitch: number,
  contentGeneration: number,
  worldCopyMask: number,
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
    contentGeneration,
    worldCopyMask,
    strokeOpacityShape: show.circleStrokeOpacityShape ?? null,
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
    a.pitch === b.pitch &&
    a.contentGeneration === b.contentGeneration &&
    a.worldCopyMask === b.worldCopyMask &&
    a.strokeOpacityShape === b.strokeOpacityShape
  )
}
