// ═══ Vector drape — stroke bake helper (#599 line-drape) ═══
//
// The globe vector LINE / polygon-OUTLINE analogue of the fill bake. The fill bake (I1 #990) draws a
// tile's flat-Mercator fill into an offscreen tile-local texture; this module adds the tile's SDF line
// segments (polygon outlines + line features) into that SAME texture, on top of the fill, so ONE
// draped texture curves fill AND strokes onto the sphere grid (VectorDrapeRenderer). No new sphere line
// shader: it reuses the screen line pipeline through LineRenderer's single-sample BAKE material, with
// the flat-Mercator VS arm (proj 0 / cam 0 / ortho MVP — supplied by the caller in the shared tile
// uniform) exactly as the fill bake reuses the flat fill arm.
//
// Split out of vector-tile-renderer.ts (at its LOC ceiling) so the bake-layer-slot packing + the
// cache key stay unit-reasonable and VTR keeps only the wiring. This module owns NO GPU state — the
// caller passes the LineRenderer, the (wrapped) tile bind group, and the bake pass.

import type { RhiBindGroup, RhiRenderPass } from '@xgis/engine'
import type { LineRenderer } from './line-renderer'
import type { PatternSlot } from './line-pattern'

/** The resolved, mpp-INDEPENDENT stroke style captured from the direct layer-slot write. Re-packed
 *  per baked tile with that tile's bake mpp (E/BAKE_PX). `dashSrc` stays in Mapbox width units and is
 *  scaled to metres here; screen-space knobs (viewport_height, dpr, line-translate) are dropped. */
export interface BakeStrokeStyle {
  color: [number, number, number, number]
  widthPx: number
  cap: number
  join: number
  miterLimit: number
  roundLimit: number
  blur: number
  /** Dash array in Mapbox line-width units (null = solid). Scaled to metres with the bake mpp.
   *  `readonly` — the source is `resolvedShow.dashArray ?? show.dashArray`, a readonly array. */
  dashSrc: readonly number[] | null
  dashOffsetUnits: number
  patternSlots: PatternSlot[]
  offset: number
}

/** A fresh zeroed style (VTR holds one, mutated in place per render() — no per-frame alloc). */
export function emptyBakeStrokeStyle(): BakeStrokeStyle {
  return {
    color: [0, 0, 0, 0],
    widthPx: 0,
    cap: 0,
    join: 0,
    miterLimit: 2,
    roundLimit: 0,
    blur: 0,
    dashSrc: null,
    dashOffsetUnits: 0,
    patternSlots: [],
    offset: 0,
  }
}

/** The per-tile stroke segment handles the bake reads (structural — a VTR GPUTile satisfies it, so
 *  this module never imports the renderer types). */
export interface BakeStrokeTile {
  outlineSegmentCount: number
  outlineSegmentBindGroup: RhiBindGroup | null
  lineSegmentCount: number
  lineSegmentBindGroup: RhiBindGroup | null
}

/** A stable 32-bit key over the drape-relevant stroke style (colour + width + cap/join + dash length)
 *  so the drape's I3 baked-texture cache re-bakes when a style change alters the stroke content. Dash
 *  OFFSET is excluded — its animation would defeat the cache (marching dashes aren't draped here). 0
 *  when there is no stroke to bake. */
export function strokeBakeKey(active: boolean, s: BakeStrokeStyle): number {
  if (!active) return 0
  const q8 = (c: number): number => (c * 255) & 0xff
  const colour =
    q8(s.color[0]) | (q8(s.color[1]) << 8) | (q8(s.color[2]) << 16) | (q8(s.color[3]) << 24)
  let k = colour
  k = (k ^ (Math.round(s.widthPx * 16) * 0x9e3779b1)) | 0
  k = (k ^ ((s.cap | (s.join << 3)) * 0x85ebca6b)) | 0
  k = (k ^ ((s.dashSrc?.length ?? 0) * 0xc2b2ae35)) | 0
  return k | 0
}

/** Pack a line-layer uniform slot for the bake with the tile's bake mpp (E/BAKE_PX), then flush the
 *  line layer ring so the bake's self-submitted command buffer reads it. Screen-space knobs are
 *  neutralised: `viewport_height = 0` skips the width clamp (which needs the real screen MVP), `dpr =
 *  1`, line-translate = 0. `opacity = 1` — the baked stroke holds full straight-alpha colour; the
 *  drape's raster frame uniform applies the layer opacity (like the fill). Dash lengths (width units)
 *  are scaled to metres with the bake mpp. Returns the layer byte offset. */
function writeBakeStrokeLayerSlot(lr: LineRenderer, s: BakeStrokeStyle, bakeMpp: number): number {
  const dash =
    s.dashSrc && s.dashSrc.length >= 2
      ? {
          array: s.dashSrc.map((v) => v * s.widthPx * bakeMpp),
          offset: s.dashOffsetUnits * s.widthPx * bakeMpp,
        }
      : null
  const off = lr.writeLayerSlot(
    s.color,
    s.widthPx,
    1, // opacity — drape applies layer opacity
    bakeMpp,
    s.cap,
    s.join,
    s.miterLimit,
    dash,
    s.patternSlots,
    s.offset,
    0, // viewport_height = 0 → skip the screen-space width clamp
    s.blur,
    1, // dpr
    0, // line-translate x (screen-space; N/A in the bake)
    0, // line-translate y
    s.roundLimit,
  )
  // The bake encoder self-submits (ownsSubmit), so this slot must be uploaded before that submit.
  // endFrame() flushes the accrued dirty range (the frame's final endFrame re-flushes any later
  // direct-draw slots — a second flush is a no-op / cheap subarray).
  lr.endFrame()
  return off
}

/** Bake a tile's polygon OUTLINES + LINE features into the offscreen tile RT, on top of the already-
 *  baked fill. Draw order matches the direct globe draw (fills, then strokes). `tileBg` is the wrapped
 *  ring-referencing base group at the bake ortho-MVP slot (`slotOffset` — the same shared VTR uniform
 *  the fill read); the layer slot carries the bake-mpp stroke style. No-op when `tileBg` is null. */
export function bakeTileStrokes(
  lr: LineRenderer,
  tileBg: RhiBindGroup | null,
  pass: RhiRenderPass,
  cached: BakeStrokeTile,
  slotOffset: number,
  bakeMpp: number,
  s: BakeStrokeStyle,
  patternActive: boolean,
): void {
  if (!tileBg) return
  const layerOffset = writeBakeStrokeLayerSlot(lr, s, bakeMpp)
  if (cached.outlineSegmentCount > 0 && cached.outlineSegmentBindGroup) {
    lr.drawSegmentsBake(
      pass,
      tileBg,
      cached.outlineSegmentBindGroup,
      cached.outlineSegmentCount,
      slotOffset,
      layerOffset,
      patternActive,
    )
  }
  if (cached.lineSegmentCount > 0 && cached.lineSegmentBindGroup) {
    lr.drawSegmentsBake(
      pass,
      tileBg,
      cached.lineSegmentBindGroup,
      cached.lineSegmentCount,
      slotOffset,
      layerOffset,
      patternActive,
    )
  }
}
