// SDF line-segment buffer builder — pure JS, no GPU dependency.
//
// Extracted from line-renderer.ts so MVT compile workers can import
// this without dragging in WebGPU types / WGSL shaders. The runtime
// LineRenderer class re-exports from here.

// ═══ Segment Buffer Layout ═══
// 40 bytes per segment. Phase 1: p0, p1 only. Later phases add prev/next tangents, arc_start, line_length.

// DSFUN segment layout (stride 20 f32 = 80 bytes — naturally
// rounded up to a 16-byte multiple by WGSL because the struct ends
// in scalar fields after vec2 pairs):
//   [0-1]   p0_h (vec2<f32>)        — tile-local Mercator meters, high pair
//   [2-3]   p1_h (vec2<f32>)
//   [4-5]   p0_l (vec2<f32>)        — low pair
//   [6-7]   p1_l (vec2<f32>)
//   [8-9]   prev_tangent (vec2<f32>)
//   [10-11] next_tangent (vec2<f32>)
//   [12]    arc_start (f32)
//   [13]    line_length (f32)
//   [14]    pad_ratio_p0 (f32)
//   [15]    pad_ratio_p1 (f32)
//   [16]    z_lift_m (f32)          — per-segment world-z lift in metres
//   [17]    width_px_override (f32) — per-segment stroke width in pixels;
//                                      0 = "use the layer-uniform width
//                                      (legacy / unmerged path)"; non-zero
//                                      values come from the compiler's
//                                      mergeLayers pass synthesizing a
//                                      `match(.field) { "kind" -> N }`
//                                      that the worker resolves per
//                                      feature.
//   [18-19] _pad (2 × f32)          — vec4 alignment fill
//
// The shader subtracts (p0_h - cam_h) + (p0_l - cam_l) to cancel tile-origin
// magnitude and recover camera-relative meters with f64-equivalent precision.
// Tangents stay single-f32 — they're unit vectors in a tile-local frame and
// don't suffer from cancellation.
//
// `z_lift_m` carries the source feature's 3D extrude height (looked up
// per-segment at build time from the slice's heights map). Lets the
// line shader place a polygon outline on top of its building's roof
// even when the building's height varies per feature — previously the
// outline used a single uniform value (the layer's fallback) and
// floated mid-wall on tall / short buildings. 0 = stay on the ground
// (default for non-extruded layers).
export const LINE_SEGMENT_STRIDE_F32 = 20
export const LINE_SEGMENT_STRIDE_BYTES = LINE_SEGMENT_STRIDE_F32 * 4

/**
 * Miter pad ratio: how far past the endpoint the quad must extend, in units of
 * `half_w`. Mirrors the shader's miter math (`miter_len = half_w / sin(α)`).
 *
 *   tangentA = direction arriving at the vertex (unit)
 *   tangentB = direction leaving the vertex (unit)
 *
 * Returns 1 (no extension) when either tangent is zero (cap), when the segments
 * are nearly collinear (straight line — neighbor handles past-the-join), or
 * when the corner is sharper than `miterLimit` allows (bevel fallback).
 * Otherwise returns `1 / sin(half_angle)` capped at `miterLimit`.
 */
function computeMiterPadRatio(
  tangentA: [number, number],
  tangentB: [number, number],
  miterLimit: number,
): number {
  const ax = tangentA[0], ay = tangentA[1]
  const bx = tangentB[0], by = tangentB[1]
  if ((ax === 0 && ay === 0) || (bx === 0 && by === 0)) return 1 // cap
  // The quad extends along the segment direction (tangentA). The miter tip
  // projects onto this direction by |tan(θ/2)| × half_w, where θ is the
  // angle between the two tangent vectors. The previous formula (1/sin(θ/2))
  // gives the miter LENGTH along the bisector, which underestimates the
  // along-direction projection for angles > 103.6°, leaving the miter tip
  // outside the quad (visible triangular gap).
  //
  // Derivation:  pad_along = |cross(A,B)| / (1 + dot(A,B)) = |tan(θ/2)|
  const cross = Math.abs(ax * by - ay * bx)
  const dotAB = ax * bx + ay * by
  const denom = 1 + dotAB
  if (denom < 1e-6) return miterLimit // 180° degenerate — worst case
  const padAlong = cross / denom
  if (padAlong < 0.05) return 1       // collinear-ish, no miter needed
  // Miter limit check: 1/sin(θ/2) > miterLimit → bevel fallback.
  // sinHalf = |cross| / |A+B|
  const bisLen = Math.hypot(ax + bx, ay + by)
  if (bisLen > 1e-6) {
    const sinHalf = cross / bisLen
    if (sinHalf < 1 / miterLimit) return 1 // beyond miter limit → bevel
  }
  return Math.min(padAlong, miterLimit)
}

