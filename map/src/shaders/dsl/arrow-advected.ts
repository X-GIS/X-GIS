// ═══ The ADVECTED arrow module — streamline trains on a GROUND lattice (#1520 step 2, #1534) ═══
//
// A SECOND MODULE, not a runtime flag on the static one. `module()` declares bindings at MODULE
// level, so adding this path's resources to the static module would change the STATIC shader's
// emitted text even though its VS body is untouched — and "the `| arrow` path is byte-identical"
// would stop being assertable, which is the property that makes the split worth having. The
// function OBJECTS (`ArrowOut`, `fs`, `arrowQuadOffset`, the projection ladder) are shared, so
// there is still exactly one definition of each; only the module assembly differs.
//
// ── WHAT CHANGED, AND THE MEASUREMENT THAT FORCED IT ──────────────────────────────────────────
//
// The field used to be generated from the DATA: one instance per grid cell (later per sub-cell),
// each carrying a geographic anchor and two projected basis anchors, thinned per frame by a
// power-of-two decimation. #1520 measured what that costs at depth — painted pixels on the shipped
// build:
//
//     zoom      z13     z15     z17     z19
//     painted   1 903   124     0       0
//
// At z17 and beyond NOT ONE seeded node falls inside the viewport. That is not a tuning miss and no
// amount of subdivision reaches it: `sub²` per cell scales with the GRID, and holding ~34 px
// spacing at z19 would need 355 M instances of which fewer than one is on screen.
//
// So the instance set is generated from the VIEW. Instance `i` is `(seed, glyph j)`; the seed is a
// node of a lattice whose SPACING the screen chooses — a step in grid-uv sized so the nodes land
// about `δ·√G` px apart — enumerated over the ground the view can actually see. Density is then
// constant per screen area at EVERY zoom by construction, rather than by a rule that has to track
// the grid, and the nodes are patches of water rather than viewport positions (#1534).
//
// ── STREAMLINE TRAINS, NOT WIND-MAP PARTICLES ─────────────────────────────────────────────────
//
// Each seed grows a TRAIN of `ARROW_TRAIN_GLYPHS` glyphs strung along its streamline at a fixed
// arc-length spacing, glyph `j` at `(j + φ)·δ`. #1520 settled this over the wind-map alternative
// and the reasons are worth not re-litigating: a wind map reads its flow off a fading accumulation
// trail, which a mandated SCAROW glyph cannot have, and its stochastic respawn leaves empty
// patches — on a chart an empty patch is a statement about the water (#1510).
//
// THE WRAP IS FREE, not faded over. As φ runs 0→1 the whole train advances by exactly ONE spacing,
// so the set of occupied arc-lengths at φ = 1 is the set at φ = 0 shifted by one: every glyph lands
// where its neighbour was. The alpha ramp is a function of the arc-length `(j + φ)/G`, so it too
// matches across the seam. There is nothing to blink.
//
// ── THE LATTICE IS ANCHORED TO THE GROUND (#1534) ─────────────────────────────────────────────
//
// The first cut of this rewrite seeded on the SCREEN — a node at a fixed viewport position — and
// the field then slid over the water as the map panned. Anchoring it to the ground was tried the
// obvious way first, by SNAPPING each screen seed to the nearest ground node, and that fails
// measurably rather than by taste: the snap is many-to-one, so adjacent screen seeds collapse onto
// one node while others get none, and every survivor moves by up to half a cell. Three gates caught
// it (#1534 records the numbers).
//
// So the ground lattice is ENUMERATED instead. Instance `i` names a ground node `(jx, jy)` outright
// — one instance per node, nothing to collapse — and the work moves to putting that node on screen,
// which is the two-part construction the seed block below describes. The phase jitter is hashed
// from the GROUND index for the same reason it used to be hashed from the screen index: that is the
// identity which does not change as the camera moves.

