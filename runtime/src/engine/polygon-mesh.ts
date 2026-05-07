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
//   * `*Extruded` variants — same outputs plus a parallel Float32Array
//     of per-vertex z (world-metre lift). Caller passes featId→height
//     (extracted from MVT properties at decode time); top-face / wall-
//     top vertices receive that feature's height, wall-bottom vertices
//     receive 0. The runtime uses a separate stride-12 pipeline for
//     extruded layers (vertex buffer 0 = same stride-8 as flat path,
//     buffer 1 = the z attribute) so the flat-polygon hot path keeps
//     its current 8-byte stride.
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

// ─────────────────────────────────────────────────────────────────
// Extruded variants — emit per-vertex z (world-metre lift) so the
// extruded fill pipeline can apply per-feature heights without a
// storage buffer. The vertex buffer's stride stays at 8 bytes
// (same as flat polygons); per-vertex z lives in a parallel
// Float32Array bound as a second vertex buffer.
// ─────────────────────────────────────────────────────────────────

/** Result of the extruded top-face quantize: stride-8 vertex buffer
 *  + parallel z attribute (one float per vertex, world metres). */
export interface QuantizeExtrudedResult {
  vertices: ArrayBuffer
  z: Float32Array
}

/** Same packing as `quantizePolygonVertices` (top-face only — every
 *  vertex gets is_top=1 and z=heights.get(featId) ?? defaultHeight),
 *  plus a parallel Float32Array of per-vertex z. */
export function quantizePolygonVerticesExtruded(
  dsfun: Float32Array,
  tileExtentM: number,
  heights: ReadonlyMap<number, number>,
  defaultHeight: number,
): QuantizeExtrudedResult {
  const n = dsfun.length / 5
  const buf = new ArrayBuffer(n * 8)
  const u16 = new Uint16Array(buf)
  const f32 = new Float32Array(buf)
  const z = new Float32Array(n)
  const scale = POS_RANGE / tileExtentM
  for (let i = 0; i < n; i++) {
    const localX = dsfun[i * 5] + dsfun[i * 5 + 2]
    const localY = dsfun[i * 5 + 1] + dsfun[i * 5 + 3]
    const fid = dsfun[i * 5 + 4]
    let mxQ = Math.round(localX * scale)
    let myQ = Math.round(localY * scale)
    if (mxQ < 0) mxQ = 0; else if (mxQ > POS_RANGE) mxQ = POS_RANGE
    if (myQ < 0) myQ = 0; else if (myQ > POS_RANGE) myQ = POS_RANGE
    const u16Idx = i * 4
    u16[u16Idx] = mxQ | IS_TOP_BIT
    u16[u16Idx + 1] = myQ
    f32[i * 2 + 1] = fid
    z[i] = heights.get(fid) ?? defaultHeight
  }
  return { vertices: buf, z }
}

export interface WallMeshExtruded {
  vertices: ArrayBuffer
  indices: Uint32Array
  /** Per-vertex z in world metres (length = vertices.byteLength / 8).
   *  Bottom vertices have z=0; top vertices have z=feature-height. */
  z: Float32Array
}

/** Same wall mesh as `generateWallMesh` plus per-vertex z. The z
 *  attribute pairs with the stride-8 vertex buffer; the extruded
 *  fill pipeline binds both at slots 0 and 1. */
export function generateWallMeshExtruded(
  polygons: ReadonlyArray<RingPolygon>,
  tileExtentM: number,
  tileMx: number,
  tileMy: number,
  heights: ReadonlyMap<number, number>,
  defaultHeight: number,
): WallMeshExtruded {
  let edgeCount = 0
  for (const poly of polygons) {
    for (const ring of poly.rings) {
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
  const z = new Float32Array(totalVerts)
  const scale = POS_RANGE / tileExtentM
  const indices = new Uint32Array(edgeCount * 6)

  let vIdx = 0
  let idxOut = 0

  const writeVertex = (mx: number, my: number, isTop: boolean, fid: number, h: number): void => {
    let mxQ = Math.round((mx - tileMx) * scale)
    let myQ = Math.round((my - tileMy) * scale)
    if (mxQ < 0) mxQ = 0; else if (mxQ > POS_RANGE) mxQ = POS_RANGE
    if (myQ < 0) myQ = 0; else if (myQ > POS_RANGE) myQ = POS_RANGE
    const u16Idx = vIdx * 4
    u16[u16Idx] = mxQ | (isTop ? IS_TOP_BIT : 0)
    u16[u16Idx + 1] = myQ
    f32[vIdx * 2 + 1] = fid
    z[vIdx] = isTop ? h : 0
    vIdx++
  }

  for (const poly of polygons) {
    const fid = poly.featId
    const h = heights.get(fid) ?? defaultHeight
    for (let r = 0; r < poly.rings.length; r++) {
      const ring = poly.rings[r]
      const len = ring.length
      if (len < 2) continue
      const closed = ring[0][0] === ring[len - 1][0] && ring[0][1] === ring[len - 1][1]
      const lastEdgeI = closed ? len - 1 : len
      // Wall winding has to face outward from the polygon mass so a
      // single `cullMode: 'back'` on the extruded fill pipeline drops
      // the back faces. Outer rings in the MVT spec are CCW (positive
      // signed area in screen space); inner rings (holes) are CW. For
      // CCW rings, emitting triangles in (a_bot, b_bot, a_top) +
      // (b_bot, b_top, a_top) order produces outward-facing front
      // faces. For CW rings (e.g. holes, where outward = into the
      // hole = away from the building mass) we flip the per-edge
      // direction so the triangles still face outward from the
      // interior.
      let signed2 = 0
      for (let i = 0; i < lastEdgeI; i++) {
        const j = (i + 1) % len
        signed2 += ring[i][0] * ring[j][1] - ring[j][0] * ring[i][1]
      }
      const ccw = signed2 > 0
      for (let i = 0; i < lastEdgeI; i++) {
        const aIdx = ccw ? i : (i + 1) % len
        const bIdx = ccw ? (i + 1) % len : i
        const ax = ring[aIdx][0], ay = ring[aIdx][1]
        const bx = ring[bIdx][0], by = ring[bIdx][1]
        const baseV = vIdx
        writeVertex(ax, ay, false, fid, h)
        writeVertex(bx, by, false, fid, h)
        writeVertex(ax, ay, true,  fid, h)
        writeVertex(bx, by, true,  fid, h)
        indices[idxOut++] = baseV + 0
        indices[idxOut++] = baseV + 1
        indices[idxOut++] = baseV + 2
        indices[idxOut++] = baseV + 1
        indices[idxOut++] = baseV + 3
        indices[idxOut++] = baseV + 2
      }
    }
  }

  return { vertices: buf, indices, z }
}
