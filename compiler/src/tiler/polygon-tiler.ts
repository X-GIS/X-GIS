// ═══ Vector Tiler: polygon per-geometry concern ═══
// Extracted verbatim from compileSingleTile's polygon branch so the single-
// tile orchestrator stays a thin geometry-type dispatch. The packed vertex /
// index BYTES are a CPU↔WGSL contract: this module RELOCATES the clip →
// backtrack-repair → earcut → outline-arc logic unchanged, calling the same
// shared helpers (clip / tessellate / DSFUN packers) it always did. No
// algorithm is rewritten here.

import { clipPolygonToRect, splitBoundaryBacktracks } from './clip'
import {
  needsBacktrackRepair,
  tessellatePolygonToArrays,
  assignHoleBucket,
  makeSameBoundarySidePredicateMerc,
  extractNonSyntheticArcs,
  dropConsecutiveDuplicates,
  augmentChainWithArc,
  tessellateLineToArrays,
} from './vector-tiler'
import type { GeometryPart } from './vector-tiler-types'

/** Per-tile clip rect in Mercator meters (west/south/east/north). */
export interface TileClipMerc {
  mxW: number
  myS: number
  mxE: number
  myN: number
}

/** Scratch + accumulator surface a polygon part writes into. Mirrors the
 *  exact fields the inline compileSingleTile body mutated. */
export interface PolygonTileScratch {
  pv: number[]
  pi: number[]
  olv: number[]
  oli: number[]
}

/** Tile a single polygon GeometryPart into the shared scratch buffers.
 *  `part.rings` are already MM. Logic identical to the former inline
 *  branch in compileSingleTile (d34aed2 fill/outline coincidence). */
export function tilePolygonPart(
  part: GeometryPart,
  fid: number,
  clip: TileClipMerc,
  precisionMM: number,
  scratch: PolygonTileScratch,
  dedupMap: Map<string, number>,
  featureIds: Set<number>,
  tilePolygons: { rings: number[][][]; featId: number }[],
): void {
  // rings are ALREADY MM (makePolygonPart). The FILL uses the raw
  // `clipped` ring at every zoom (no simplification) so it shares the
  // exact ring set the OUTLINE line-clips below — boundaries coincide
  // by construction (d34aed2). Simplifying the fill at z<maxZoom while
  // the outline kept full detail produced a fill/stroke gap growing
  // with zoom-out; see the matching note in processZoomLevelShared.
  const clipped = clipPolygonToRect(part.rings!, clip.mxW, clip.myS, clip.mxE, clip.myN, precisionMM)
  if (clipped.length > 0 && clipped[0].length >= 3) {
    const dataRings = clipped
    // Repair self-intersecting OUTER ring only — but only when an
    // earcut probe actually detects the overlap. See
    // `needsBacktrackRepair` for the coverage-based detection.
    if (dataRings.length > 0 && dataRings[0]!.length >= 3) {
      const holes = dataRings.slice(1).filter(r => r.length >= 3)
      const acceptSplit = needsBacktrackRepair(dataRings[0]!, holes)
      if (!acceptSplit) {
        const repairedRings = [dataRings[0]!, ...holes]
        tessellatePolygonToArrays(repairedRings, fid, scratch.pv, scratch.pi, dedupMap)
        featureIds.add(fid)
        tilePolygons.push({ rings: repairedRings, featId: fid })
      } else {
        const outerSubs = splitBoundaryBacktracks(dataRings[0]!, clip.mxW, clip.myS, clip.mxE, clip.myN)
        const usableOuters = outerSubs.filter(r => r.length >= 3)
        const effectiveOuters = usableOuters.length > 0 ? usableOuters : [dataRings[0]!]
        if (effectiveOuters.length === 1) {
          const repairedRings = [effectiveOuters[0]!, ...holes]
          tessellatePolygonToArrays(repairedRings, fid, scratch.pv, scratch.pi, dedupMap)
          featureIds.add(fid)
          tilePolygons.push({ rings: repairedRings, featId: fid })
        } else {
          const subHoles: number[][][][] = effectiveOuters.map(() => [])
          for (const hole of holes) {
            subHoles[assignHoleBucket(hole, effectiveOuters)]!.push(hole)
          }
          const allRingsForFeature: number[][][] = []
          for (let si = 0; si < effectiveOuters.length; si++) {
            const subRings = [effectiveOuters[si]!, ...subHoles[si]!]
            tessellatePolygonToArrays(subRings, fid, scratch.pv, scratch.pi, dedupMap)
            for (const r of subRings) allRingsForFeature.push(r)
          }
          featureIds.add(fid)
          tilePolygons.push({ rings: allRingsForFeature, featId: fid })
        }
      }
    }
    // Outline emission: derive from the SAME `clipped` rings the
    // fill tessellates, NOT a separate line-clip of the original
    // ring. A line-clipped outline lands a few metres off the
    // polygon-clipped fill edge at tile crossings (the two clippers
    // round boundary intersections differently), opening a gap
    // visible under magnification. Tracing the identical `clipped`
    // vertices makes fill/outline coincide by construction.
    //
    // `extractNonSyntheticArcs` strips the synthetic axis-aligned
    // edges Sutherland-Hodgman adds to close the ring along the
    // tile rect (#347 — otherwise the outline strokes a spurious
    // seam at every internal tile boundary). It returns open arcs
    // of original-boundary edges, or the whole closed ring when the
    // polygon is fully interior (closed-by-intent → append the
    // first vertex so the last→first edge strokes).
    const sidePred = makeSameBoundarySidePredicateMerc(clip.mxW, clip.myS, clip.mxE, clip.myN, 1.0)
    for (const ring of clipped) {
      if (ring.length < 2) continue
      for (const arc of extractNonSyntheticArcs(ring, sidePred)) {
        // Augment with per-tile arc + tangents without moving any
        // vertex (mmInput) so fill/outline stay coincident. Cross-
        // tile global arc continuity is traded for exact coincidence
        // (see processZoomLevelShared for the full rationale).
        const isClosed = arc.length >= 3 && arc === ring
        const clean = dropConsecutiveDuplicates(arc)
        if (clean.length < 2) continue
        const chain = augmentChainWithArc(clean, isClosed, { mmInput: true })
        if (chain.length >= 2) tessellateLineToArrays(chain, fid, scratch.olv, scratch.oli)
      }
    }
  }
}
