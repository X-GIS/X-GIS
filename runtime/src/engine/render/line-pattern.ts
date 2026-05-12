// SDF line pattern + dash configuration — extracted from line-renderer.ts
// so the constants, types, and pure-math packing helpers (which tests
// reach into without instantiating a GPU device) live separate from the
// 1700-line renderer class. line-renderer.ts re-exports the public
// surface so existing imports keep working.

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
//   [45]    viewport_height          — screen height in pixels
//   [46-47] pad×2                    — 16-byte alignment
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

/** Feature-present bit masks for the layer uniform's `flags` word. The
 *  fragment shader gates its optional work (pattern stack, offset join
 *  math) on these so simple stroke layers — the common case on mobile —
 *  don't pay for code paths that contribute nothing to the output. Bit
 *  layout mirrored in the WGSL preamble's LINE_FLAG_* constants so the
 *  TS and GPU sides stay in sync. */
export const LINE_FLAG_HAS_PATTERN = 1 << 6
export const LINE_FLAG_HAS_OFFSET = 1 << 7

/** Pack flags word for the layer uniform.
 *  Bit layout:
 *    bits 0-2: cap (butt/round/square/arrow) — 3 bits
 *    bits 3-4: join (miter/round/bevel)
 *    bit 5:    dash_enable
 *    bit 6:    has_pattern (any of patterns[k].shapeId > 0)
 *    bit 7:    has_offset  (abs offset_m > 0) */
function packFlags(
  cap: number,
  join: number,
  dashEnable: boolean,
  hasPattern: boolean,
  hasOffset: boolean,
): number {
  return (cap & 7) |
    ((join & 3) << 3) |
    (dashEnable ? 1 << 5 : 0) |
    (hasPattern ? LINE_FLAG_HAS_PATTERN : 0) |
    (hasOffset ? LINE_FLAG_HAS_OFFSET : 0)
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
 *    (a) size > 2 × spacing — shader only samples ±1 neighbor, so beyond
 *        2× spacing the pattern under-shades. Warn: "size-gt-2x-spacing".
 *    (b) spacing_m / mpp < 1 — pattern spacing collapses to sub-pixel at
 *        current zoom, visually disappearing. Warn: "subpixel". */
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

/** Pack layer uniform data into a Float32Array for upload. The layout
 *  is documented at the top of this file; the 192-byte struct is
 *  ABI-coupled to WGSL `LineLayerUniform` and any field reordering must
 *  happen here AND in the shader simultaneously. */
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
  viewportHeight: number = 1,
  /** Mapbox `paint.line-blur` — additional smoothstep feathering on
   *  the edge, in CSS px. The base AA reserve below (1.0 px) matches
   *  MapLibre's native line antialiasing budget; `blur` adds on top
   *  per the Mapbox spec ("Blur applied to the line, in pixels.").
   *  Pre-fix the base was 1.5 px which over-softened every line edge
   *  vs MapLibre side-by-side — the surplus 0.5 px each side showed
   *  up as the coastline-band pixel diff dominating demotiles
   *  parity-check (97 % of differing pixels at Korea z=5 sat in the
   *  stroke band). */
  blurPx: number = 0,
): Float32Array {
  const buf = new Float32Array(LINE_UNIFORM_SIZE / 4)
  const u32 = new Uint32Array(buf.buffer)
  buf[0] = strokeColor[0]
  buf[1] = strokeColor[1]
  buf[2] = strokeColor[2]
  // Sub-pixel-width strokes (stroke-0.3 etc.) used to render as a fuzzy
  // 2-3 px AA band at reduced alpha — the SDF AA distance (1 px each
  // side of the SDF edge) dominates when the line itself is < 1 px,
  // making thin strokes look fatter than asked. Mapbox / MapLibre
  // convention: render at min 1 px geometric width and scale alpha by
  // the requested fraction. Above 1 px the trick is a no-op.
  const effectiveWidthPx = Math.max(strokeWidthPx, 1.0)
  const widthAlphaScale = strokeWidthPx >= 1.0 ? 1.0 : strokeWidthPx
  buf[3] = strokeColor[3] * opacity * widthAlphaScale
  buf[4] = effectiveWidthPx
  // AA reserve (1.0 px ≈ MapLibre native) + Mapbox-style blur on top.
  buf[5] = 1.0 + Math.max(0, blurPx)
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

  const hasPattern = patterns.some(p => !!p && p.shapeId > 0)
  const hasOffset = Math.abs(offsetPx) > 0
  u32[8] = packFlags(cap, join, dashCount > 0, hasPattern, hasOffset)
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
    u32[base] = p.shapeId | 0
    u32[base + 1] = flags
    buf[base + 2] = p.spacing
    buf[base + 3] = p.size
    buf[base + 4] = p.offset ?? 0
    buf[base + 5] = p.startOffset ?? 0
  }

  // Lateral parallel offset: DSL value in pixels → shader wants meters.
  buf[44] = offsetPx * mppAtCenter
  buf[45] = viewportHeight
  return buf
}