/** Miter limit assumed at build time. Must match the shader default so quad
 *  pads are valid when the layer uniform uses the default `miter_limit`. If a
 *  layer sets a larger miter_limit than this, the shader will still clamp to
 *  the stored ratio — visual correctness is preserved, only overdraw grows.
 */
const DEFAULT_BUILD_MITER_LIMIT = 4.0

/**
 * Build a segment storage buffer from line vertices + indices.
 *
 * Input vertices are DSFUN tile-local Mercator meters:
 *   - stride 5: `[mx_h, my_h, mx_l, my_l, featId]`          — polygon outlines
 *   - stride 6: `[mx_h, my_h, mx_l, my_l, featId, arcStart]` — line features
 *
 * No Mercator projection needed here — the tiler already pre-projected each
 * vertex to Mercator meters at compile time. This function reads the DSFUN
 * high/low pair back into an f64-equivalent TS number for CPU-side tangent
 * math, then re-splits the endpoint positions into the segment storage
 * buffer where the shader performs the cancellation subtraction at draw
 * time.
 *
 * Also computes prev_tangent/next_tangent for each segment by looking up
 * adjacent segments that share an endpoint — needed for line join rendering.
 */
export function buildLineSegments(
  vertices: Float32Array,
  indices: Uint32Array,
  stride: 5 | 6 | 10 = 5,
  /** Tile width/height in Mercator METERS — used to detect chain ends that
   *  sit on a tile boundary and treat them as virtual joins (same-direction
   *  tangent) so the SDF shader emits no cap there. Adjacent tiles' segments
   *  meet at the boundary and the union forms a continuous stroke. Optional;
   *  when omitted, boundary detection is disabled. */
  tileWidthMerc: number = 0,
  tileHeightMerc: number = 0,
  /** featId → 3D extrude height (metres). When supplied, every emitted
   *  segment carries the height looked up from its source feature's
   *  ID — the outline rides the building roof at the per-feature
   *  height instead of at a single uniform fallback. Map is read
   *  via the input vertex's featId at offset 4 in the DSFUN stream. */
  heights?: ReadonlyMap<number, number>,
  /** featId → stroke width (pixels). Compiler-synthesized for
   *  same-source-layer compounds whose members had different widths
   *  (roads_minor / primary / highway). Written into the segment at
   *  offset 17; the line shader picks `seg.width_px` over the layer
   *  uniform when non-zero. Absent / 0 entries fall through to the
   *  layer's scalar width. */
  widths?: ReadonlyMap<number, number>,
): Float32Array {
  const segCount = indices.length / 2
  const out = new Float32Array(segCount * LINE_SEGMENT_STRIDE_F32)

  // Reconstruct f64-equivalent tile-local Mercator meters from the DSFUN
  // high/low pair. Precision loss here is ~0 because the values were
  // originally split with Math.fround.
  const projVert = (vi: number): [number, number] => {
    const off = vi * stride
    const mx = vertices[off] + vertices[off + 2]
    const my = vertices[off + 1] + vertices[off + 3]
    return [mx, my]
  }

  // Build adjacency: vertex_index → [segment_index, ...] in CSR form.
  // See buildLineSegments comment in line-renderer.ts for the rationale.
  let maxVert = 0
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i]
    if (v > maxVert) maxVert = v
  }
  const vertCount = maxVert + 1
  const adjCount = new Uint32Array(vertCount)
  for (let i = 0; i < segCount; i++) {
    adjCount[indices[i * 2]]++
    adjCount[indices[i * 2 + 1]]++
  }
  const adjStart = new Uint32Array(vertCount + 1)
  for (let v = 0; v < vertCount; v++) adjStart[v + 1] = adjStart[v] + adjCount[v]
  const adjList = new Uint32Array(adjStart[vertCount])
  adjCount.fill(0)
  for (let i = 0; i < segCount; i++) {
    const a = indices[i * 2]
    const b = indices[i * 2 + 1]
    adjList[adjStart[a] + adjCount[a]++] = i
    adjList[adjStart[b] + adjCount[b]++] = i
  }

  if (stride < 6) {
    throw new Error(
      `[line-segment-build] buildLineSegments expects stride>=6 with global arc_start at vertex[5]; got stride=${stride}. ` +
      `Polygon outlines must come in via outlineVertices (stride-10), not as stride-5 indices into the polygon fill buffer.`,
    )
  }
  const arcStart = new Float32Array(segCount)
  const arcTotal = new Float32Array(segCount)
  const segLen = new Float32Array(segCount)
  for (let i = 0; i < segCount; i++) {
    const a = indices[i * 2], b = indices[i * 2 + 1]
    const [ax, ay] = projVert(a)
    const [bx, by] = projVert(b)
    const dx = bx - ax, dy = by - ay
    segLen[i] = Math.sqrt(dx * dx + dy * dy)
    arcStart[i] = vertices[a * stride + 5]
  }

  const EPS_M = 10
  const onBoundary = (mxLocal: number, myLocal: number): boolean => {
    if (tileWidthMerc <= 0 || tileHeightMerc <= 0) return false
    return (
      mxLocal <= EPS_M ||
      myLocal <= EPS_M ||
      mxLocal >= tileWidthMerc - EPS_M ||
      myLocal >= tileHeightMerc - EPS_M
    )
  }
  const vertOnBoundary = (vi: number): boolean => {
    const [mx, my] = projVert(vi)
    return onBoundary(mx, my)
  }

  for (let i = 0; i < segCount; i++) {
    const a = indices[i * 2]
    const b = indices[i * 2 + 1]
    const off = i * LINE_SEGMENT_STRIDE_F32

    const aOff = a * stride
    const bOff = b * stride
    const a_mxH = vertices[aOff]
    const a_myH = vertices[aOff + 1]
    const a_mxL = vertices[aOff + 2]
    const a_myL = vertices[aOff + 3]
    const b_mxH = vertices[bOff]
    const b_myH = vertices[bOff + 1]
    const b_mxL = vertices[bOff + 2]
    const b_myL = vertices[bOff + 3]

    out[off + 0] = a_mxH
    out[off + 1] = a_myH
    out[off + 2] = b_mxH
    out[off + 3] = b_myH
    out[off + 4] = a_mxL
    out[off + 5] = a_myL
    out[off + 6] = b_mxL
    out[off + 7] = b_myL

    const p0x = a_mxH + a_mxL
    const p0y = a_myH + a_myL
    const p1x = b_mxH + b_mxL
    const p1y = b_myH + b_myL

    const segDxBuild = p1x - p0x
    const segDyBuild = p1y - p0y
    const segLenBuild = Math.hypot(segDxBuild, segDyBuild)
    const dxUnit = segLenBuild > 1e-9 ? segDxBuild / segLenBuild : 1
    const dyUnit = segLenBuild > 1e-9 ? segDyBuild / segLenBuild : 0

    let prevTx = 0, prevTy = 0
    if (stride === 10) {
      prevTx = vertices[a * stride + 6]
      prevTy = vertices[a * stride + 7]
    }
    if (prevTx === 0 && prevTy === 0) {
      const aStart = adjStart[a], aEnd = adjStart[a + 1]
      if (aEnd - aStart > 1) {
        for (let nIdx = aStart; nIdx < aEnd; nIdx++) {
          const ns = adjList[nIdx]
          if (ns === i) continue
          const na = indices[ns * 2]
          const nb = indices[ns * 2 + 1]
          const otherEnd = (na === a) ? nb : na
          const [ox, oy] = projVert(otherEnd)
          const dx = p0x - ox
          const dy = p0y - oy
          const len = Math.sqrt(dx * dx + dy * dy)
          if (len > 1e-9) { prevTx = dx / len; prevTy = dy / len }
          break
        }
      }
    }
    let isRealEndpointA = false
    if (stride === 10) {
      const toutAx = vertices[a * stride + 8], toutAy = vertices[a * stride + 9]
      isRealEndpointA = (prevTx === 0 && prevTy === 0) && (Math.abs(toutAx) > 1e-6 || Math.abs(toutAy) > 1e-6)
    }
    if (prevTx === 0 && prevTy === 0 && !isRealEndpointA && vertOnBoundary(a)) {
      prevTx = dxUnit; prevTy = dyUnit
    }
    out[off + 8] = prevTx
    out[off + 9] = prevTy

    let nextTx = 0, nextTy = 0
    if (stride === 10) {
      nextTx = vertices[b * stride + 8]
      nextTy = vertices[b * stride + 9]
    }
    if (nextTx === 0 && nextTy === 0) {
      const bStart = adjStart[b], bEnd = adjStart[b + 1]
      if (bEnd - bStart > 1) {
        for (let nIdx = bStart; nIdx < bEnd; nIdx++) {
          const ns = adjList[nIdx]
          if (ns === i) continue
          const na = indices[ns * 2]
          const nb = indices[ns * 2 + 1]
          const otherEnd = (na === b) ? nb : na
          const [ox, oy] = projVert(otherEnd)
          const dx = ox - p1x
          const dy = oy - p1y
          const len = Math.sqrt(dx * dx + dy * dy)
          if (len > 1e-9) { nextTx = dx / len; nextTy = dy / len }
          break
        }
      }
    }
    let isRealEndpointB = false
    if (stride === 10) {
      const tinBx = vertices[b * stride + 6], tinBy = vertices[b * stride + 7]
      isRealEndpointB = (nextTx === 0 && nextTy === 0) && (Math.abs(tinBx) > 1e-6 || Math.abs(tinBy) > 1e-6)
    }
    if (nextTx === 0 && nextTy === 0 && !isRealEndpointB && vertOnBoundary(b)) {
      nextTx = dxUnit; nextTy = dyUnit
    }
    out[off + 10] = nextTx
    out[off + 11] = nextTy

    out[off + 12] = arcStart[i]
    out[off + 13] = arcTotal[i]

    out[off + 14] = computeMiterPadRatio([prevTx, prevTy], [dxUnit, dyUnit], DEFAULT_BUILD_MITER_LIMIT)
    out[off + 15] = computeMiterPadRatio([dxUnit, dyUnit], [nextTx, nextTy], DEFAULT_BUILD_MITER_LIMIT)

    // Per-segment z lift. featId lives at offset 4 in the DSFUN
    // input stride for every supported variant (5 / 6 / 10) — same
    // slot the polygon vertex stream uses. Both endpoints of a
    // segment within a single ring share the same featId, so we
    // sample from p0; for cross-feature segments (would be unusual
    // — typically each ring stays inside one feature) we'd see a
    // mid-segment seam, which is the input data's call to make.
    const fid = (heights || widths) ? vertices[a * stride + 4] : 0
    if (heights) {
      const h = heights.get(fid)
      out[off + 16] = typeof h === 'number' ? h : 0
    }
    // Per-segment stroke width override (pixels). 0 → shader falls
    // through to layer.width_px. See `merge-layers.ts` for the
    // compound-layer path that populates this Map.
    if (widths) {
      const w = widths.get(fid)
      out[off + 17] = typeof w === 'number' ? w : 0
    }
    // Slots 18-19 stay at the buffer's zero-init default — they're
    // pure WGSL alignment padding.
  }
  return out
}
