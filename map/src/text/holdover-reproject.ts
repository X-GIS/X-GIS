// ═══ Fade-out holdover reprojection — smooth label fade DURING zoom/pan ═══
//
// The symbol-fade ledger (label-fade.ts) keeps a label's last-placed draw as a
// "holdover" clone so it can keep drawing while its opacity ramps to 0 after
// the label leaves the placement set. That clone bakes ABSOLUTE screen px, so
// TextStage.prepare historically SUPPRESSED the holdover whenever the camera
// moved (holdoverOk === false) — a stale clone at the old screen position
// would visibly lag. The result: a label that dropped DURING a zoom just
// POPPED out instead of fading (fade-in still worked → an asymmetric blink,
// the "labels flicker on zoom" report). Empirically the fade IDENTITY was
// already stable across zoom (a place-label's resolvedText + quantised world
// pos + occurrence don't change on a tile-z crossing) — the blink was the
// suppressed fade-OUT, not a key churn.
//
// Fix: during a SIMILARITY-SAFE camera move (flat Mercator, pitch 0, fixed
// bearing + canvas — the exactness regime of the #1177 replay, proven in
// label-replay-transform.ts) reproject the frozen clone from its bake frame
// onto the current frame. The clone then fades out IN PLACE, tracking the map,
// exactly where a freshly-baked label would sit. Outside that regime
// (globe / pitch / rotate / resize) the caller passes no ctx and the holdover
// stays suppressed — the pre-fix graceful pop, unchanged.

/** Screen-space similarity `current_px = baked_px · scale + (dx, dy)` — the
 *  same shape label-replay-transform.ts solves and the text/icon shaders
 *  apply per-vertex. Inlined (not imported) so this leaf module stays free of
 *  the render/passes layer. */
export interface HoldoverTransform {
  scale: number
  dx: number
  dy: number
}

/** Camera reference frame captured when a holdover clone was last baked (its
 *  last-placed prepare). Lets a later prepare solve bake→current via the
 *  #1177 replay refs and gate on the invariants the similarity assumes. */
export interface HoldoverBakeFrame {
  /** sampleReplayRefs output at bake (REPLAY_REFS_LEN floats) — the world
   *  points + their bake-frame screen projections the solve maps forward. */
  refs: Float64Array
  bearingKey: number
  canvasW: number
  canvasH: number
}

/** Per-prepare context the label pass hands to the stage so it can reproject
 *  fade-out holdovers. Present ONLY on a similarity-safe prepare (flat
 *  Mercator + pitch 0); absent ⇒ holdover suppressed on motion (pre-fix pop).
 *  `refs` is THIS prepare's replay refs (the bake source stamped on every
 *  placement); `solve` maps a stored bake frame's refs onto THIS frame via the
 *  current projector, returning null when the fit falls outside the replay
 *  bands (world-copy flip / degenerate camera). */
export interface MotionHoldoverCtx {
  bearingKey: number
  canvasW: number
  canvasH: number
  refs: Float64Array
  solve: (bakeRefs: Float64Array) => HoldoverTransform | null
}

/** A holdover baked under `bake` is reprojectable to the current frame by a
 *  pure scale+translate only when bearing + canvas are unchanged (the caller
 *  already restricts the ctx to flat Mercator + pitch 0, where the replay
 *  similarity is EXACT — label-replay-transform.ts header proof). A bearing or
 *  canvas change since bake makes the same-frame solve a wrong fit, so we skip
 *  (graceful pop) rather than misplace the vanishing label. */
export function holdoverSimilarityValid(bake: HoldoverBakeFrame, ctx: MotionHoldoverCtx): boolean {
  return (
    bake.bearingKey === ctx.bearingKey &&
    bake.canvasW === ctx.canvasW &&
    bake.canvasH === ctx.canvasH
  )
}

/** Minimal shape of a text/icon draw the reprojector rewrites — a structural
 *  subset so this stays decoupled from TextDraw/IconDraw. Angles
 *  (rotateRad / glyphRotations) and atlas-space radii are scale-invariant and
 *  pass through untouched via the spread in the concrete helpers. */
interface ScreenAnchored {
  anchorX: number
  anchorY: number
}

