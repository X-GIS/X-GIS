// ═══ SDF Line Renderer ═══
// Renders line features and polygon outlines as resolution-independent quads
// using signed-distance-field math in the fragment shader.
//
// Integration:
// - Group 0: VTR's tile uniform (MVP, tile_rtc, etc.) — reused from fill pipeline
// - Group 1: Line layer uniform + segment storage buffer
//
// Phase 1: variable pixel width, butt cap, bevel join (implicit).
// Later phases add cap/join styles, dash arrays, pattern stacks.
//
// ── Self-overlap behaviour (read this before reporting "weird joins") ──
//
// 1. Translucent self-intersection: when a single stroke crosses itself, the
//    crossing is handled by the offscreen + MAX-blend pipeline (see
//    `pipelineMax`, `beginTranslucentPass`, `composite`). Within-layer
//    overlap reduces to a single max-coverage value per pixel; cross-layer
//    blending then applies the per-layer opacity once. Result: no
//    double-darkening at self-intersections or corner overlap.
//
// 2. Dense vertices (many vertices within stroke-width pixels of each
//    other): segment quads overlap heavily and miter joins compute extreme
//    bisectors. The vertex shader's miter-limit clamp falls back to a bevel
//    offset when the ratio exceeds `layer.miter_limit`, and the fragment
//    shader guards `seg_len < 1e-6` against zero-length segments. This is
//    visually correct but pays heavy overdraw — push aggressive
//    Douglas-Peucker simplification at the tiler stage (`simplifyLine` in
//    `vector-tiler.ts`) rather than trying to fix it in the runtime.
//
// 3. Dash / pattern arc continuity: `arc_pos = arc_start + t_along` is
//    computed per fragment using each segment's stored `arc_start`
//    (precomputed in the tiler via `augmentLineWithArc` for stride-4 line
//    features). Across joins, `arc_start[seg_n+1] = arc_start[seg_n] +
//    segLen[seg_n]`, so dash and pattern phase advance continuously
//    regardless of vertex density. Caveat: arc length is measured along
//    the ORIGINAL geometry, not the offset stroke's parallel curve. For
//    typical small offsets the difference is sub-pixel; computing exact
//    parallel arc length would require per-segment numerical integration
//    and is deferred.

import type { GPUContext } from './gpu'
import { BLEND_ALPHA, BLEND_MAX, STENCIL_DISABLED, MSAA_4X } from './gpu-shared'
import {
  WGSL_DIST_TO_SEGMENT,
  WGSL_DIST_TO_QUADRATIC,
  WGSL_DIST_TO_CUBIC,
  WGSL_WINDING_LINE,
  WGSL_SHAPE_STRUCTS,
} from './wgsl-sdf'
import { WGSL_LOG_DEPTH_FNS } from './wgsl-log-depth'
import type { ShapeRegistry } from './sdf-shape'

// ═══ Layer Uniform Layout ═══
// Must match WGSL struct LineLayerUniform.
// Layout (all f32 unless noted):
//   [0-3]   color (vec4)
//   [4]     width_px
//   [5]     aa_width_px
//   [6]     mpp
//   [7]     miter_limit
//   [8]     flags (u32)   cap(0-1) | join(2-3) | dash_enable(4)
//   [9]     dash_count (u32)
//   [10]    dash_cycle_m
//   [11]    dash_offset_m
//   [12-19] dash_array[8]
//   [20-43] patterns[3] × 8 f32 each (id, flags, spacing, size, offset, start_offset, pad×2)
//   [44]    offset_m                 — lateral parallel-offset (+left)
//   [45-47] pad×3                    — 16-byte alignment
// Total = 48 f32 = 192 bytes.

export const LINE_UNIFORM_SIZE = 192
export const PATTERN_SLOT_COUNT = 3
export const PATTERN_SLOT_F32 = 8 // 32 bytes per slot

/** Line cap style IDs (Phase 2 + arrow from Phase 4). */
export const LINE_CAP_BUTT = 0
export const LINE_CAP_ROUND = 1
export const LINE_CAP_SQUARE = 2
export const LINE_CAP_ARROW = 3

/** Line join style IDs (Phase 2). */
export const LINE_JOIN_MITER = 0
export const LINE_JOIN_ROUND = 1
export const LINE_JOIN_BEVEL = 2

/**
 * Pack flags:
 *   bits 0-2: cap (butt/round/square/arrow) — 3 bits
 *   bits 3-4: join (miter/round/bevel)
 *   bit 5: dash_enable
 */
function packFlags(cap: number, join: number, dashEnable: boolean): number {
  return (cap & 7) | ((join & 3) << 3) | (dashEnable ? 1 << 5 : 0)
}

export interface DashConfig {
  /** Dash array in METERS. Even indices = on, odd = off. Max 8 entries. */
  array: number[]
  /** Phase offset in meters. */
  offset?: number
}

/** Unit IDs for pattern measurements. */
export const PATTERN_UNIT_M = 0
export const PATTERN_UNIT_PX = 1
export const PATTERN_UNIT_KM = 2
export const PATTERN_UNIT_NM = 3

/** Anchor modes for pattern placement. */
export const PATTERN_ANCHOR_REPEAT = 0
export const PATTERN_ANCHOR_START = 1
export const PATTERN_ANCHOR_END = 2
export const PATTERN_ANCHOR_CENTER = 3

export interface PatternSlot {
  /** 1-indexed shape ID from ShapeRegistry (0 = inactive slot). */
  shapeId: number
  /** Repeat spacing along the line. Value + unit. */
  spacing: number
  spacingUnit?: number
  /** Symbol extent (diameter/width). */
  size: number
  sizeUnit?: number
  /** Perpendicular offset from line centerline. Positive = left. */
  offset?: number
  offsetUnit?: number
  /** Arc offset before first instance (for anchored placements). */
  startOffset?: number
  /** Placement mode. */
  anchor?: number
}

/** Pure parameter validator for a pattern stack. Emits warnings (via the
 *  supplied `warn` callback, already deduped upstream) for combinations
 *  that produce degenerate or misleading renders. Exported so unit tests
 *  can exercise the rules without instantiating a GPU device.
 *
 *  Rules:
 *   (a) size > 2 × spacing — shader only samples ±1 neighbor, so beyond 2×
 *       spacing the pattern under-shades. Warn: "size-gt-2x-spacing".
 *   (b) spacing_m / mpp < 1 — pattern spacing collapses to sub-pixel at the
 *       current zoom, visually disappearing. Warn: "subpixel".
 */
export function checkPatternParams(
  patterns: PatternSlot[],
  mppAtCenter: number,
  warn: (key: string, msg: string) => void,
): void {
  const unitLabel = (u: number | undefined) =>
    u === PATTERN_UNIT_PX ? 'px'
    : u === PATTERN_UNIT_KM ? 'km'
    : u === PATTERN_UNIT_NM ? 'nm'
    : 'm'
  const toMeters = (v: number, unit: number | undefined) =>
    unit === PATTERN_UNIT_PX ? v * mppAtCenter
    : unit === PATTERN_UNIT_KM ? v * 1000
    : unit === PATTERN_UNIT_NM ? v * 1852
    : v  // meters (default)

  for (let i = 0; i < patterns.length; i++) {
    const pat = patterns[i]
    if (!pat || pat.shapeId <= 0) continue

    const spacingM = toMeters(pat.spacing, pat.spacingUnit)
    const sizeM = toMeters(pat.size, pat.sizeUnit)
    const spacingPx = mppAtCenter > 0 ? spacingM / mppAtCenter : 0

    if (sizeM > spacingM * 2) {
      const key = `p${i}:size-gt-2x-spacing:${pat.size}${unitLabel(pat.sizeUnit)}/${pat.spacing}${unitLabel(pat.spacingUnit)}`
      warn(
        key,
        `[LineRenderer] pattern slot ${i}: size (${pat.size}${unitLabel(pat.sizeUnit)}) > 2 × spacing (${pat.spacing}${unitLabel(pat.spacingUnit)}). ` +
        `Neighbor instances beyond ±1 are clipped — increase spacing or reduce size.`,
      )
    }

    if (spacingPx > 0 && spacingPx < 1) {
      const key = `p${i}:subpixel:${pat.spacing}${unitLabel(pat.spacingUnit)}`
      warn(
        key,
        `[LineRenderer] pattern slot ${i}: spacing is ${spacingPx.toFixed(3)} px at current zoom ` +
        `(${pat.spacing}${unitLabel(pat.spacingUnit)} × mpp=${mppAtCenter.toFixed(1)}). ` +
        `Pattern will collapse to a solid stroke — use px unit or increase spacing.`,
      )
    }
  }
}