import {
  fn,
  module,
  f32,
  u32,
  max,
  min,
  step,
  length,
  floor,
  fract,
  vec2,
  vec2i,
  vec4,
  toF32,
  toI32,
  clamp,
  textureLoad,
  textureDimensions,
  select,
  Let,
  Var,
  storageBuffer,
  resource,
  builtin,
  emitModule,
  emitGlslModule,
  emitGlslStages,
  stageOf,
  f32T,
  u32T,
  texture2dfT,
  type ModuleDecl,
  type ReadonlyNode,
} from '@xgis/shader-dsl'
import {
  S111_BAND_COUNT,
  S111_BAND_PARAMS_ROW,
  S111_BAND_STRIDE,
  S111_PARAM_UV_ASPECT,
} from './s111-band-table-layout'
import { PROJECTION_CONSTS, getGpuProjectionFuncs } from './projections'
import { pointU } from './point'
import { UNPROJECT_FUNCS } from './unproject-dsl'
import {
  fieldViewU,
  FIELD_LATTICE_FUNCS,
  FIELD_NEWTON_SPACINGS,
  field_node_uv,
  field_node_ndc,
  field_screen_lonlat,
  field_grid_uv,
  field_owned_elsewhere,
  field_uv_basis,
  field_uv_step,
  field_uv_to_px,
} from './field-lattice'
import { ARROW_TRAIN_GLYPHS, ARROW_TRAIN_STEPS, ARROW_TRAIN_TAPS_PER_SPACING } from './arrow-drift'
import { ARROW_PHASE_SECONDS, arrow_phase_alpha, arrow_phase_offset } from './arrow-drift'
import { ArrowOut, arrowQuadOffset, fs } from './arrow-retained'

const bandB = storageBuffer('band_data', f32T, { group: 1, binding: 1, access: 'read' })
const flowUTex = resource('flow_u_tex', texture2dfT, { group: 1, binding: 2 })
const flowVTex = resource('flow_v_tex', texture2dfT, { group: 1, binding: 3 })
/** 1 where the catalogue reports a real cell (moving or genuinely calm), 0 where it is nodata —
 *  the distinction `flow_u_tex`/`flow_v_tex` alone cannot make, both packing nodata AND calm to
 *  the identical `(0, 0)` (`flow-field-pack.ts`). Read only by `loadInterpolated` below, which is
 *  the one place that needs to tell "no current" from "no data" apart. */
const flowValidTex = resource('flow_valid_tex', texture2dfT, { group: 1, binding: 5 })

/** Fetch the cell OWNING a grid-uv position, with no sampler. A vertex stage cannot call
 *  `textureSample` (no implicit derivatives), and the velocity field wants a point fetch anyway:
 *  it is per-cell data whose band edges are the catalogue's own granularity, so a cell's value
 *  governs its whole footprint and blending two of them would invent a current between them —
 *  the one that reads a shore cell's neighbour as half a current. It also keeps every
 *  vertex-visible binding sampler-free, so the WebGL2 sampler-follows-its-texture ordering rule
 *  has nothing to trip over.
 *
 *  OWNER, not `floor(uv · n)`. Origins are written in the convention `u = col / (n − 1)`, so the
 *  texel containing a position is `round(u · (n − 1))` — nearest under point registration. The
 *  old form skewed by `u`, up to a whole cell, and read a NEIGHBOUR's velocity (#1511); that
 *  neighbour is often land, whose packed `(0, 0)` collapses the size product, so the symptom is a
 *  hole in valid water rather than a wrong colour.
 *
 *  `floor(x + 0.5)`, not `round`: WGSL rounds halves to even and GLSL's tie is
 *  implementation-defined, so a node landing exactly on a footprint boundary could resolve to
 *  different cells on the two backends — a parity bug that only shows on one of them. */
const loadAtUv = (
  // The 2d/MS union this helper actually handles — NOT derived from
  // textureDimensions' parameter, which widened to include 2d-array textures
  // (#1651) that the 3-arg textureLoad below rightly rejects (an array load
  // needs a layer). The derived coupling read as "any texture with dimensions",
  // which was never this helper's contract.
  tex: ReadonlyNode<'texture_2d<f32>' | 'texture_multisampled_2d<f32>'>,
  uv: { x: ReturnType<typeof f32>; y: ReturnType<typeof f32> },
) => {
  const d = textureDimensions(tex)
  const owner = (t: ReturnType<typeof f32>, n: ReturnType<typeof toF32>) =>
    toI32(clamp(floor(t.mul(n.sub(1)).add(0.5)), f32(0), n.sub(1)))
  const c = vec2i(owner(uv.x, toF32(d.x)), owner(uv.y, toF32(d.y)))
  return textureLoad(tex, c, u32(0))
}

