// ═══ #2042 — the Mercator camera-relative recombination, ONE authority ═══
//
// The flat-arm analogue of the 3D arm's INC-1 RTC recombination, gated by the SAME umbrella
// flag lane (cam_ecef_center_h.w). Legacy arm: the CPU-packed cam_h/cam_l DSFUN pair.
// Recombine arm: (camMercH − originH, camMercL − originL) — hi−hi is Sterbenz-exact when the
// camera is near the tile, and lo−lo recovers the low bits the single-f32 tile_origin_merc lost.
//
// Extracted here rather than spelled out per shader because polygon.ts and line.ts otherwise
// each carry their own copy of the same select. polygon-split.ts's `derived` map is deliberately
// NOT a third caller: under the split partition both anchors are always bound, so it rewrites
// cam_h/cam_l to the recombined arm ALONE, with no flag select — a related expression, not this
// one, and folding them together would add a select the split path must not have. Same
// idiom as line-corner.ts: the uniform LANES are PARAMETERS, not imports, so the one recipe
// serves polygon's `Uniforms` and line's `TileUniforms` byte-mirror — two structs declaring the
// same lanes — while this module stays cycle-free and pure.
//
// BYTE-IDENTITY IS PART OF THE CONTRACT, and it is MEASURED, not argued. The emitted WGSL/GLSL
// is a pure function of the IR, so moving construction into a callee changes nothing — polygon
// already built this pair inside `emitPolygonProjectionLadder`, one level in. The authority is
// `polygon-variant-diff.test.ts`'s 8 committed UN-MINIFIED snapshots, and that gate was itself
// validated against a known positive before the green was believed: renaming one `Let` reds all
// 8, so its pass here carries information (§12 — validate the instrument before trusting a zero).
//
// What is NOT true, though it sounds plausible and was written down as fact before being tested:
// that binding the flag compare as its own `Let` inside this helper would move bytes by killing
// the `_cse0` the emitted source carries. It does not — CSE folds it to the same output either
// way, measured. The one thing that DOES move bytes is calling the helper at a different point in
// the caller's body, which moves both the `let` order and the CSE placement. That is why this
// returns raw EXPRESSIONS rather than `Let`s: polygon wraps them in its existing
// `Let('cam_rel_h'…)` / `Let('cam_rel_l'…)` at the unchanged point, and a caller whose read sites
// sit in helper `fn` bodies or another shader stage — where a caller-scope `Let` is not in scope —
// can use them inline and let CSE fold the repeats within the stage.

import { select, vec2, type Node, type ReadonlyNode } from '@xgis/shader-dsl'

/** The lanes the recipe reads. Named for the uniform fields they come from. */
export interface MercCamRelLanes {
  /** Absolute camera centre, Mercator metres, DSFUN pair (.xy hi, .zw lo). */
  readonly camMercCenterHl: ReadonlyNode<'vec4<f32>'>
  /** worldOff-shifted tile origin, same packing — the legacy single-f32
   *  tile_origin_merc is this .xy, which is why the recombination needs .zw. */
  readonly tileOriginMercHl: ReadonlyNode<'vec4<f32>'>
  /** The umbrella recombine flag rides in .w (one flag for both arms). */
  readonly camEcefCenterH: ReadonlyNode<'vec4<f32>'>
  /** Legacy CPU-packed pair, the fall-back arm of each select. */
  readonly camH: ReadonlyNode<'vec2<f32>'>
  readonly camL: ReadonlyNode<'vec2<f32>'>
}

/** Flag-selected camera-relative Mercator hi/lo pair. Both arms are pure reads,
 *  so `select` is branchless and computing the unused arm is free of effects. */
export function mercCamRel(u: MercCamRelLanes): {
  h: Node<'vec2<f32>'>
  l: Node<'vec2<f32>'>
} {
  const m = u.camMercCenterHl
  const o = u.tileOriginMercHl
  const recombine = u.camEcefCenterH.w.gt(0.5)
  return {
    h: select(recombine, vec2(m.x.sub(o.x), m.y.sub(o.y)), u.camH),
    l: select(recombine, vec2(m.z.sub(o.z), m.w.sub(o.w)), u.camL),
  }
}
