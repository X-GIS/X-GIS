// ═══ Vector Tiler: line per-geometry concern ═══
// Extracted verbatim from compileSingleTile's line branch. Relocates the
// augment-arc → clip → simplify → stride-8 tessellate logic unchanged; the
// shared helpers and DSFUN packers are untouched. No algorithm rewrite.

import { clipLineToRect } from './clip'
import { simplifyLine, mercatorToleranceForZoom } from './simplify'
import { augmentLineWithArc, tessellateLineToArrays } from './vector-tiler'
import type { GeometryPart } from './vector-tiler-types'
import type { TileClipMerc } from './polygon-tiler'

/** Scratch + accumulator surface a line part writes into. */
export interface LineTileScratch {
  lv: number[]
  li: number[]
}

/** Tile a single line GeometryPart into the shared scratch buffers.
 *  Logic identical to the former inline branch in compileSingleTile. */
export function tileLinePart(
  part: GeometryPart,
  fid: number,
  clip: TileClipMerc,
  z: number,
  maxZoom: number,
  isOnBoundaryMerc: (c: number[]) => boolean,
  scratch: LineTileScratch,
  featureIds: Set<number>,
): void {
  const arcLine = augmentLineWithArc(part.coords!)
  const segments = clipLineToRect(arcLine, clip.mxW, clip.myS, clip.mxE, clip.myN)
  for (const seg of segments) {
    if (seg.length >= 2) {
      const dataLine = z < maxZoom ? simplifyLine(seg, z, isOnBoundaryMerc, mercatorToleranceForZoom(z)) : seg
      if (dataLine.length >= 2) {
        tessellateLineToArrays(dataLine, fid, scratch.lv, scratch.li)
        featureIds.add(fid)
      }
    }
  }
}