/** Pack layer uniform data into a Float32Array for upload. */
export function packLineLayerUniform(
  strokeColor: [number, number, number, number],
  strokeWidthPx: number,
  opacity: number,
  mppAtCenter: number,
  cap: number = LINE_CAP_BUTT,
  join: number = LINE_JOIN_MITER,
  miterLimit: number = 4.0,
  dash: DashConfig | null = null,
  patterns: PatternSlot[] = [],
  offsetPx: number = 0,
): Float32Array {
  const buf = new Float32Array(LINE_UNIFORM_SIZE / 4)
  const u32 = new Uint32Array(buf.buffer)
  buf[0] = strokeColor[0]
  buf[1] = strokeColor[1]
  buf[2] = strokeColor[2]
  buf[3] = strokeColor[3] * opacity
  buf[4] = strokeWidthPx
  buf[5] = 1.5
  buf[6] = mppAtCenter
  buf[7] = miterLimit

  // Dash
  let dashCount = 0
  let dashCycle = 0
  let dashOffset = 0
  if (dash && dash.array.length >= 2) {
    dashCount = Math.min(dash.array.length, 8)
    if (dashCount & 1) dashCount--
    for (let i = 0; i < dashCount; i++) {
      buf[12 + i] = dash.array[i]
      dashCycle += dash.array[i]
    }
    dashOffset = dash.offset ?? 0
  }

  u32[8] = packFlags(cap, join, dashCount > 0)
  u32[9] = dashCount
  buf[10] = dashCycle
  buf[11] = dashOffset

  // Patterns (up to 3 slots at f32 offsets 20, 28, 36)
  for (let k = 0; k < PATTERN_SLOT_COUNT; k++) {
    const base = 20 + k * PATTERN_SLOT_F32
    const p = patterns[k]
    if (!p || p.shapeId <= 0) {
      u32[base] = 0
      continue
    }
    const spacingUnit = p.spacingUnit ?? PATTERN_UNIT_M
    const sizeUnit = p.sizeUnit ?? PATTERN_UNIT_M
    const offsetUnit = p.offsetUnit ?? PATTERN_UNIT_M
    const anchor = p.anchor ?? PATTERN_ANCHOR_REPEAT
    const flags =
      (spacingUnit & 3) |
      ((sizeUnit & 3) << 2) |
      ((offsetUnit & 3) << 4) |
      ((anchor & 3) << 6)
    u32[base + 0] = p.shapeId
    u32[base + 1] = flags
    buf[base + 2] = p.spacing
    buf[base + 3] = p.size
    buf[base + 4] = p.offset ?? 0
    buf[base + 5] = p.startOffset ?? 0
  }

  // Lateral parallel offset: DSL value in pixels → shader wants meters.
  buf[44] = offsetPx * mppAtCenter
  return buf
}

// ═══ Segment Buffer Layout ═══
// 40 bytes per segment. Phase 1: p0, p1 only. Later phases add prev/next tangents, arc_start, line_length.