/** Reproject a frozen TEXT holdover clone onto the current frame. `t` maps
 *  baked screen px → current screen px. The anchor moves affinely; every
 *  size-bearing field (fontSize, glyph offsets, halo width/blur, letter
 *  spacing) scales by `t.scale` so the label tracks the zoom — reproducing the
 *  per-vertex shader replay (pos·scale + shift) while keeping the NORMALISED
 *  halo edge constant (halo width and fontSize scale together, so their ratio
 *  in the uniform pack is unchanged). Returns a shallow copy; the stored clone
 *  stays baked so the NEXT prepare solves from the same origin. */
export function reprojectTextHoldover<
  D extends ScreenAnchored & {
    fontSize: number
    letterSpacingPx?: number
    halo?: { color: [number, number, number, number]; width: number; blur?: number }
    glyphOffsets?: Float32Array
  },
>(draw: D, t: HoldoverTransform): D {
  const s = t.scale
  const out: D = {
    ...draw,
    anchorX: draw.anchorX * s + t.dx,
    anchorY: draw.anchorY * s + t.dy,
    fontSize: draw.fontSize * s,
  }
  if (draw.letterSpacingPx !== undefined) out.letterSpacingPx = draw.letterSpacingPx * s
  if (draw.halo !== undefined) {
    out.halo =
      draw.halo.blur !== undefined
        ? { color: draw.halo.color, width: draw.halo.width * s, blur: draw.halo.blur * s }
        : { color: draw.halo.color, width: draw.halo.width * s }
  }
  if (draw.glyphOffsets !== undefined) {
    const src = draw.glyphOffsets
    const g = new Float32Array(src.length)
    for (let i = 0; i < src.length; i++) g[i] = src[i]! * s
    out.glyphOffsets = g
  }
  return out
}

/** Reproject a frozen ICON holdover clone (IconDraw). The anchor moves affinely
 *  and `sizeScale` (which the icon renderer multiplies by the sprite dims to get
 *  the quad) scales by `t.scale`, so the badge tracks the zoom — reproducing the
 *  icon shader's per-vertex replay (pos·scale + shift). An icon-text-fit
 *  override (`fit`, absolute px) scales the same way. `rotateRad` / `anchor` /
 *  `sprite` / `tint` are scale-invariant and pass through. Returns a shallow
 *  copy so the stored clone stays baked. */
export function reprojectIconHoldover<
  D extends ScreenAnchored & {
    sizeScale: number
    fit?: { w?: number; h?: number; dx?: number; dy?: number }
  },
>(draw: D, t: HoldoverTransform): D {
  const s = t.scale
  const out: D = {
    ...draw,
    anchorX: draw.anchorX * s + t.dx,
    anchorY: draw.anchorY * s + t.dy,
    sizeScale: draw.sizeScale * s,
  }
  if (draw.fit !== undefined) {
    const f = draw.fit
    out.fit = {
      ...(f.w !== undefined ? { w: f.w * s } : {}),
      ...(f.h !== undefined ? { h: f.h * s } : {}),
      dx: (f.dx ?? 0) * s,
      dy: (f.dy ?? 0) * s,
    }
  }
  return out
}

/** Snapshot the current prepare's bake frame — ONE refs copy per prepare,
 *  shared by every placement stamped below. Null off the similarity-safe path
 *  so placements clear any stale stamp (→ later fade-outs pop gracefully). */
export function makeBakeFrame(ctx: MotionHoldoverCtx | undefined): HoldoverBakeFrame | null {
  return ctx !== undefined
    ? {
        refs: ctx.refs.slice(),
        bearingKey: ctx.bearingKey,
        canvasW: ctx.canvasW,
        canvasH: ctx.canvasH,
      }
    : null
}

/** Decide what a fade-out holdover draws THIS prepare: the baked clone as-is on
 *  an exact-match idle frame (holdoverOk), a reprojected clone during a
 *  similarity-safe zoom/pan, or nothing (globe / pitch / rotate / out-of-band
 *  solve — the graceful pop). `reproject` is the draw-specific rewriter, so text
 *  and icon share this decision without sharing a draw type. */
export function holdoverDrawToEmit<D>(
  held: D,
  bake: HoldoverBakeFrame | undefined,
  holdoverOk: boolean,
  ctx: MotionHoldoverCtx | undefined,
  reproject: (draw: D, t: HoldoverTransform) => D,
): D | null {
  if (holdoverOk) return held
  if (ctx === undefined || bake === undefined || !holdoverSimilarityValid(bake, ctx)) return null
  const t = ctx.solve(bake.refs)
  return t !== null ? reproject(held, t) : null
}
