// ═══ Polygon mesh utilities ══════════════════════════════════════
//
// Pure functions extracted from vector-tile-renderer's upload path.
// Pulled out so the math is unit-testable independent of GPU state:
//
//   * `quantizePolygonVertices` — DSFUN Float32×5 stride 20 → packed
//     u16×2 + f32 stride 8. Optionally encodes a per-vertex `is_top`
//     flag in bit 15 of the x component (used by the 3D extrusion
//     shader to choose between z=0 and z=extrude_height_m).
//
//   * `generateWallMesh` — given polygon rings (compiler output, in
//     tile-local Mercator metres) emit side-wall vertices + indices.
//     For each ring edge (a, b) emit 4 corner vertices (a_top, a_bot,
//     b_top, b_bot) packed in the same quantized format and 6
//     indices forming two triangles. Ready to concatenate onto the
//     existing top-face vertex/index buffers before GPU upload.
//
// Both functions live in the runtime side because the compiler's
// PMTiles archives are pre-built — runtime decides at upload time
// whether to extrude based on per-show style (currently hardcoded
// for the 'buildings' MVT slice; a follow-up phase wires this to a
// `extrude:` keyword in .xgis).

import type { RingPolygon } from '@xgis/compiler'

/** 15-bit max value (32767). Top bit (0x8000) encodes is_top flag. */
const POS_RANGE = 32767
const IS_TOP_BIT = 0x8000

export interface QuantizeOptions {
  /** When true, set bit 15 of the packed x component for ALL
   *  emitted vertices (top face of an extruded polygon). When false,
   *  bit 15 is clear (flat polygon or wall bottom vertex). */
  isTop?: boolean
}

/** Pack DSFUN polygon vertices into the quantized GPU format.
 *
 *  Input:  Float32Array stride 5 — [mx_h, my_h, mx_l, my_l, fid] per
 *          vertex, tile-local Mercator metres.
 *  Output: ArrayBuffer stride 8 — [u16 mx, u16 my, f32 fid] per
 *          vertex. Each u16 splits into bit 15 (is_top flag) + bits
 *          0-14 (15-bit position quanta).
 *
 *  Precision: 32767 quanta per `tileExtentM` = 0.146 mm at z=22's
 *  9.5 m tile. Sub-pixel at every zoom in the pyramid. */
export function quantizePolygonVertices(
  dsfun: Float32Array,
  tileExtentM: number,
  options: QuantizeOptions = {},
): ArrayBuffer {
  const n = dsfun.length / 5
  const buf = new ArrayBuffer(n * 8)
  const u16 = new Uint16Array(buf)
  const f32 = new Float32Array(buf)
  const scale = POS_RANGE / tileExtentM
  const topMask = options.isTop ? IS_TOP_BIT : 0
  for (let i = 0; i < n; i++) {
    const localX = dsfun[i * 5] + dsfun[i * 5 + 2]
    const localY = dsfun[i * 5 + 1] + dsfun[i * 5 + 3]
    const fid = dsfun[i * 5 + 4]
    let mxQ = Math.round(localX * scale)
    let myQ = Math.round(localY * scale)
    if (mxQ < 0) mxQ = 0; else if (mxQ > POS_RANGE) mxQ = POS_RANGE
    if (myQ < 0) myQ = 0; else if (myQ > POS_RANGE) myQ = POS_RANGE
    const u16Idx = i * 4
    u16[u16Idx] = mxQ | topMask
    u16[u16Idx + 1] = myQ
    f32[i * 2 + 1] = fid
  }
  return buf
}

/** Result of side-wall mesh generation. */
export interface WallMesh {
  /** Stride-8 quantized vertex buffer (u16x2 + float32 fid per
   *  vertex). Includes is_top flag in bit 15 of x — alternating top
   *  and bottom for adjacent wall vertices. */
  vertices: ArrayBuffer
  /** Vertex count in the wall buffer. Indices are LOCAL (0-based);
   *  callers offset by their existing vertex buffer length before
   *  appending. */
  indices: Uint32Array
}

