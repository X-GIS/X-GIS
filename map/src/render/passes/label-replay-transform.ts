// ═══ #1177 — S16 skip-replay screen-space correction (label zoom-lag fix) ═══
//
// The zoom-tolerant S16 skip (label-pass.ts, #1177 Option B) replays the
// PREPARED frame's baked screen-px label/icon quads while the camera keeps
// moving inside the tolerance window (|Δzoom| ≤ 0.15, centre drift ≤ 48 px).
// Because TEXT_FORMAT/ICON_FORMAT bake ABSOLUTE screen px, a raw replay
// freezes every label at its old screen position until the next re-prepare —
// the user-visible "labels lag behind the map, then snap" during wheel zoom.
//
// This module derives the affine that maps prepared-frame screen px onto
// CURRENT-frame screen px, applied as a per-frame uniform by the text/icon
// shaders (#1177 Option A's "camera move = uniform update", scoped to the
// replay window). The skip's perf win is untouched: hit frames still skip
// shaping + O(N²) collision + upload entirely.
//
// ── Exactness proof (flat projection, pitch 0, fixed bearing) ──
// The merc→screen map is P(x) = C + s·R·F·(x − c): C = screen centre px,
// s = 1/mpp, R = bearing rotation, F = y-flip, c = camera centre (merc m).
// The S16 tolerance branch holds bearing/pitch/canvas EXACT (any change is a
// miss), so between the prepared camera (s₀, c₀) and the current one (s₁, c₁)
// only s and c differ. Then for k = s₁/s₀ and t = C·(1−k) + s₁·R·F·(c₀ − c₁):
//   k·P₀(x) + t = k·C + s₁·R·F·(x−c₀) + C − k·C + s₁·R·F·(c₀−c₁) = P₁(x)
// for EVERY anchor x — the correction is exact, not approximate, in this
// regime. R and F preserve norms, so k is recovered as a screen-distance
// ratio and t from any single point. Under pitch / globe the same solve is
// the best similarity fit at the view centre (first-order exact); the
// residual is bounded by the tolerance window and re-zeroes at every actual
// re-prepare. label-replay-transform.test.ts instantiates the proof.
//
// Single-authority note: both sampling and solving go through the SAME
// per-frame `projectMercAny` family the label anchors themselves use
// (makeLabelProjectors) — no second projection formula exists here, so the
// correction can never disagree with the placement math it corrects.

/** Screen-space similarity applied to replayed label/icon quads:
 *  current_px = prepared_px · scale + (dx, dy). */
export interface LabelReplayTransform {
  scale: number
  dx: number
  dy: number
}

/** `projectMercAny` shape from makeLabelProjectors: absolute Mercator metres →
 *  physical screen px, or null when culled. Returned tuples are per-frame
 *  scratch — values are copied out before the next call. */
export type MercProjector = (sx: number, sy: number) => readonly [number, number] | null

/** Number of Float64 slots a replay-refs buffer needs (3 × [mx,my,px,py]). */
export const REPLAY_REFS_LEN = 12

// Defensive bands. A legitimate in-tolerance replay has scale ∈ ~[0.90, 1.11]
// (2^±0.15) and a shift of at most a few hundred px; a world-copy flip or a
// degenerate/near-horizon projection produces values orders of magnitude
// outside these. Rejecting them falls back to the pre-fix behaviour
// (identity replay) for that frame only.
const SCALE_BAND_MIN = 0.25
const SCALE_BAND_MAX = 4
const SHIFT_BAND_PX = 8192

/** Sample the three replay reference points through THIS frame's projector
 *  and store [mercX, mercY, screenPxX, screenPxY] × 3 into `out`
 *  (REPLAY_REFS_LEN floats). Call on every prepare (S16 miss) frame, with the
 *  same projector family that just placed the labels.
 *
 *  Refs: camera centre, centre + refDistPx along merc x, centre + refDistPx
 *  along merc y — offsets point TOWARD the origin so they stay inside the
 *  world/Mercator-clamp bounds near the antimeridian and poles (the solve is
 *  sign-agnostic: only distances and the centre point are used).
 *
 *  Returns false when any point fails to project (culled / degenerate camera)
 *  — the caller keeps replay disabled until the next prepare. */
export function sampleReplayRefs(
  projectMercAny: MercProjector,
  centerX: number,
  centerY: number,
  mpp: number,
  refDistPx: number,
  out: Float64Array,
): boolean {
  if (!(mpp > 0) || !(refDistPx > 0)) return false
  const d = refDistPx * mpp
  const sx = centerX > 0 ? -1 : 1
  const sy = centerY > 0 ? -1 : 1
  const mx = [centerX, centerX + sx * d, centerX] as const
  const my = [centerY, centerY, centerY + sy * d] as const
  for (let i = 0; i < 3; i++) {
    const p = projectMercAny(mx[i]!, my[i]!)
    if (p === null || !isFinite(p[0]) || !isFinite(p[1])) return false
    const base = i * 4
    out[base + 0] = mx[i]!
    out[base + 1] = my[i]!
    // Copy out immediately — the projector returns a reused scratch tuple.
    out[base + 2] = p[0]
    out[base + 3] = p[1]
  }
  return true
}

/** Solve the similarity mapping the PREPARED frame's projections of the
 *  stored reference points onto the CURRENT frame's, writing into `out`
 *  (caller-owned scratch — no allocation). Call on S16 hit (replay) frames
 *  with the CURRENT frame's projector.
 *
 *  Returns false (caller renders with identity, i.e. the pre-fix freeze) on
 *  any failed projection, degenerate reference geometry, or a solution
 *  outside the defensive bands. */
export function solveReplayTransform(
  refs: Float64Array,
  projectMercAny: MercProjector,
  out: LabelReplayTransform,
): boolean {
  // Current-frame projections of the stored merc refs (copied out per call).
  let q0x = 0
  let q0y = 0
  let q1x = 0
  let q1y = 0
  let q2x = 0
  let q2y = 0
  for (let i = 0; i < 3; i++) {
    const p = projectMercAny(refs[i * 4]!, refs[i * 4 + 1]!)
    if (p === null || !isFinite(p[0]) || !isFinite(p[1])) return false
    if (i === 0) {
      q0x = p[0]
      q0y = p[1]
    } else if (i === 1) {
      q1x = p[0]
      q1y = p[1]
    } else {
      q2x = p[0]
      q2y = p[1]
    }
  }
  const p0x = refs[2]!
  const p0y = refs[3]!
  const d1 = Math.hypot(refs[6]! - p0x, refs[7]! - p0y)
  const d2 = Math.hypot(refs[10]! - p0x, refs[11]! - p0y)
  if (d1 < 1e-9 || d2 < 1e-9) return false
  const k = (Math.hypot(q1x - q0x, q1y - q0y) / d1 + Math.hypot(q2x - q0x, q2y - q0y) / d2) / 2
  if (!isFinite(k) || k < SCALE_BAND_MIN || k > SCALE_BAND_MAX) return false
  const dx = q0x - k * p0x
  const dy = q0y - k * p0y
  if (!isFinite(dx) || !isFinite(dy)) return false
  if (Math.abs(dx) > SHIFT_BAND_PX || Math.abs(dy) > SHIFT_BAND_PX) return false
  out.scale = k
  out.dx = dx
  out.dy = dy
  return true
}