/** Bilinear-blend the velocity at `uv` across VALID neighbours only — the smoothing
 *  `loadAtUv`'s point fetch deliberately refuses, now offered where it cannot repeat #1511: a
 *  cell contributes to the blend only when `flow_valid_tex` says it is real data, so a land or
 *  nodata neighbour is excluded from the weighted sum rather than diluting it toward its packed
 *  `(0, 0)`. A genuinely CALM neighbour (valid, zero speed) blends in normally — fading smoothly
 *  toward slack water is correct, unlike fading toward a shore that never reported a current.
 *
 *  Four explicit `textureLoad`s per component, not a filtering sampler: nothing here has screen
 *  derivatives to hand `textureSample` (this still runs in a vertex stage), and the corner
 *  weights need per-corner validity gating a hardware sampler has no way to express anyway. Run
 *  ONCE per glyph, after the walk settles on `posLive` — seeing the intermediate taps blur made
 *  no visible difference (the walk only cares about arrival, not the curvature en route) and
 *  would have multiplied this same cost by `ARROW_TRAIN_STEPS`. */
const loadInterpolated = (uv: { x: ReturnType<typeof f32>; y: ReturnType<typeof f32> }) => {
  const d = textureDimensions(flowUTex.node)
  const nx = Let(toF32(d.x))
  const ny = Let(toF32(d.y))
  // Same `col/(n − 1)` convention `loadAtUv` uses, kept fractional here instead of rounded to one
  // owner texel.
  const fx = Let(clamp(uv.x.mul(nx.sub(1)), f32(0), nx.sub(1)))
  const fy = Let(clamp(uv.y.mul(ny.sub(1)), f32(0), ny.sub(1)))
  const x0 = Let(floor(fx))
  const y0 = Let(floor(fy))
  const tx = Let(fx.sub(x0))
  const ty = Let(fy.sub(y0))
  const x1 = Let(min(x0.add(f32(1)), nx.sub(1)))
  const y1 = Let(min(y0.add(f32(1)), ny.sub(1)))
  const w00 = Let(f32(1).sub(tx).mul(f32(1).sub(ty)))
  const w10 = Let(tx.mul(f32(1).sub(ty)))
  const w01 = Let(f32(1).sub(tx).mul(ty))
  const w11 = Let(tx.mul(ty))

  const corner = (cx: ReturnType<typeof Let<'f32'>>, cy: ReturnType<typeof Let<'f32'>>) => {
    const c = Let(vec2i(toI32(cx), toI32(cy)))
    return {
      u: Let(textureLoad(flowUTex.node, c, u32(0)).x),
      v: Let(textureLoad(flowVTex.node, c, u32(0)).x),
      valid: Let(textureLoad(flowValidTex.node, c, u32(0)).x),
    }
  }
  const c00 = corner(x0, y0)
  const c10 = corner(x1, y0)
  const c01 = corner(x0, y1)
  const c11 = corner(x1, y1)

  const g00 = Let(w00.mul(step(f32(0.5), c00.valid)))
  const g10 = Let(w10.mul(step(f32(0.5), c10.valid)))
  const g01 = Let(w01.mul(step(f32(0.5), c01.valid)))
  const g11 = Let(w11.mul(step(f32(0.5), c11.valid)))
  const wsum = Let(max(g00.add(g10).add(g01).add(g11), f32(1e-6)))

  const u = Let(
    c00.u.mul(g00).add(c10.u.mul(g10)).add(c01.u.mul(g01)).add(c11.u.mul(g11)).div(wsum),
  )
  const v = Let(
    c00.v.mul(g00).add(c10.v.mul(g10)).add(c01.v.mul(g01)).add(c11.v.mul(g11)).div(wsum),
  )
  return { x: u, y: v }
}