/** Build the side-wall mesh for an extruded polygon. For every ring
 *  edge (vertex pair (a, b)) emit four corner vertices (a_bot, b_bot,
 *  a_top, b_top) and two triangles spanning them. With `cullMode:
 *  'none'` on the fill pipeline the winding direction doesn't affect
 *  visibility, so we use a stable order regardless of ring winding.
 *
 *  Vertex layout per wall (4 vertices, indices i..i+3):
 *    i+0 = a_bot   (is_top=0)
 *    i+1 = b_bot   (is_top=0)
 *    i+2 = a_top   (is_top=1)
 *    i+3 = b_top   (is_top=1)
 *
 *  Index pairs (6 = 2 triangles):
 *    (i+0, i+1, i+2)   bot-a, bot-b, top-a
 *    (i+1, i+3, i+2)   bot-b, top-b, top-a */
export function generateWallMesh(
  polygons: ReadonlyArray<RingPolygon>,
  tileExtentM: number,
  tileMx: number,
  tileMy: number,
): WallMesh {
  // Count edges to size the buffers up front — avoids re-allocations.
  let edgeCount = 0
  for (const poly of polygons) {
    for (const ring of poly.rings) {
      // A closed ring has its first vertex repeated as last; the
      // last "edge" is the wrap, so total edges = vertex count.
      // protomaps rings may or may not include the closing vertex;
      // we treat (i, i+1) as edges where i+1 < length, plus the
      // wrap (last, first) iff first ≠ last.
      const len = ring.length
      if (len < 2) continue
      const closed = ring[0][0] === ring[len - 1][0] && ring[0][1] === ring[len - 1][1]
      edgeCount += closed ? len - 1 : len
    }
  }

  const totalVerts = edgeCount * 4
  const buf = new ArrayBuffer(totalVerts * 8)
  const u16 = new Uint16Array(buf)
  const f32 = new Float32Array(buf)
  const scale = POS_RANGE / tileExtentM
  const indices = new Uint32Array(edgeCount * 6)

  let vIdx = 0  // running vertex index across all walls
  let idxOut = 0

  const writeVertex = (mx: number, my: number, isTop: boolean): void => {
    let mxQ = Math.round((mx - tileMx) * scale)
    let myQ = Math.round((my - tileMy) * scale)
    if (mxQ < 0) mxQ = 0; else if (mxQ > POS_RANGE) mxQ = POS_RANGE
    if (myQ < 0) myQ = 0; else if (myQ > POS_RANGE) myQ = POS_RANGE
    const u16Idx = vIdx * 4
    u16[u16Idx] = mxQ | (isTop ? IS_TOP_BIT : 0)
    u16[u16Idx + 1] = myQ
    f32[vIdx * 2 + 1] = 0  // wall vertices have no per-feat picking
    vIdx++
  }

  for (const poly of polygons) {
    for (const ring of poly.rings) {
      const len = ring.length
      if (len < 2) continue
      const closed = ring[0][0] === ring[len - 1][0] && ring[0][1] === ring[len - 1][1]
      const lastEdgeI = closed ? len - 1 : len
      for (let i = 0; i < lastEdgeI; i++) {
        const aIdx = i
        const bIdx = (i + 1) % len
        const ax = ring[aIdx][0], ay = ring[aIdx][1]
        const bx = ring[bIdx][0], by = ring[bIdx][1]
        const baseV = vIdx
        writeVertex(ax, ay, false)  // a_bot
        writeVertex(bx, by, false)  // b_bot
        writeVertex(ax, ay, true)   // a_top
        writeVertex(bx, by, true)   // b_top
        // Two triangles per wall.
        indices[idxOut++] = baseV + 0
        indices[idxOut++] = baseV + 1
        indices[idxOut++] = baseV + 2
        indices[idxOut++] = baseV + 1
        indices[idxOut++] = baseV + 3
        indices[idxOut++] = baseV + 2
      }
    }
  }

  return { vertices: buf, indices }
}
