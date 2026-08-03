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
  tex: Parameters<typeof textureDimensions>[0],
  uv: { x: ReturnType<typeof f32>; y: ReturnType<typeof f32> },
) => {
  const d = textureDimensions(tex)
  const owner = (t: ReturnType<typeof f32>, n: ReturnType<typeof toF32>) =>
    toI32(clamp(floor(t.mul(n.sub(1)).add(0.5)), f32(0), n.sub(1)))
  const c = vec2i(owner(uv.x, toF32(d.x)), owner(uv.y, toF32(d.y)))
  return textureLoad(tex, c, u32(0))
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
    for (let k = 0; k < ARROW_TRAIN_STEPS; k++) {
      // `Let`, AND THIS IS LOAD-BEARING. Each is read by the direction and by the step, and an
      // unbound expression node is re-inlined at every read, texture fetch and all — measured on
      // the predecessor at 38 velocity fetches against 10, on BOTH backends. The only symptom is a
      // silently ~4× more expensive vertex stage, which is why `arrow-density-cull.test.ts` pins
      // the count.
      const vu = Let(loadAtUv(flowUTex.node, pos).x)
      const vv = Let(loadAtUv(flowVTex.node, pos).x)
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
    const vu = Let(loadAtUv(flowUTex.node, pos).x)
    const vv = Let(loadAtUv(flowVTex.node, pos).x)
    const dirPx = Let(field_uv_to_px(basis, vec2(vu, vv.neg().mul(aspect))))
    const dlen = Let(max(length(dirPx), f32(1e-6)))
    const cc = Let(dirPx.x.div(dlen))
    const ss = Let(dirPx.y.div(dlen))

    // The catalogue rule, looked up rather than restated: the table's edges and its affine scale
    // pair are uploaded in these same normalized units (s111-portrayal.ts), so nothing here knows
    // a threshold, a colour or a knot.
    const speed = Let(length(vec2(vu, vv)))
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
    const onGrid = Let(inUnit(uv0.x).mul(inUnit(uv0.y)).mul(inUnit(pos.x)).mul(inUnit(pos.y)))
    const settled = Let(step(length(fixPx), spacingPx.mul(f32(FIELD_NEWTON_SPACINGS))))
    const size = Let(
      basePx
        .mul(scale)
        .mul(step(f32(1e-6), speed))
        .mul(onGrid)
        .mul(settled)
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
    const px = Let(nodeX.add(offPx.x).add(lx.mul(cc)).sub(ly.mul(ss)))
    const py = Let(nodeY.add(offPx.y).add(lx.mul(ss)).add(ly.mul(cc)))

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

/** GLSL ES 3.00 twin of the advected module. `emulateStorage` lowers the band table to an R32F
 *  data texture exactly as the static path does; the velocity textures are real textures on both
 *  arms and are read with `texelFetch`, which needs no sampler and so needs no vertex-visible
 *  sampler either. */
export const emitArrowRetainedAdvectedGlsl = (stage: 'vertex' | 'fragment'): string => {
  const m = buildArrowRetainedAdvectedModule()
  const keep = stage === 'vertex' ? 'vs_arrow_retained_advected' : 'fs_arrow_retained'
  return emitGlslModule(
    { ...m, funcs: m.funcs.filter((f) => stageOf(f) === undefined || f.name === keep) },
    stage,
    { emulateStorage: true },
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
    emulateStorage: true,
  })