/** Read band row `b`'s slot from the uploaded catalogue table (s111-portrayal.ts). */
const bandAt = (row: ReturnType<typeof u32>, slot: number) =>
  bandB.node.at(row.mul(u32(S111_BAND_STRIDE)).add(slot), f32T)

/** 1 when `v` is inside `[0, 1]`, 0 outside — with no branch, so a node off the coverage collapses
 *  through the same size product every other rejection uses. */
const inUnit = (v: ReturnType<typeof f32>) => step(f32(0), v).mul(step(v, f32(1)))

const vsAdvected = fn(
  'vs_arrow_retained_advected',
  {
    inst: builtin('instance_index', u32T),
    vi: builtin('vertex_index', u32T),
  },
  (p) => {
    const av = fieldViewU.field
    const vp = pointU.field.viewport
    const G = f32(ARROW_TRAIN_GLYPHS)

    // ── instance → (seed, glyph) ──────────────────────────────────────────────────────────────
    //
    // Done in f32, not with integer div/mod. The counts here are tens of thousands at most and f32
    // is exact to 2^24, so nothing is lost; what is gained is that WGSL's and GLSL ES 3.00's
    // integer `%` differ on negative operands and their division rounding is worth not depending
    // on for a value that decides WHICH ARROW this is.
    const instF = Let(toF32(p.inst))
    const seed = Let(floor(instF.div(G)))
    const glyph = Let(instF.sub(seed.mul(G)))
    const nx = Let(max(av.ray_bl.w, f32(1)))
    const ny = Let(max(av.ray_br.w, f32(1)))
    const spacingPx = Let(max(av.ray_tl.w, f32(1e-3)))
    const basePx = Let(av.ray_tr.w)
    // INTERLEAVED node set (`hw.w`): the second half of the instances is the same lattice offset by
    // HALF a cell on both axes — a quincunx, so twice the nodes at an effective spacing of
    // `step/√2`. Decoded here rather than baked into the count because the base nodes must keep
    // their exact uv: interleaving adds nodes, it never moves one, so no glyph's phase re-rolls and
    // no octave boundary is crossed. A finer STEP would have done neither (`FieldLatticeRequest`
    // records why that route gives 1× or 4× per zoom rather than 2×).
    const cells = Let(nx.mul(ny))
    const half = Let(floor(seed.div(cells)).mul(av.hw.w).mul(f32(0.5)))
    const cell = Let(seed.sub(floor(seed.div(cells)).mul(cells)))
    const row = Let(floor(cell.div(nx)))
    const col = Let(cell.sub(row.mul(nx)))
    // The GROUND node this instance is, as a signed lattice index — half-integral on the offset
    // copy. The window slides with the view; the index of a given patch of water does not, which is
    // what makes the phase below stable, and a half-integer is just as stable as an integer.
    const jx = Let(av.lattice.z.add(col).add(half))
    const jy = Let(av.lattice.w.add(row).add(half))

    // ── the ground node, and where it lands on screen ─────────────────────────────────────────
    //
    // TWO PARTS, and the split is a precision argument rather than an optimisation (#1534). The
    // node's uv is exact — it is an integer times a step — but putting it on screen would need a
    // forward projection from a DSFUN-split geographic anchor, which a lattice index does not have.
    // So the linearized model places it approximately, and ONE Newton step against the exact
    // backward map removes the model's error: unproject the guess, see which uv it actually landed
    // on, and correct by that uv error mapped through the node's own basis.
    //
    // The residual after the step is second order in the model's error, which is itself only the
    // projection's curvature over one screen — sub-pixel everywhere the field is drawn. What it is
    // NOT is a quantisation: the target is this instance's own node, so no two instances converge on
    // the same one and none is displaced toward a neighbour.
    const node = Let(field_node_uv({ jx, jy }))
    const uv0 = Let(node.swizzle('zw'))
    const guess = Let(field_node_ndc({ duv: node.swizzle('xy') }))
    const ndc = Let(guess.swizzle('xy'))
    const ll = Let(field_screen_lonlat({ ndc }))
    // Pixels per unit of grid-uv at this node — what replaces the two packed basis anchors the
    // per-cell generator used to ship. Zero when the node has no ground under it.
    const basis = Let(field_uv_basis({ ndc, lon: ll.x, lat: ll.y }))
    const fixPx = Let(field_uv_to_px(basis, uv0.sub(field_grid_uv({ lonlat: ll.swizzle('xy') }))))

    // ── where this glyph is along the train ───────────────────────────────────────────────────
    //
    // The clock is the frame uniform's animation lane (circle_params.y, seconds) — already written
    // O(1)/frame by the retained path and already pinnable (`?animt`) for a deterministic capture,
    // which is what makes this field reproducible in a render gate.
    //
    // The jitter is hashed from the node's ABSOLUTE lattice index — its own uv over the step, which
    // is an integer because the anchor is a multiple of the step. Constant under pan, and under a
    // zoom that crosses an octave the surviving nodes' indices halve rather than shuffling, so a
    // given patch of water keeps its phase as the camera moves.
    //
    // NEITHER of the two nearby quantities would do, and both look right until the camera moves.
    // `(col, row)` is a WINDOW index and slides with the viewport. `(jx, jy)` is anchor-relative,
    // and the anchor tracks the view centre in whole steps — so it too shifts on a pan, just one
    // step at a time. Both re-roll every glyph as the map moves, which is the boil the jitter
    // exists to prevent.
    const phase = Let(
      fract(
        pointU.field.circle_params.y
          .div(f32(ARROW_PHASE_SECONDS))
          .add(arrow_phase_offset({ p: vec2(uv0.x.div(av.lattice.x), uv0.y.div(av.lattice.y)) })),
      ),
    )
    /** Arc length from the seed, in device pixels. */
    const arc = Let(glyph.add(phase).mul(spacingPx))

    // ── walk the streamline, in SCREEN arc length ─────────────────────────────────────────────
    //
    // Fixed steps of `δ / taps`, with the LAST step shortened to land exactly on `arc`. That makes
    // the position a pure and CONTINUOUS function of `arc`, which is what the wrap argument needs:
    // a step count derived from `arc` (say `ceil(arc/h)` uniform steps) is pure but JUMPS where the
    // count changes, and a jump of any size at the wrap is the blink #1333 rejected moving glyphs
    // over. The unrolled bound is the longest a glyph can need — the train's last member at φ → 1.
    //
    // Stepping in SCREEN length rather than in uv is what holds the glyph spacing constant across
    // the frame: a fixed uv step is a different number of pixels at every latitude, on every
    // projection and under any pitch, so a train stepped in uv would bunch toward the horizon.
    const h = Let(spacingPx.div(f32(ARROW_TRAIN_TAPS_PER_SPACING)))
    const aspect = Let(bandAt(u32(S111_BAND_PARAMS_ROW), S111_PARAM_UV_ASPECT))
    const pos = Var(uv0)
    const offPx = Var(vec2(f32(0), f32(0)))
    const remain = Var(arc)
    // THE LAST LIVE FOOTING (#1558). A walk that lands in a dead cell — nodata packs (0,0), and so
    // does genuine calm — used to erase the whole glyph, because re-symbolization sampled the END
    // position and `step(1e-6, speed)` zeroed the size. Measured: ink within ½δ of a dead region is
    // 0.238 against 0.31 in open water, and at a wide zoom that halo is SCREEN-fixed while the
    // cells shrink, so scattered dead cells in real data weld their halos into the reported voids.
    // So the walk remembers the last position whose water was ALIVE (moving, and on the grid), and
    // the glyph re-symbolizes and draws THERE — it stops at the dead boundary instead of vanishing
    // into it. The blend is arithmetic (`x·a + y·(1−a)`), not a component clamp — it selects a
    // POSITION, never turns a direction (`arrow-drift-direction.test.ts` owns that distinction).
    // A glyph still vanishes when its SEED is dead: `posLive` then never leaves `uv0`, the
    // remembered velocity stays 0, and the size product culls it — the standard's "no symbol for
    // speed 0 / noData" holds where it should, on the water the seed is actually in.
    const posLive = Var(uv0)
    const offLive = Var(vec2(f32(0), f32(0)))
    for (let k = 0; k < ARROW_TRAIN_STEPS; k++) {
      // `Let`, AND THIS IS LOAD-BEARING. Each is read by the direction and by the step, and an
      // unbound expression node is re-inlined at every read, texture fetch and all — measured on
      // the predecessor at 38 velocity fetches against 10, on BOTH backends. The only symptom is a
      // silently ~4× more expensive vertex stage, which is why `arrow-density-cull.test.ts` pins
      // the count.
      const vu = Let(loadAtUv(flowUTex.node, pos).x)
      const vv = Let(loadAtUv(flowVTex.node, pos).x)
      const alive = Let(
        step(f32(1e-6), length(vec2(vu, vv)))
          .mul(inUnit(pos.x))
          .mul(inUnit(pos.y)),
      )
      const dead = Let(f32(1).sub(alive))
      posLive.assign(pos.mul(alive).add(posLive.mul(dead)))
      offLive.assign(offPx.mul(alive).add(offLive.mul(dead)))
      // `aspect` re-expresses the metric east/north components as UV RATES. A uv unit is a
      // different true distance on each axis (cell aspect × cos lat), so feeding the components to
      // the basis raw would point the glyph at one angle while the train advanced at another. The
      // minus is grid-v running SOUTHWARD — the identical sign the packer writes its rows in.
      const dirUv = Let(vec2(vu, vv.neg().mul(aspect)))
      const len = Let(min(remain, h))
      const duv = Let(field_uv_step({ m: basis, dir_uv: dirUv, px: len }))
      pos.assign(pos.add(duv))
      offPx.assign(offPx.add(field_uv_to_px(basis, duv)))
      remain.assign(max(remain.sub(len), f32(0)))
    }

    // ── re-symbolize from the water THIS GLYPH IS STANDING IN ─────────────────────────────────
    //
    // Not the water its seed launched from. An arrow that moves while keeping its launch colour is
    // the failure that still looks like a working animation, which is why the advected module
    // binds no tint buffer at all — there is no launch colour to read by accident.
    //
    // STANDING IN, which since #1558 means the last LIVE footing rather than the walk's raw end.
    // The price is half a tap of lag: the loop never samples the final resting position itself,
    // so a glyph stands at most `h = δ/2` short of where the raw end would have re-symbolized —
    // the same cell in almost every frame, and a bounded offset always.
    //
    // ONE interpolated read here (#1565), not the loop's own per-tap samples. The walk above still
    // reads `flow_u_tex`/`flow_v_tex` at the OWNER cell — mortality only needs to know "moving or
    // not", and blurring that test would risk a glyph surviving a step it should have died on. What
    // reads blocky is the ARROW ITSELF — colour, length and heading all coming from one flat,
    // cell-wide value — so the smoothing is spent where it is seen: the single velocity that draws
    // this glyph, blended across valid neighbours of `posLive` (`loadInterpolated`).
    const finalV = loadInterpolated(posLive)
    const dirPx = Let(field_uv_to_px(basis, vec2(finalV.x, finalV.y.neg().mul(aspect))))
    const dlen = Let(max(length(dirPx), f32(1e-6)))
    const cc = Let(dirPx.x.div(dlen))
    const ss = Let(dirPx.y.div(dlen))

    // The catalogue rule, looked up rather than restated: the table's edges and its affine scale
    // pair are uploaded in these same normalized units (s111-portrayal.ts), so nothing here knows
    // a threshold, a colour or a knot.
    const speed = Let(length(vec2(finalV.x, finalV.y)))
    const band = Var(u32(0))
    for (let b = 0; b < S111_BAND_COUNT; b++) {
      band.assign(select(speed.lt(bandAt(u32(b), 0)), band, u32(b + 1)))
    }
    const brow = min(band, u32(S111_BAND_COUNT - 1))
    const scale = Let(bandAt(brow, 1).add(bandAt(brow, 2).mul(speed)))
    // …faded across the train, so the wrap is not a jump. The alpha is a function of ARC LENGTH,
    // which is what makes the seam exact: at φ = 1 glyph `j` sits where glyph `j+1` sat at φ = 0,
    // and `(j + 1 + 0)/G === (j + 1)/G` is the same alpha. The band COLOUR is untouched, so a
    // fading glyph never reads as a different speed band.
    const alpha = Let(arrow_phase_alpha({ phase: glyph.add(phase).div(G) }))

    // ── every reason not to draw, as one product ──────────────────────────────────────────────
    //
    // main.xsl note (4): no symbol for speed 0 or noData — and a packed nodata cell is exactly
    // (0, 0). A zero length collapses the quad, so the glyph is not drawn at all rather than drawn
    // at some floor size in water that has no current. The screen-lattice rejections ride the SAME
    // mechanism — one more 0/1 factor each, no second way for a glyph to not be drawn:
    //   · the node's guessed screen position had no ground under it (off the horizon, past a
    //     projection's edge), or the model put it at or behind the eye plane;
    //   · the node, or the walk's end, is outside the coverage domain;
    //   · the Newton correction did not settle — a MAGNITUDE test, not a per-component clamp, so it
    //     can only reject a glyph and never turn one (`arrow-drift-direction.test.ts`). It fires
    //     where the model's guess landed on unrelated ground, which is past the horizon in practice;
    //     a correction of a few spacings is ordinary and is left alone.
    //   · the node stands on water ANOTHER resident region already owns (#1585) — see below.
    // `posLive` is on-grid by construction (being on-grid is part of `alive`), so the walk-end
    // factor collapses into the seed's own — kept for the seed, which `posLive` starts at.
    const onGrid = Let(
      inUnit(uv0.x).mul(inUnit(uv0.y)).mul(inUnit(posLive.x)).mul(inUnit(posLive.y)),
    )
    const settled = Let(step(length(fixPx), spacingPx.mul(f32(FIELD_NEWTON_SPACINGS))))
    // THE MOSAIC OVERLAP CULL (#1585). Two regions whose footprints overlap each enumerate a full
    // lattice over the shared water, and before this both drew on it — doubling the glyph density
    // there. On a chart that is a misreading, not a blemish: `arrow-drift.ts` states the rule
    // ("overlapping SCAROW symbols read as a faster current than the data says"), and it is the same
    // rule `ARROW_LATTICE_FACTOR` exists to keep. So a node whose ground is owned by an
    // earlier-armed region is dropped here, through the same product every other rejection uses.
    //
    // TESTED AT THE SEED (`ll`), not at the walk's end. A train belongs to the region its seed is
    // in, and its glyphs stay with it even where the streamline carries them across the boundary —
    // which is what keeps the count right: exactly one seed per patch of water owns the trains on
    // it, and a train is never half-drawn by one region and half by another.
    const ownedElsewhere = Let(field_owned_elsewhere({ lonlat: ll.swizzle('xy') }))
    const size = Let(
      basePx
        .mul(scale)
        .mul(step(f32(1e-6), speed))
        .mul(onGrid)
        .mul(settled)
        .mul(f32(1).sub(ownedElsewhere))
        .mul(guess.z)
        .mul(step(f32(0.5), ll.z)),
    )

    // ── place the quad, in device pixels, then once into NDC ──────────────────────────────────
    //
    // The static VS offsets a PROJECTED clip position and scales by `clip.w` to stay
    // perspective-correct. Here the glyph's screen position is known outright — the node is a
    // lattice coordinate and the train offset is already in pixels — so the quad is assembled in
    // px and converted once, with `w = 1`. Nothing is divided by another anchor's `w`, which is
    // also why this path cannot reproduce the "particles fly off into space" failure the
    // two-basis predecessor needed a perspective guard for: there is no second `w` to cross zero.
    const margin = Let(av.eye.w)
    const { qx, qy } = arrowQuadOffset(p.vi, margin)
    const lx = qx.mul(size)
    const ly = qy.mul(size)
    const nodeX = Let(ndc.x.add(f32(1)).mul(f32(0.5)).mul(vp.x).add(fixPx.x))
    const nodeY = Let(f32(1).sub(ndc.y).mul(f32(0.5)).mul(vp.y).add(fixPx.y))
    const px = Let(nodeX.add(offLive.x).add(lx.mul(cc)).sub(ly.mul(ss)))
    const py = Let(nodeY.add(offLive.y).add(lx.mul(ss)).add(ly.mul(cc)))

    const o = ArrowOut.var()
    o.position.assign(
      vec4(
        px
          .div(max(vp.x, f32(1)))
          .mul(f32(2))
          .sub(f32(1)),
        f32(1).sub(py.div(max(vp.y, f32(1))).mul(f32(2))),
        f32(0),
        f32(1),
      ),
    )
    o.loc.assign(vec2(qx, qy))
    o.tint.assign(
      vec4(bandAt(brow, 4), bandAt(brow, 5), bandAt(brow, 6), bandAt(brow, 7).mul(alpha)),
    )
    // The horizon cull the static path needs is already done: `ray_hit_sphere_enu` returns the NEAR
    // root, so a node whose ray reaches the earth at all reaches the VISIBLE side of it. What is
    // left to report is the miss itself, and it rides the same interpolant the FS already discards
    // on — so a node with no ground under it costs no fragment rather than a zero-area quad.
    o.cos_c.assign(select(ll.z.gt(f32(0.5)), f32(1), f32(-1)))
    o.stroke_units.assign(margin)
    return o.$
  },
  { stage: 'vertex' },
)