// Stride is 12 f32 = 48 bytes. Fields:
//   [0-1]  p0 (vec2)
//   [2-3]  p1 (vec2)
//   [4-5]  prev_tangent (vec2)  — direction of prev seg arriving at p0 (zero = cap)
//   [6-7]  next_tangent (vec2)  — direction of next seg leaving p1 (zero = cap)
//   [8]    arc_start   (f32)
// DSFUN segment layout (stride 16 f32 = 64 bytes):
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
//
// The shader subtracts (p0_h - cam_h) + (p0_l - cam_l) to cancel tile-origin
// magnitude and recover camera-relative meters with f64-equivalent precision.
// Tangents stay single-f32 — they're unit vectors in a tile-local frame and
// don't suffer from cancellation.
export const LINE_SEGMENT_STRIDE_F32 = 16
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
  stride: 5 | 6 = 5,
  /** Tile width/height in Mercator METERS — used to detect chain ends that
   *  sit on a tile boundary and treat them as virtual joins (same-direction
   *  tangent) so the SDF shader emits no cap there. Adjacent tiles' segments
   *  meet at the boundary and the union forms a continuous stroke. Optional;
   *  when omitted, boundary detection is disabled. */
  tileWidthMerc: number = 0,
  tileHeightMerc: number = 0,
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

  // Build adjacency map: vertex_index → [segment_index, ...]
  const vertToSegs = new Map<number, number[]>()
  for (let i = 0; i < segCount; i++) {
    const a = indices[i * 2]
    const b = indices[i * 2 + 1]
    const sa = vertToSegs.get(a); if (sa) sa.push(i); else vertToSegs.set(a, [i])
    const sb = vertToSegs.get(b); if (sb) sb.push(i); else vertToSegs.set(b, [i])
  }

  // ── Arc-length pass ──
  // Stride-4: global arc-length is precomputed at tiling time in f64 Mercator
  // meters and stored at vertex[3]. Cross-tile phase continuity is automatic.
  // Stride-3 (polygon outlines): fall back to per-tile BFS chain traversal.
  const arcStart = new Float32Array(segCount)
  const arcTotal = new Float32Array(segCount)

  // Precompute segment lengths (used by stride-3 BFS path + for arcTotal)
  const segLen = new Float32Array(segCount)
  for (let i = 0; i < segCount; i++) {
    const a = indices[i * 2], b = indices[i * 2 + 1]
    const [ax, ay] = projVert(a)
    const [bx, by] = projVert(b)
    const dx = bx - ax, dy = by - ay
    segLen[i] = Math.sqrt(dx * dx + dy * dy)
  }

  if (stride >= 6) {
    // Global arc from vertex[5] (DSFUN stride 6 line features). Each
    // segment's arc_start = vertex[a].arc_start.
    for (let i = 0; i < segCount; i++) {
      const a = indices[i * 2]
      arcStart[i] = vertices[a * stride + 5]
    }
    // arcTotal left at 0 — patterns that need line_length will come in Phase 4.
  } else {

  const visited = new Uint8Array(segCount)
  for (let s0 = 0; s0 < segCount; s0++) {
    if (visited[s0]) continue

    // 1. BFS collect the whole connected chain
    const chain: number[] = []
    const stack = [s0]
    while (stack.length > 0) {
      const cur = stack.pop()!
      if (visited[cur]) continue
      visited[cur] = 1
      chain.push(cur)
      const a = indices[cur * 2], b = indices[cur * 2 + 1]
      const na = vertToSegs.get(a); if (na) for (const n of na) if (!visited[n]) stack.push(n)
      const nb = vertToSegs.get(b); if (nb) for (const n of nb) if (!visited[n]) stack.push(n)
    }

    // 2. Find an endpoint vertex (degree 1 in this chain) or any vertex for rings
    const inChain = new Set(chain)
    let startVert = -1
    let startSeg = chain[0]
    for (const s of chain) {
      for (const v of [indices[s * 2], indices[s * 2 + 1]]) {
        const neigh = vertToSegs.get(v)!
        let degInChain = 0
        for (const n of neigh) if (inChain.has(n)) degInChain++
        if (degInChain === 1) { startVert = v; startSeg = s; break }
      }
      if (startVert >= 0) break
    }
    if (startVert < 0) {
      // Closed ring — start anywhere
      startVert = indices[startSeg * 2]
    }

    // 3. Ordered walk from startSeg / startVert, assigning arcStart
    const walked = new Uint8Array(segCount)
    let cur = startSeg
    let fromV = startVert
    let acc = 0
    while (cur >= 0 && !walked[cur]) {
      walked[cur] = 1
      arcStart[cur] = acc
      acc += segLen[cur]
      const ca = indices[cur * 2], cb = indices[cur * 2 + 1]
      const nextV = (ca === fromV) ? cb : ca
      const neigh = vertToSegs.get(nextV)
      let next = -1
      if (neigh) {
        for (const n of neigh) {
          if (n !== cur && inChain.has(n) && !walked[n]) { next = n; break }
        }
      }
      if (next < 0) break
      cur = next
      fromV = nextV
    }
    for (const c of chain) arcTotal[c] = acc
  }
  } // end stride-3 BFS branch

  // ── Tile boundary detection ──
  // Returns true if a tile-local (mx, my in Mercator METERS relative to tile
  // SW corner) lies within `EPS_M` of any tile edge. Suppresses the visible
  // round/butt cap at every tile-clip boundary so adjacent tiles' segments
  // meet seamlessly. ~10m tolerance soaks up clipper float noise at any zoom.
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

    // Read DSFUN high/low directly from the vertex buffer so the segment
    // storage buffer stays lossless.
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

    // Layout: p0_h, p1_h, p0_l, p1_l, prev_tangent, next_tangent, arc, len, pads
    out[off + 0] = a_mxH
    out[off + 1] = a_myH
    out[off + 2] = b_mxH
    out[off + 3] = b_myH
    out[off + 4] = a_mxL
    out[off + 5] = a_myL
    out[off + 6] = b_mxL
    out[off + 7] = b_myL

    // Reconstructed f64-equivalent positions for tangent / pad math
    const p0x = a_mxH + a_mxL
    const p0y = a_myH + a_myL
    const p1x = b_mxH + b_mxL
    const p1y = b_myH + b_myL

    // Segment direction (tile-local Mercator meters), used both for the
    // boundary-fallback tangent and the miter pad ratio below.
    const segDxBuild = p1x - p0x
    const segDyBuild = p1y - p0y
    const segLenBuild = Math.hypot(segDxBuild, segDyBuild)
    const dxUnit = segLenBuild > 1e-9 ? segDxBuild / segLenBuild : 1
    const dyUnit = segLenBuild > 1e-9 ? segDyBuild / segLenBuild : 0

    // prev_tangent: find another segment sharing vertex a (p0 side)
    // The tangent is the direction OF THE PREVIOUS SEGMENT, pointing TOWARD vertex a.
    // So if prev has endpoints (pa → a), prev_tangent = normalize(a - pa).
    let prevTx = 0, prevTy = 0
    const neighborsA = vertToSegs.get(a)
    if (neighborsA && neighborsA.length > 1) {
      // Pick the first other segment
      for (const ns of neighborsA) {
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
    // Tile boundary fallback: if no neighbor found AND p0 sits on a tile
    // edge, treat it as a virtual straight-line continuation by reusing
    // the segment's own direction. The matching segment in the adjacent
    // tile will have the same fallback at its p1, so the two strokes
    // meet seamlessly with no cap.
    if (prevTx === 0 && prevTy === 0 && vertOnBoundary(a)) {
      prevTx = dxUnit; prevTy = dyUnit
    }
    out[off + 8] = prevTx
    out[off + 9] = prevTy

    // next_tangent: similar for vertex b (p1 side), pointing AWAY from b
    // next_tangent = normalize(nextOtherEnd - b)
    let nextTx = 0, nextTy = 0
    const neighborsB = vertToSegs.get(b)
    if (neighborsB && neighborsB.length > 1) {
      for (const ns of neighborsB) {
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
    if (nextTx === 0 && nextTy === 0 && vertOnBoundary(b)) {
      nextTx = dxUnit; nextTy = dyUnit
    }
    out[off + 10] = nextTx
    out[off + 11] = nextTy

    out[off + 12] = arcStart[i]
    out[off + 13] = arcTotal[i]

    // Miter pad ratios — bound the quad extension past each endpoint so we
    // don't pay worst-case `miter_limit × half_w` overdraw at every segment.
    // At p0: join is between `prev_tangent` (arriving) and current `dir` (leaving).
    out[off + 14] = computeMiterPadRatio([prevTx, prevTy], [dxUnit, dyUnit], DEFAULT_BUILD_MITER_LIMIT)
    // At p1: join is between current `dir` (arriving) and `next_tangent` (leaving).
    out[off + 15] = computeMiterPadRatio([dxUnit, dyUnit], [nextTx, nextTy], DEFAULT_BUILD_MITER_LIMIT)
  }
  return out
}

// ═══ WGSL Shader ═══
//
// Coordinate convention (matches VTR fill shader):
//   segment.p0/p1 are tile-local, where:
//     - x = lon_local * DEG2RAD * EARTH_R  (meters from tile west edge)
//     - y = merc_lat_local * EARTH_R       (meters from tile south edge in Mercator)
//   tile.tile_rtc.xy adds the offset from tile SW corner to camera center.
//   So world position (RTC) = p + tile.tile_rtc.xy.
//
// Width expansion happens in world space using a layer-level `mpp` value
// (meters per pixel at camera center). This keeps the shader simple and
// avoids per-fragment viewport-size math.

// ── Composite shader: fullscreen triangle sampling the offscreen RT ──
const COMPOSITE_SHADER = /* wgsl */ `
struct CompUniform { opacity: f32, _pad: vec3<f32> }
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var<uniform> cu: CompUniform;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vs_full(@builtin(vertex_index) vi: u32) -> VsOut {
  // Single triangle covering the viewport: (-1,-1) (3,-1) (-1,3)
  var p = vec2<f32>(-1.0, -1.0);
  var uv = vec2<f32>(0.0, 1.0);
  if (vi == 1u) { p = vec2<f32>( 3.0, -1.0); uv = vec2<f32>(2.0, 1.0); }
  if (vi == 2u) { p = vec2<f32>(-1.0,  3.0); uv = vec2<f32>(0.0, -1.0); }
  var out: VsOut;
  out.pos = vec4<f32>(p, 0.0, 1.0);
  out.uv = uv;
  return out;
}

@fragment
fn fs_full(in: VsOut) -> @location(0) vec4<f32> {
  let c = textureSample(src, samp, in.uv);
  // Pre-multiplied alpha output for use with standard alpha blending.
  return vec4<f32>(c.rgb * cu.opacity, c.a * cu.opacity);
}
`

const LINE_SHADER = /* wgsl */ `
struct TileUniforms {
  mvp: mat4x4<f32>,
  fill_color: vec4<f32>,
  stroke_color: vec4<f32>,
  proj_params: vec4<f32>,
  // DSFUN camera offset in tile-local Mercator meters, split high/low.
  cam_h: vec2<f32>,
  cam_l: vec2<f32>,
  tile_origin_merc: vec2<f32>,
  opacity: f32,
  // Log-depth factor: 1.0 / log2(cam_far + 1.0). Reuses the old DSFUN
  // _pad0 slot so the 144-byte uniform layout is unchanged.
  log_depth_fc: f32,
}
@group(0) @binding(0) var<uniform> tile: TileUniforms;

${WGSL_LOG_DEPTH_FNS}

struct PatternSlot {
  id: u32,
  flags: u32,
  spacing: f32,
  size: f32,
  offset: f32,
  start_offset: f32,
  _pad0: f32,
  _pad1: f32,
}

struct LineLayer {
  color: vec4<f32>,
  width_px: f32,
  aa_width_px: f32,
  mpp: f32,            // meters per pixel at camera center
  miter_limit: f32,
  // flags: cap(0-1) | join(2-3) | dash_enable(4)
  flags: u32,
  dash_count: u32,
  dash_cycle_m: f32,
  dash_offset_m: f32,
  dash_array: array<vec4<f32>, 2>,  // 8 floats, packed
  patterns: array<PatternSlot, 3>,
  offset_m: f32,        // lateral parallel offset (+left of travel)
  _pad_a: f32,
  _pad_b: f32,
  _pad_c: f32,
}
@group(1) @binding(0) var<uniform> layer: LineLayer;

const CAP_BUTT:   u32 = 0u;
const CAP_ROUND:  u32 = 1u;
const CAP_SQUARE: u32 = 2u;
const CAP_ARROW:  u32 = 3u;
const JOIN_MITER: u32 = 0u;
const JOIN_ROUND: u32 = 1u;
const JOIN_BEVEL: u32 = 2u;

const PAT_UNIT_M:  u32 = 0u;
const PAT_UNIT_PX: u32 = 1u;
const PAT_UNIT_KM: u32 = 2u;
const PAT_UNIT_NM: u32 = 3u;
const PAT_ANCHOR_REPEAT: u32 = 0u;
const PAT_ANCHOR_START:  u32 = 1u;
const PAT_ANCHOR_END:    u32 = 2u;
const PAT_ANCHOR_CENTER: u32 = 3u;

struct LineSegment {
  // DSFUN endpoint pairs in tile-local Mercator meters. The shader
  // subtracts (p0_h - cam_h) + (p0_l - cam_l) (and similarly for p1)
  // to reach camera-relative meters at f64-equivalent precision.
  p0_h: vec2<f32>,
  p1_h: vec2<f32>,
  p0_l: vec2<f32>,
  p1_l: vec2<f32>,
  prev_tangent: vec2<f32>,
  next_tangent: vec2<f32>,
  arc_start: f32,
  line_length: f32,
  // Per-endpoint quad pad ratios (multiples of half_w). Precomputed on CPU
  // using the current layer's miter limit so that straight / gentle joins
  // shrink from 4×half_w to just what miter geometry needs.
  pad_ratio_p0: f32,
  pad_ratio_p1: f32,
}
@group(1) @binding(1) var<storage, read> segments: array<LineSegment>;

${WGSL_SHAPE_STRUCTS}
@group(1) @binding(2) var<storage, read> shapes: array<ShapeDesc>;
@group(1) @binding(3) var<storage, read> shape_segments: array<ShapeSegment>;

${WGSL_DIST_TO_SEGMENT}
${WGSL_DIST_TO_QUADRATIC}
${WGSL_DIST_TO_CUBIC}
${WGSL_WINDING_LINE}

// Inlined SDF shape sampler — uses shape_segments (our binding 3) instead
// of the shared WGSL_SDF_SHAPE snippet's "segments" name (which would
// collide with the line segment storage buffer on binding 1).
fn sdf_shape(uv_in: vec2f, shape_id: u32) -> f32 {
  let uv = vec2f(uv_in.x, -uv_in.y);
  let s = shapes[shape_id];
  if (uv.x < s.bbox_min_x || uv.x > s.bbox_max_x ||
      uv.y < s.bbox_min_y || uv.y > s.bbox_max_y) {
    return 2.0;
  }
  var min_dist: f32 = 1e10;
  var winding: i32 = 0;
  let end = min(s.seg_start + s.seg_count, s.seg_start + 32u);
  for (var i = s.seg_start; i < end; i = i + 1u) {
    let seg = shape_segments[i];
    switch seg.kind {
      case 0u: {
        min_dist = min(min_dist, dist_to_segment(uv, seg.p0, seg.p1));
        winding = winding + winding_line(uv, seg.p0, seg.p1);
      }
      case 1u: {
        min_dist = min(min_dist, dist_to_quadratic(uv, seg.p0, seg.p1, seg.p2));
        winding = winding + winding_line(uv, seg.p0, seg.p2);
      }
      case 2u: {
        min_dist = min(min_dist, dist_to_cubic(uv, seg.p0, seg.p1, seg.p2, seg.p3));
        winding = winding + winding_line(uv, seg.p0, seg.p3);
      }
      default: {}
    }
  }
  if (winding != 0) { return 1.0 - min_dist; }
  return 1.0 + min_dist;
}

fn pattern_unit_to_m(v: f32, unit: u32, mpp: f32) -> f32 {
  if (unit == PAT_UNIT_M)  { return v; }
  if (unit == PAT_UNIT_PX) { return v * mpp; }
  if (unit == PAT_UNIT_KM) { return v * 1000.0; }
  return v * 1852.0; // nautical mile
}

struct LineOut {
  @builtin(position) position: vec4<f32>,
  @location(0) world_local: vec2<f32>,
  @location(1) @interpolate(flat) seg_id: u32,
  // view_w = pre-division clip-space w. Fragment recomputes log-depth
  // per pixel so long line segments don't drift in view-space.
  @location(2) view_w: f32,
}

struct LineFragmentOutput {
  @location(0) color: vec4<f32>,
  @builtin(frag_depth) depth: f32,
}

@vertex
fn vs_line(
  @builtin(instance_index) seg_id: u32,
  @builtin(vertex_index) vi: u32,
) -> LineOut {
  let seg = segments[seg_id];
  // DSFUN: reconstruct camera-relative p0/p1 in meters. The subtraction
  // (p0_h - cam_h) + (p0_l - cam_l) cancels the tile-origin magnitude and
  // preserves the small delta at full f64-equivalent precision.
  let p0 = (seg.p0_h - tile.cam_h) + (seg.p0_l - tile.cam_l);
  let p1 = (seg.p1_h - tile.cam_h) + (seg.p1_l - tile.cam_l);

  // Segment direction in tile-local space
  let seg_vec = p1 - p0;
  let seg_len = length(seg_vec);
  var dir: vec2<f32>;
  if (seg_len < 1e-6) {
    dir = vec2<f32>(1.0, 0.0);
  } else {
    dir = seg_vec / seg_len;
  }
  let nrm = vec2<f32>(-dir.y, dir.x);

  // Width in world meters (at camera center): width_px * mpp
  let half_w_m = (layer.width_px * 0.5 + layer.aa_width_px) * layer.mpp;

  // Per-endpoint pad precomputed on CPU. A straight joint gets 1×half_w (just
  // AA margin), a 90° miter gets ~1.41×half_w, and sharp joints that exceed
  // the miter limit also fall back to 1×half_w (bevel). This avoids paying
  // worst-case 4×half_w overdraw per segment.
  var pad_p0_m = seg.pad_ratio_p0 * half_w_m;
  var pad_p1_m = seg.pad_ratio_p1 * half_w_m;

  // Pattern extent: if any slot is active, expand both along and across so
  // that pattern instances near segment edges aren't clipped by the quad.
  var pat_extent_m = 0.0;
  for (var pk = 0u; pk < 3u; pk = pk + 1u) {
    let pat = layer.patterns[pk];
    if (pat.id == 0u) { continue; }
    let sz_unit = (pat.flags >> 2u) & 3u;
    let off_unit = (pat.flags >> 4u) & 3u;
    let size_m = pattern_unit_to_m(pat.size, sz_unit, layer.mpp);
    let off_m = abs(pattern_unit_to_m(pat.offset, off_unit, layer.mpp));
    pat_extent_m = max(pat_extent_m, size_m * 0.5 + off_m);
  }
  // Arrow cap extends 4×half_w past each endpoint.
  let cap_type_vs = layer.flags & 7u;
  let arrow_len = half_w_m * 4.0;
  var across_m = max(half_w_m, pat_extent_m);
  pad_p0_m = max(pad_p0_m, pat_extent_m);
  pad_p1_m = max(pad_p1_m, pat_extent_m);
  // Arrow caps only apply where there is no neighbor (prev/next_tangent zero).
  // Guard with length(seg.prev_tangent) checks so interior joins don't pay
  // the arrow cost.
  if (cap_type_vs == CAP_ARROW) {
    if (length(seg.prev_tangent) < 0.001) { pad_p0_m = max(pad_p0_m, arrow_len); }
    if (length(seg.next_tangent) < 0.001) { pad_p1_m = max(pad_p1_m, arrow_len); }
  }

  // 6-vert quad → 4 distinct corners: (start,-), (end,-), (end,+), (start,+).
  // At each corner we compute an explicit MITER offset from prev/next tangent
  // (or fall back to a perpendicular cap offset at chain termini). Adjacent
  // segments sharing an endpoint compute the identical offset, so their
  // outer vertices coincide — the rasterized quad union is the proper join
  // shape with no gap and no duplicated triangle.
  var along: f32 = 0.0;
  var across: f32 = 0.0;
  switch vi {
    case 0u: { along = -1.0; across = -1.0; }
    case 1u: { along =  1.0; across = -1.0; }
    case 2u: { along =  1.0; across =  1.0; }
    case 3u: { along = -1.0; across = -1.0; }
    case 4u: { along =  1.0; across =  1.0; }
    case 5u: { along = -1.0; across =  1.0; }
    default: {}
  }

  let is_start = along < 0.0;
  let base = select(p1, p0, is_start);
  let perp_cur = nrm * across; // outward perpendicular of current seg on this side

  // Neighbor tangents + has_prev/has_next flags
  let has_prev = length(seg.prev_tangent) > 0.001;
  let has_next = length(seg.next_tangent) > 0.001;
  let neighbor_tangent = select(seg.next_tangent, seg.prev_tangent, is_start);
  let has_neighbor = select(has_next, has_prev, is_start);

  // Join type (shared with fragment shader)
  let join_type_vs = (layer.flags >> 3u) & 3u;

  // Pattern scaling: quad needs to flare out proportionally when patterns
  // extend past half_w so stamps near the stroke edge aren't clipped.
  let across_scale = max(1.0, across_m / max(half_w_m, 1e-6));

  // Lateral parallel offset (stroke-offset-N): adds a signed shift along
  // the perpendicular. On the +left side (across=+1) the effective stroke
  // half-width grows by offset_m; on the -right side it shrinks. Applied
  // via the miter scalar so adjacent segments still share corner vertices.
  let half_w_side = half_w_m + layer.offset_m * across;

  // Simple perpendicular rectangle with half_w dir-padding at each end.
  //
  // Previously this computed a miter-extended vertex using the neighbor
  // tangent. That approach SELF-INTERSECTS for segments shorter than half_w
  // (common in low-resolution coastline data at low zoom), producing a
  // bow-tie quad whose two rasterization triangles overlap and shade
  // every pixel in the overlap region TWICE. With translucent strokes
  // this manifested as bright beads at every sharp corner.
  //
  // The simple rectangle is convex by construction (strictly no bow-tie),
  // overlaps between adjacent segments are handled by the fs_line
  // bisector half-plane clip, and the corner wedge is filled by the
  // round-join circle SDF (radius half_w) in fs_line. Sharp miter tips
  // are not supported by this geometry — miter tips are rendered by the
  // fragment shader's SDF intersection of both adjacent strips.
  var offset = perp_cur * half_w_side * across_scale;
  if (has_neighbor) {
    // Joined endpoint: pad along dir so there is geometry for the
    // fragment shader to shade the join on. For MITER joins, extend by
    // the precomputed pad_ratio so the quad covers the miter tip.
    // For ROUND/BEVEL, half_w_side is sufficient.
    var along_pad = half_w_side;
    if (join_type_vs == JOIN_MITER) {
      let endpoint_pad = select(pad_p1_m, pad_p0_m, is_start);
      along_pad = max(along_pad, endpoint_pad);
    }
    offset = offset + dir * along * along_pad * across_scale;
  } else {
    // Chain terminus: use the configured cap pad (butt/square/arrow).
    let endpoint_pad = select(pad_p1_m, pad_p0_m, is_start);
    offset = offset + dir * along * endpoint_pad;
  }

  let corner_local = base + offset;

  // corner_local is already in camera-relative meters: p0 and p1 were
  // DSFUN-reconstructed camera-relative, and offset is a small stroke-scale
  // displacement in the same frame. No separate RTC add is needed.

  var out: LineOut;
  let clip = tile.mvp * vec4<f32>(corner_local, 0.0, 1.0);
  out.position = apply_log_depth(clip, tile.log_depth_fc);
  out.view_w = clip.w;
  out.world_local = corner_local; // interpolated across the quad
  out.seg_id = seg_id;
  return out;
}

// ── Cap + Join helpers (Phase 2) ──

// Distance to a half-plane defined by a point and an outward normal.
// d_plane > 0 means the fragment is on the outside (to be clipped or capped).
fn plane_signed(p: vec2<f32>, origin: vec2<f32>, outward_nrm: vec2<f32>) -> f32 {
  return dot(p - origin, outward_nrm);
}

// Core line SDF + color math. Shared by two entry points:
//   - fs_line: standard path, writes @builtin(frag_depth) so log-depth
//              matches the vector-tile + raster passes into the same
//              main depth target.
//   - fs_line_max: translucent offscreen path. Its render target has no
//              depth attachment, so writing frag_depth there is a
//              validation error. This path returns plain color only.
fn compute_line_color(in: LineOut) -> vec4<f32> {
  let seg = segments[in.seg_id];
  let p = in.world_local;
  // DSFUN reconstruct p0/p1 in camera-relative meters (same frame as p).
  let p0 = (seg.p0_h - tile.cam_h) + (seg.p0_l - tile.cam_l);
  let p1 = (seg.p1_h - tile.cam_h) + (seg.p1_l - tile.cam_l);

  // Segment direction/normal in tile-local meters
  let seg_vec = p1 - p0;
  let seg_len = length(seg_vec);
  var dir: vec2<f32>;
  if (seg_len < 1e-6) {
    dir = vec2<f32>(1.0, 0.0);
  } else {
    dir = seg_vec / seg_len;
  }

  let half_w_m = layer.width_px * 0.5 * layer.mpp;

  // ── 1. Main body distance (pixels) ──
  // Signed perpendicular distance (+left of travel). With a parallel offset
  // the stroke centerline is shifted to signed_perp == offset_m, so the
  // body SDF measures |signed_perp - offset_m|.
  let nrm_line = vec2<f32>(-dir.y, dir.x);
  let signed_perp = dot(p - p0, nrm_line);
  let perp_m = abs(signed_perp - layer.offset_m);
  let body_d = perp_m - half_w_m;

  // Offset-shifted endpoint centers used by round caps / round joins.
  // For a CAP (chain end, no neighbor) the simple perp shift is correct.
  // For a JOIN the two adjacent offset centerlines meet at the OFFSET MITER
  // VERTEX, not at the perp-shifted endpoint — both adjacent segments must
  // compute the same join center for their round circles to coincide.
  // Bare cap centers (used by !has_prev / !has_next branches below):
  let p0_cap_center = p0 + nrm_line * layer.offset_m;
  let p1_cap_center = p1 + nrm_line * layer.offset_m;

  // Offset miter vertices (used by has_prev / has_next round-join branches).
  // Standard miter formula applied to offset_m instead of half_w.
  let nrm_prev_off = vec2<f32>(-seg.prev_tangent.y, seg.prev_tangent.x);
  let miter_vec_p0 = nrm_line + nrm_prev_off;
  let proj_p0 = dot(miter_vec_p0, nrm_line);
  let p0_join_center = p0 + miter_vec_p0 * (layer.offset_m / max(proj_p0, 1e-4));

  let nrm_next_off = vec2<f32>(-seg.next_tangent.y, seg.next_tangent.x);
  let miter_vec_p1 = nrm_line + nrm_next_off;
  let proj_p1 = dot(miter_vec_p1, nrm_line);
  let p1_join_center = p1 + miter_vec_p1 * (layer.offset_m / max(proj_p1, 1e-4));

  // Clip planes at endpoints — shared by early discard and cap/join logic below.
  let dist_p0_vs = -dot(p - p0, dir);
  let dist_p1_vs =  dot(p - p1, dir);

  // ── Early fragment discard ──
  // Quads are padded by the worst-case miter/pattern/arrow extent. Fragments
  // that fall clearly OUTSIDE the stroke body AND inside the segment range
  // (no cap/join needed) contribute nothing — skip the full ~90-branch body
  // below. Keeps the body, caps, joins, dashes, and patterns all intact.
  var pat_extent_fs = 0.0;
  for (var pk_fs = 0u; pk_fs < 3u; pk_fs = pk_fs + 1u) {
    let pat_fs = layer.patterns[pk_fs];
    if (pat_fs.id == 0u) { continue; }
    let sz_unit_fs = (pat_fs.flags >> 2u) & 3u;
    let off_unit_fs = (pat_fs.flags >> 4u) & 3u;
    let size_m_fs = pattern_unit_to_m(pat_fs.size, sz_unit_fs, layer.mpp);
    let off_m_fs = abs(pattern_unit_to_m(pat_fs.offset, off_unit_fs, layer.mpp));
    pat_extent_fs = max(pat_extent_fs, size_m_fs * 0.5 + off_m_fs);
  }
  let aa_margin_m = 2.0 * layer.aa_width_px * layer.mpp;
  let early_perp_thresh = max(half_w_m, pat_extent_fs) + aa_margin_m;
  if (perp_m > early_perp_thresh && dist_p0_vs < 0.0 && dist_p1_vs < 0.0) {
    discard;
  }

  // ── 2. Cap at p0 (has_prev == false) ──
  // The p0 cap acts only when this segment is a line START (no prev tangent).
  // has_prev == false when prev_tangent is zero.
  let has_prev = length(seg.prev_tangent) > 0.001;
  let has_next = length(seg.next_tangent) > 0.001;
  let cap_type = layer.flags & 7u;
  let arrow_L = half_w_m * 4.0;

  // Clip planes at endpoints (already computed above for early-discard).
  let dist_p0 = dist_p0_vs;
  let dist_p1 = dist_p1_vs;

  var d_m = body_d;

  // ── Bisector clip at joined endpoints ──
  // At every join the segment body is constrained to the HALF-PLANE on
  // its own side of the forward bisector. The adjacent segment clips to
  // the OPPOSITE side so the two meet exactly at the bisector plane and
  // don't re-cover each other's pixels. Without this clip, the vertex-
  // level miter geometry produces overlapping quads whenever consecutive
  // segments are short relative to the stroke width (dense polyline data
  // at low zoom) — and every overlap pixel accumulates alpha, making
  // translucent strokes visibly brighter at sharp corners.
  //
  // For MITER joins, the body SDF naturally extends past the join vertex
  // into the miter tip area. The bisector splits ownership so each segment
  // renders its half of the miter diamond. The vertex-shader quad extension
  // (pad_ratio × half_w) ensures geometry coverage.
  //
  // For BEVEL joins, a bevel-edge clip is added on top of the bisector
  // clip. This truncates the miter tip at the straight line connecting
  // the two outer stroke corners, producing the flat bevel shape.
  let join_flags = (layer.flags >> 3u) & 3u;
  if (has_prev) {
    let bis_p0 = seg.prev_tangent + dir;
    let bis_len_p0 = length(bis_p0);
    if (bis_len_p0 > 1e-6) {
      let bis_unit_p0 = bis_p0 / bis_len_p0;
      let along_p0 = dot(p - p0, bis_unit_p0);
      // Only clip when on the WRONG side of the bisector (prev's territory).
      // Gating with an if avoids pulling d_m toward zero on MY side near
      // the bisector plane, which would reduce alpha and create visible
      // brightness discontinuities when the adjacent segment draws with
      // full coverage on the other side.
      if (along_p0 < 0.0) {
        d_m = max(d_m, -along_p0);
      }
    }
    // Bevel-edge clip at p0: truncate the body at the bevel edge so the
    // miter tip is cut flat. The bevel edge connects the outer stroke
    // corners of the two segments meeting at this vertex.
    if (join_flags == JOIN_BEVEL) {
      let prev_nrm = vec2<f32>(-seg.prev_tangent.y, seg.prev_tangent.x);
      let cross_p0 = seg.prev_tangent.x * dir.y - seg.prev_tangent.y * dir.x;
      if (abs(cross_p0) > 1e-6) {
        let s0 = -sign(cross_p0);
        let oc0 = p0 + prev_nrm * (layer.offset_m + half_w_m * s0);
        let on0 = p0 + nrm_line * (layer.offset_m + half_w_m * s0);
        let be0 = on0 - oc0;
        let bl0 = length(be0);
        if (bl0 > 1e-6) {
          let bd0 = be0 / bl0;
          let bo0 = vec2<f32>(-bd0.y, bd0.x) * s0;
          let bclip0 = dot(p - oc0, bo0);
          if (bclip0 > 0.0) {
            d_m = max(d_m, bclip0);
          }
        }
      }
    }
  }
  if (has_next) {
    let bis_p1 = dir + seg.next_tangent;
    let bis_len_p1 = length(bis_p1);
    if (bis_len_p1 > 1e-6) {
      let bis_unit_p1 = bis_p1 / bis_len_p1;
      let along_p1 = dot(p - p1, bis_unit_p1);
      if (along_p1 > 0.0) {
        d_m = max(d_m, along_p1);
      }
    }
    // Bevel-edge clip at p1 (symmetric with p0).
    if (join_flags == JOIN_BEVEL) {
      let next_nrm_bv = vec2<f32>(-seg.next_tangent.y, seg.next_tangent.x);
      let cross_p1 = dir.x * seg.next_tangent.y - dir.y * seg.next_tangent.x;
      if (abs(cross_p1) > 1e-6) {
        let s1 = -sign(cross_p1);
        let oc1 = p1 + nrm_line * (layer.offset_m + half_w_m * s1);
        let on1 = p1 + next_nrm_bv * (layer.offset_m + half_w_m * s1);
        let be1 = on1 - oc1;
        let bl1 = length(be1);
        if (bl1 > 1e-6) {
          let bd1 = be1 / bl1;
          let bo1 = vec2<f32>(-bd1.y, bd1.x) * s1;
          let bclip1 = dot(p - oc1, bo1);
          if (bclip1 > 0.0) {
            d_m = max(d_m, bclip1);
          }
        }
      }
    }
  }

  // ── Handle p0 end (cap or join) ──
  if (!has_prev) {
    // CAP at p0
    if (cap_type == CAP_BUTT) {
      d_m = max(d_m, dist_p0);
    } else if (cap_type == CAP_SQUARE) {
      d_m = max(d_m, dist_p0 - half_w_m);
    } else if (cap_type == CAP_ARROW) {
      // Analytical arrow: fragments past p0 (along -dir) use a tapered
      // half-width = half_w * (1 - dist_p0/arrow_L), clipped at arrow_L.
      if (dist_p0 > 0.0) {
        let t = clamp(dist_p0 / arrow_L, 0.0, 1.0);
        let new_w = half_w_m * (1.0 - t);
        d_m = max(perp_m - new_w, dist_p0 - arrow_L);
      }
    } else { // CAP_ROUND
      let circle_d = length(p - p0_cap_center) - half_w_m;
      d_m = select(d_m, circle_d, dist_p0 > 0.0);
    }
  } else {
    // JOIN at p0. For round joins, draw a circle overlay that fills the
    // corner wedge. Gate by the forward-bisector side so each segment
    // only draws its own half of the circle — the other half is drawn
    // by the prev segment at its p1 join. Without this gate, both
    // segments draw the full circle at the corner and alpha accumulates
    // on translucent strokes (the bright beads the user reported).
    let join_type = (layer.flags >> 3u) & 3u;
    if (join_type == JOIN_ROUND && dist_p0 > 0.0) {
      let bis_p0_j = seg.prev_tangent + dir;
      let bis_len_j = length(bis_p0_j);
      if (bis_len_j > 1e-6) {
        let bis_unit_j = bis_p0_j / bis_len_j;
        let along_j = dot(p - p0, bis_unit_j);
        // Current owns along > 0 (strict) so the bisector plane (along==0)
        // is drawn by exactly one segment, never both.
        if (along_j > 0.0) {
          let circle_d = length(p - p0_join_center) - half_w_m;
          d_m = min(d_m, circle_d);
        }
      }
    }
  }

  // ── Handle p1 end (cap or join) — symmetric ──
  if (!has_next) {
    if (cap_type == CAP_BUTT) {
      d_m = max(d_m, dist_p1);
    } else if (cap_type == CAP_SQUARE) {
      d_m = max(d_m, dist_p1 - half_w_m);
    } else if (cap_type == CAP_ARROW) {
      if (dist_p1 > 0.0) {
        let t = clamp(dist_p1 / arrow_L, 0.0, 1.0);
        let new_w = half_w_m * (1.0 - t);
        d_m = max(perp_m - new_w, dist_p1 - arrow_L);
      }
    } else { // CAP_ROUND
      let circle_d = length(p - p1_cap_center) - half_w_m;
      d_m = select(d_m, circle_d, dist_p1 > 0.0);
    }
  } else {
    // JOIN at p1 — symmetric with p0. Draw the circle only on the
    // current segment's side (along_p1 <= 0) so the next segment handles
    // the other half of the corner.
    let join_type_p1 = (layer.flags >> 3u) & 3u;
    if (join_type_p1 == JOIN_ROUND && dist_p1 > 0.0) {
      let bis_p1_j = dir + seg.next_tangent;
      let bis_len_j = length(bis_p1_j);
      if (bis_len_j > 1e-6) {
        let bis_unit_j = bis_p1_j / bis_len_j;
        let along_j = dot(p - p1, bis_unit_j);
        // Current segment owns along < 0 (strict). The bisector plane
        // is owned by the NEXT segment via its p0 (along > 0) check.
        if (along_j < 0.0) {
          let circle_d = length(p - p1_join_center) - half_w_m;
          d_m = min(d_m, circle_d);
        }
      }
    }
    // Note: MITER joins need no additional SDF here. The body SDF extends
    // past the endpoint, and the bisector clip (above) splits ownership
    // between adjacent segments. Each segment renders its half of the
    // miter diamond via its own body. The vertex-shader quad extension
    // (pad_ratio × half_w) ensures geometry coverage for the tip.
    //
    // BEVEL joins are handled by the bevel-edge clip in the bisector
    // section (above), which truncates the miter tip at the bevel edge.
  }

  // Project fragment onto segment's along-axis to get local arc (shared by dash + patterns)
  let t_along_unclamped = dot(p - p0, dir);
  let t_along = clamp(t_along_unclamped, 0.0, seg_len);
  let arc_pos = seg.arc_start + t_along;
  let nrm_fs = vec2<f32>(-dir.y, dir.x);

  // ── Dash array ──
  if ((((layer.flags >> 5u) & 1u) == 1u) && (layer.dash_count > 0u) && (layer.dash_cycle_m > 1e-6)) {
    var phase = (arc_pos + layer.dash_offset_m) / layer.dash_cycle_m;
    phase = (phase - floor(phase)) * layer.dash_cycle_m;

    var acc = 0.0;
    var visible = false;
    for (var i: u32 = 0u; i < layer.dash_count; i = i + 1u) {
      let idx = i / 4u;
      let sub = i % 4u;
      var seg_v = layer.dash_array[idx];
      var len: f32 = 0.0;
      if (sub == 0u) { len = seg_v.x; }
      else if (sub == 1u) { len = seg_v.y; }
      else if (sub == 2u) { len = seg_v.z; }
      else { len = seg_v.w; }
      if (phase >= acc && phase < acc + len) {
        visible = (i & 1u) == 0u;
        break;
      }
      acc = acc + len;
    }
    if (!visible) { discard; }
  }

  // ── Pattern stack ──
  // For each active slot, find the nearest pattern instance center along the
  // arc, then sample sdf_shape in that instance's local (-1..1) uv frame.
  // The minimum of all pattern SDFs is unioned with the line body.
  var pat_d_m: f32 = 1e10;
  for (var k: u32 = 0u; k < 3u; k = k + 1u) {
    let pat = layer.patterns[k];
    if (pat.id == 0u) { continue; }

    let sp_unit = pat.flags & 3u;
    let sz_unit = (pat.flags >> 2u) & 3u;
    let of_unit = (pat.flags >> 4u) & 3u;
    let anchor = (pat.flags >> 6u) & 3u;
    let spacing_m = max(pattern_unit_to_m(pat.spacing, sp_unit, layer.mpp), 1e-3);
    let size_m = max(pattern_unit_to_m(pat.size, sz_unit, layer.mpp), 1e-3);
    let off_m = pattern_unit_to_m(pat.offset, of_unit, layer.mpp);
    let start_m = pat.start_offset;
    let half_s = size_m * 0.5;

    if (anchor == PAT_ANCHOR_REPEAT) {
      // Sample the nearest instance plus both neighbors so that size > spacing
      // overlap works correctly (union of adjacent SDFs). Early-outs via the
      // arc-range and |local| checks keep cost ~1x for the common case
      // size << spacing, because dk=-1/+1 trivially continue.
      let k_center = floor((arc_pos - start_m) / spacing_m + 0.5);
      for (var dk: i32 = -1; dk <= 1; dk = dk + 1) {
        let center_arc_k = (k_center + f32(dk)) * spacing_m + start_m;
        let arc_on_seg_k = center_arc_k - seg.arc_start;
        if (arc_on_seg_k < -half_s * 2.0 || arc_on_seg_k > seg_len + half_s * 2.0) { continue; }
        let center_world_k = p0 + dir * arc_on_seg_k;
        let local_k = vec2<f32>(
          dot(p - center_world_k, dir) / half_s,
          (dot(p - center_world_k, nrm_fs) - off_m) / half_s,
        );
        if (abs(local_k.x) > 1.2 || abs(local_k.y) > 1.2) { continue; }
        let shape_v_k = sdf_shape(local_k, pat.id - 1u);
        let pd_k = (shape_v_k - 1.0) * half_s;
        pat_d_m = min(pat_d_m, pd_k);
      }
      continue;
    }

    // START / END / CENTER — single instance
    var center_arc: f32;
    if (anchor == PAT_ANCHOR_START) {
      center_arc = start_m;
    } else if (anchor == PAT_ANCHOR_END) {
      center_arc = seg.line_length - start_m;
    } else {
      center_arc = seg.line_length * 0.5;
    }

    // Transform to segment-local coords
    let arc_on_seg = center_arc - seg.arc_start;
    if (arc_on_seg < -half_s * 2.0 || arc_on_seg > seg_len + half_s * 2.0) { continue; }
    let center_world = p0 + dir * arc_on_seg;
    let local = vec2<f32>(
      dot(p - center_world, dir) / half_s,
      (dot(p - center_world, nrm_fs) - off_m) / half_s,
    );
    if (abs(local.x) > 1.2 || abs(local.y) > 1.2) { continue; }

    // sdf_shape returns normalized distance (1.0 = edge). Convert to meters.
    let shape_v = sdf_shape(local, pat.id - 1u);
    let pd = (shape_v - 1.0) * half_s;
    pat_d_m = min(pat_d_m, pd);
  }
  if (pat_d_m < 1e9) { d_m = min(d_m, pat_d_m); }

  // Convert to pixels
  let d_px = d_m / layer.mpp;
  let aa = 1.0;
  let alpha = 1.0 - smoothstep(-aa, aa, d_px);
  if (alpha < 0.005) { discard; }
  return vec4<f32>(layer.color.rgb, layer.color.a * alpha);
}

@fragment
fn fs_line(in: LineOut) -> LineFragmentOutput {
  var out: LineFragmentOutput;
  out.color = compute_line_color(in);
  out.depth = compute_log_frag_depth(in.view_w, tile.log_depth_fc);
  return out;
}

// Max-blend path: targets an offscreen color-only attachment (no depth).
// Writing @builtin(frag_depth) here trips WebGPU's "shader writes frag
// depth but no depth texture set" validation, so this entry point skips
// log-depth entirely — the translucent pass composites over the main
// framebuffer later, so its depth values would be discarded anyway.
@fragment
fn fs_line_max(in: LineOut) -> @location(0) vec4<f32> {
  return compute_line_color(in);
}
`

// ═══ Renderer ═══

export class LineRenderer {
  private static readonly LAYER_SLOT = 256
  private device: GPUDevice
  private format: GPUTextureFormat
  /** Standard alpha-blend pipeline — used for opaque line draws. */
  private pipeline: GPURenderPipeline
  /** Max-blend pipeline — used for translucent line draws into the offscreen
   *  RT. Max blending eliminates within-layer alpha accumulation at corner
   *  overlaps and self-intersections. */
  private pipelineMax!: GPURenderPipeline
  private tileBindGroupLayout: GPUBindGroupLayout
  private layerBindGroupLayout: GPUBindGroupLayout
  private shapeRegistry: ShapeRegistry | null = null
  /** Deduped warnings for bad pattern parameter combos. Key: stable string
   *  describing the violation. Survives per LineRenderer instance — reset on
   *  demo reload (new instance). */
  private patternWarnings = new Set<string>()
  private emptyShapeBuffer: GPUBuffer
  // Dynamic-offset layer uniform ring (shared across all VTR sources/layers)
  private layerRing!: GPUBuffer
  private layerRingCapacity = 512
  private layerSlot = 0

  // ── Translucent line offscreen + composite ──
  /** Single-sample offscreen RT used to render translucent line layers
   *  with max blending. Composited onto the main framebuffer with per-layer
   *  alpha. Lazily allocated + resized on demand. */
  private offscreenTexture: GPUTexture | null = null
  private offscreenView: GPUTextureView | null = null
  private offscreenWidth = 0
  private offscreenHeight = 0
  private offscreenSampler!: GPUSampler
  private compositePipeline!: GPURenderPipeline
  private compositeBindGroupLayout!: GPUBindGroupLayout
  private compositeBindGroup: GPUBindGroup | null = null
  /** Composite uniform buffer — single f32 (opacity). 16-byte aligned. */
  private compositeUniformBuffer!: GPUBuffer

  constructor(ctx: GPUContext, vtrTileBindGroupLayout: GPUBindGroupLayout) {
    this.device = ctx.device
    this.format = ctx.format
    this.tileBindGroupLayout = vtrTileBindGroupLayout

    this.layerBindGroupLayout = this.device.createBindGroupLayout({
      label: 'line-layer-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    })

    // Layer uniform ring. 256-byte slots → dynamic offsets prevent
    // multi-layer writeBuffer clobbering within a single frame.
    this.layerRing = this.device.createBuffer({
      size: this.layerRingCapacity * LineRenderer.LAYER_SLOT,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'line-layer-ring',
    })

    this.emptyShapeBuffer = this.device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.STORAGE,
      label: 'line-empty-shape-buf',
    })

    const module = this.device.createShaderModule({ code: LINE_SHADER, label: 'line-shader' })

    const linePipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.tileBindGroupLayout, this.layerBindGroupLayout],
    })

    this.pipeline = this.device.createRenderPipeline({
      label: 'line-pipeline',
      layout: linePipelineLayout,
      vertex: { module, entryPoint: 'vs_line' },
      fragment: {
        module,
        entryPoint: 'fs_line',
        targets: [{ format: this.format, blend: BLEND_ALPHA }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: STENCIL_DISABLED,
      multisample: MSAA_4X,
    })

    // MAX-blend variant: same shader, different blend op + NO MSAA + NO depth-stencil.
    // Targets the single-sample offscreen RT used for translucent compositing.
    // Uses fs_line_max (not fs_line) because the offscreen target has no
    // depth attachment — writing @builtin(frag_depth) would trip the
    // "shader writes frag depth but no depth texture set" validation.
    this.pipelineMax = this.device.createRenderPipeline({
      label: 'line-pipeline-max',
      layout: linePipelineLayout,
      vertex: { module, entryPoint: 'vs_line' },
      fragment: {
        module,
        entryPoint: 'fs_line_max',
        targets: [{ format: this.format, blend: BLEND_MAX }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    })

    // ── Composite pipeline ──
    this.compositeBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    })
    const compositeModule = this.device.createShaderModule({ code: COMPOSITE_SHADER, label: 'line-composite' })
    this.compositePipeline = this.device.createRenderPipeline({
      label: 'line-composite-pipeline',
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.compositeBindGroupLayout] }),
      vertex: { module: compositeModule, entryPoint: 'vs_full' },
      fragment: {
        module: compositeModule,
        entryPoint: 'fs_full',
        targets: [{ format: this.format, blend: BLEND_ALPHA }],
      },
      primitive: { topology: 'triangle-list' },
      multisample: MSAA_4X,
    })
    this.offscreenSampler = this.device.createSampler({
      magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
    })
    this.compositeUniformBuffer = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'line-composite-uniform',
    })
  }

  /** Lazily allocate / resize the offscreen RT to match the main color target. */
  ensureOffscreen(width: number, height: number): void {
    if (this.offscreenTexture && this.offscreenWidth === width && this.offscreenHeight === height) return
    this.offscreenTexture?.destroy()
    this.offscreenTexture = this.device.createTexture({
      size: { width, height },
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      label: 'line-translucent-offscreen',
    })
    this.offscreenView = this.offscreenTexture.createView()
    this.offscreenWidth = width
    this.offscreenHeight = height
    this.compositeBindGroup = this.device.createBindGroup({
      layout: this.compositeBindGroupLayout,
      entries: [
        { binding: 0, resource: this.offscreenSampler },
        { binding: 1, resource: this.offscreenView },
        { binding: 2, resource: { buffer: this.compositeUniformBuffer } },
      ],
    })
  }

  /** Begin a translucent line render pass against the offscreen RT. */
  beginTranslucentPass(encoder: GPUCommandEncoder): GPURenderPassEncoder {
    if (!this.offscreenView) throw new Error('LineRenderer: offscreen not initialised')
    return encoder.beginRenderPass({
      label: 'line-translucent-pass',
      colorAttachments: [{
        view: this.offscreenView,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    })
  }

  /** Composite the offscreen RT onto a main render pass with the given opacity. */
  composite(mainPass: GPURenderPassEncoder, opacity: number): void {
    if (!this.compositeBindGroup) return
    this.device.queue.writeBuffer(this.compositeUniformBuffer, 0, new Float32Array([opacity, 0, 0, 0]))
    mainPass.setPipeline(this.compositePipeline)
    mainPass.setBindGroup(0, this.compositeBindGroup)
    mainPass.draw(3, 1)
  }

  /** Used by VTR to pick the right pipeline depending on whether the
   *  current pass is the offscreen translucent pass. */
  getDrawPipeline(translucent: boolean): GPURenderPipeline {
    return translucent ? this.pipelineMax : this.pipeline
  }

  setShapeRegistry(registry: ShapeRegistry): void {
    this.shapeRegistry = registry
  }

  /** Upload segment data and return a GPU buffer. Caller owns destruction. */
  uploadSegmentBuffer(segments: Float32Array): GPUBuffer {
    const size = Math.max(segments.byteLength, LINE_SEGMENT_STRIDE_BYTES)
    const buf = this.device.createBuffer({
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: 'line-segments',
    })
    this.device.queue.writeBuffer(buf, 0, segments)
    return buf
  }

  /** Reset the layer ring slot cursor. Call once per frame. */
  beginFrame(): void {
    this.layerSlot = 0
  }

  /**
   * Allocate a slot and write layer uniform data. Returns byte offset to
   * pass as the dynamic offset in `drawSegments`.
   */
  writeLayerSlot(
    strokeColor: [number, number, number, number],
    strokeWidthPx: number,
    opacity: number,
    mppAtCenter: number,
    cap: number = LINE_CAP_BUTT,
    join: number = LINE_JOIN_MITER,
    miterLimit: number = 4.0,
    dash: DashConfig | null = null,
    patterns: PatternSlot[] = [],
    offsetPx: number = 0,
  ): number {
    // Pattern sanity checks (deduped, one warning per condition per
    // LineRenderer instance). Runs on the parameter set BEFORE packing so
    // that bogus values are flagged even if the GPU silently renders them.
    checkPatternParams(patterns, mppAtCenter, (k, m) => this.warnOnce(k, m))

    if (this.layerSlot >= this.layerRingCapacity) {
      console.warn('[LineRenderer] layer ring overflow — capping at capacity; style bleed possible')
      return (this.layerRingCapacity - 1) * LineRenderer.LAYER_SLOT
    }
    const off = this.layerSlot * LineRenderer.LAYER_SLOT
    this.layerSlot++
    const data = packLineLayerUniform(
      strokeColor, strokeWidthPx, opacity, mppAtCenter,
      cap, join, miterLimit, dash, patterns, offsetPx,
    )
    this.device.queue.writeBuffer(this.layerRing, off, data)
    return off
  }

  /** Emit a warning once per (stable) key for the lifetime of this renderer. */
  private warnOnce(key: string, msg: string): void {
    if (this.patternWarnings.has(key)) return
    this.patternWarnings.add(key)
    console.warn(msg)
  }

  /**
   * Look up a shape name in the registry.
   * Returns the 1-based ID (0 = unknown/inactive) that goes straight into
   * PatternSlot.shapeId. The shader will call sdf_shape(uv, id - 1u).
   */
  resolveShapeId(name: string): number {
    return this.shapeRegistry?.getShapeId(name) ?? 0
  }

  /** Create a bind group for the line layer + segments + shape registry.
   *  Binding 0 uses a dynamic offset — actual slot is chosen at draw time. */
  createLayerBindGroup(segmentBuffer: GPUBuffer): GPUBindGroup {
    const shapeBuf = this.shapeRegistry?.shapeBuffer ?? this.emptyShapeBuffer
    const shapeSegBuf = this.shapeRegistry?.segmentBuffer ?? this.emptyShapeBuffer
    return this.device.createBindGroup({
      layout: this.layerBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.layerRing, offset: 0, size: LINE_UNIFORM_SIZE } },
        { binding: 1, resource: { buffer: segmentBuffer } },
        { binding: 2, resource: { buffer: shapeBuf } },
        { binding: 3, resource: { buffer: shapeSegBuf } },
      ],
    })
  }

  /**
   * Draw instanced quads for line segments.
   * `tileOffset` and `layerOffset` are the dynamic byte offsets returned from
   * each ring's allocator for this draw.
   */
  drawSegments(
    pass: GPURenderPassEncoder,
    tileBindGroup: GPUBindGroup,
    layerBindGroup: GPUBindGroup,
    segmentCount: number,
    tileOffset: number,
    layerOffset: number,
    translucent: boolean = false,
  ): void {
    if (segmentCount === 0) return
    pass.setPipeline(translucent ? this.pipelineMax : this.pipeline)
    pass.setBindGroup(0, tileBindGroup, [tileOffset])
    pass.setBindGroup(1, layerBindGroup, [layerOffset])
    pass.draw(6, segmentCount)
  }

  clearLayers(): void {
    // no-op: per-tile buffers are owned by VTR
  }
}