/** The ADVECTED module — same projection ladder, same fragment stage, same output struct; a
 *  different VS and the resources it needs. No tint buffer: the colour is the band the glyph is
 *  standing in, not the one its seed launched with. */
export const buildArrowRetainedAdvectedModule = (): ModuleDecl =>
  module({
    consts: [...PROJECTION_CONSTS],
    structs: [pointU.struct, fieldViewU.struct, ArrowOut.decl],
    bindings: [
      pointU.binding,
      bandB.binding,
      flowUTex.binding,
      flowVTex.binding,
      fieldViewU.binding,
      flowValidTex.binding,
    ],
    funcs: [
      ...getGpuProjectionFuncs(),
      ...UNPROJECT_FUNCS,
      ...FIELD_LATTICE_FUNCS,
      arrow_phase_offset,
      arrow_phase_alpha,
      vsAdvected,
      fs,
    ],
  })

export const emitArrowRetainedAdvectedWgsl = (): string =>
  emitModule(buildArrowRetainedAdvectedModule())

/** GLSL ES 3.00 twin of the advected module. The default lowering turns the band table into an R32F
 *  data texture exactly as the static path does; the velocity textures are real textures on both
 *  arms and are read with `texelFetch`, which needs no sampler and so needs no vertex-visible
 *  sampler either. */
export const emitArrowRetainedAdvectedGlsl = (stage: 'vertex' | 'fragment'): string => {
  const m = buildArrowRetainedAdvectedModule()
  const keep = stage === 'vertex' ? 'vs_arrow_retained_advected' : 'fs_arrow_retained'
  return emitGlslModule(
    { ...m, funcs: m.funcs.filter((f) => stageOf(f) === undefined || f.name === keep) },
    stage,
  )
}

/** Both GLSL stages from ONE lowering (see emitGlslStages). The per-stage twin above prunes the
 *  module before each emit, so it lowers + runs the optimizer fixpoint twice; naming the entries
 *  instead shares it. Byte-identical to two calls of the per-stage form — pinned by
 *  map/src/render/material/glsl-stage-entry-parity.test.ts. */
export const emitArrowRetainedAdvectedGlslStages = (): { vertex: string; fragment: string } =>
  emitGlslStages(buildArrowRetainedAdvectedModule(), {
    vertexEntry: 'vs_arrow_retained_advected',
    fragmentEntry: 'fs_arrow_retained',
  })
