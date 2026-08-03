// ═══ The ADVECTED arrow module — streamline trains on a SCREEN lattice (#1520 step 2) ═══
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
// So the instance set is generated from the OUTPUT. Instance `i` is `(seed, glyph j)`; the seed is
// a node of a lattice on the SCREEN, at a spacing the screen chooses; and the geography under it is
// recovered by the backward map (`unproject-dsl.ts` / `arrow-view.ts`). Density is then constant
// per screen area at EVERY zoom by construction, rather than by a rule that has to track the grid.
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
// ── THE LATTICE IS ANCHORED TO THE SCREEN, AND THAT IS THE TRADE ──────────────────────────────
//
// A seed sits at a fixed viewport position, so panning slides the field over the water rather than
// carrying it along. The alternative — snapping each seed to a ground lattice — was rejected, and
// the reason is not taste: two adjacent screen nodes then snap to the SAME ground node (drawing one
// train twice) while others get none, which is a visibly clumped field, and the quantisation level
// has to change at some zoom, where every train jumps at once. Screen anchoring has neither
// failure. The phase jitter is therefore a function of the SEED INDEX, not of its uv: a hash of the
// uv would re-roll every glyph's phase as the camera moved, which is the pulse the jitter exists to
// prevent.

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
  exp2,
  log2,
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
  arrowViewU,
  ARROW_VIEW_FUNCS,
  ARROW_TRAIN_GLYPHS,
  ARROW_TRAIN_STEPS,
  ARROW_TRAIN_TAPS_PER_SPACING,
  ARROW_LATTICE_FACTOR,
  arrow_seed_ndc,
  arrow_screen_lonlat,
  arrow_grid_uv,
  arrow_uv_basis,
  arrow_uv_step,
  arrow_uv_to_px,
} from './arrow-view'
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
    const av = arrowViewU.field
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

    // ── the seed node, and the geography under it ─────────────────────────────────────────────
    const ndc = Let(arrow_seed_ndc({ seed, nx, ny }))
    const ll = Let(arrow_screen_lonlat({ ndc }))
    const uv0 = Let(arrow_grid_uv({ lonlat: ll.swizzle('xy') }))
    // Pixels per unit of grid-uv at this node — what replaces the two packed basis anchors the
    // per-cell generator used to ship. Zero when the node has no ground under it.
    const basis = Let(arrow_uv_basis({ ndc, lon: ll.x, lat: ll.y }))

    // ── SNAP THE SEED TO THE GROUND, so the field belongs to the map and not to the viewport ──
    //
    // Reported: the field read as detached — panning slid the map underneath a lattice that stayed
    // put. That is what a purely screen-anchored seed does, and it was a deliberate trade the
    // first cut made for a reason that turns out to be avoidable.
    //
    // ENUMERATION STAYS ON THE SCREEN; only the POSITION is snapped. That is the whole trick.
    // Walking a ground lattice directly would need a forward projection per seed — which needs a
    // DSFUN-split anchor per instance, which is precisely the per-cell generator #1520 removed.
    // Snapping instead keeps the screen's coverage guarantee (every viewport pixel is near a node,
    // at every zoom) and moves the node onto a ground position, and the correction is at most half
    // a lattice cell (~34 px) — well inside the basis's own validity, which the train already
    // relies on over four times that distance.
    //
    // THE LATTICE IS ANCHORED AT uv 0 AND ITS STEP IS A POWER OF TWO, so it belongs to the
    // COVERAGE GRID rather than to the camera: panning never moves it, and a zoom change halves or
    // doubles it, which leaves half the nodes exactly where they were instead of relocating all of
    // them. The step is the power of two nearest the seed spacing on screen — see `pow2Near`.
    // The lattice node's own screen position, needed both by the ownership test below and by the
    // final placement; bound once so the two cannot drift apart.
    const nodeScreenX = Let(ndc.x.add(f32(1)).mul(f32(0.5)).mul(vp.x))
    const nodeScreenY = Let(f32(1).sub(ndc.y).mul(f32(0.5)).mul(vp.y))
    const latticePx = Let(spacingPx.mul(f32(ARROW_LATTICE_FACTOR)))
    const pxPerU = Let(max(length(vec2(basis.x, basis.z)), f32(1e-6)))
    const pxPerV = Let(max(length(vec2(basis.y, basis.w)), f32(1e-6)))
    // ROUNDED in log space, not `ceil`ed. `ceil` was tried and measured: it only ever rounds the
    // step UP, so the ground lattice comes out between 1x and 2x the screen spacing on each axis —
    // up to 4x fewer distinct nodes than the density rule asks for. That cost 23 % of the field
    // (z13 21 583 -> 16 836 painted px) and opened holes GATE 4 caught. Rounding to the NEAREST
    // power of two keeps the spacing in [S/√2, S·√2], so the node count stays within √2 either way
    // and averages right, while the power-of-two anchoring that makes a zoom change relocate only
    // half the nodes is untouched.
    const pow2Near = (v: ReturnType<typeof f32>) =>
      exp2(floor(log2(max(v, f32(1e-12))).add(f32(0.5))))
    const stepU = Let(pow2Near(latticePx.div(pxPerU)))
    const stepV = Let(pow2Near(latticePx.div(pxPerV)))
    const uvSeed = Let(
      vec2(
        floor(uv0.x.div(stepU).add(f32(0.5))).mul(stepU),
        floor(uv0.y.div(stepV).add(f32(0.5))).mul(stepV),
      ),
    )
    /** How far the snap moved this node, in device px. Bounded by half a lattice cell. */
    const snapPx = Let(arrow_uv_to_px(basis, uvSeed.sub(uv0)))

    // ── DUPLICATES ARE LEFT ALONE, AND THAT IS A MEASUREMENT RATHER THAN A SHRUG ─────────────
    //
    // Snapping is many-to-one at the margins: two neighbouring screen nodes can round to the same
    // ground node. An ownership test was written for that — claim the node only if the snapped
    // position lands back in your own screen cell — and it was MEASURED to be worse on every axis
    // there is a gate for: 23 % of the field disappeared (z13 21 583 -> 16 570 painted px) and
    // GATE 4 went from 0 to 3 blocks of empty water.
    //
    // The argument it rested on was wrong, and the reason is worth keeping. "Exactly one claimant,
    // never zero" needs neighbouring nodes to agree about WHICH lattice they are snapping to; they
    // do not, because each derives its step from its OWN basis and the basis varies across the
    // frame (that variation is the whole point of a per-node basis — it is what makes the field
    // thin correctly under pitch). Two cells that disagree about the step can both decline the
    // same ground node, and that is a hole.
    //
    // What a duplicate actually costs here is small, and smaller than it was before this block:
    // the phase is hashed from the GROUND index, so two claimants draw the SAME train at the SAME
    // position with the SAME phase — perfectly coincident, not two trains side by side. The only
    // residue is one extra alpha-blend, `1 − (1 − a)²`, which at the catalogue's near-opaque band
    // alpha is not a visible difference. A hole is visible; this is not.
    // ── where this glyph is along the train ───────────────────────────────────────────────────
    //
    // The clock is the frame uniform's animation lane (circle_params.y, seconds) — already written
    // O(1)/frame by the retained path and already pinnable (`?animt`) for a deterministic capture,
    // which is what makes this field reproducible in a render gate.
    //
    // The jitter is hashed from the seed's GROUND INDEX — `uvSeed / step`, an integer that names
    // the ground node rather than the screen cell that happened to find it. That is what makes a
    // phase survive a pan: the same water keeps the same phase as it crosses the viewport, so the
    // field flows instead of boiling. Hashing the raw uv would do the opposite (it changes with
    // every camera move), and hashing the SCREEN index would pin the phase to the viewport, which
    // is the detachment this whole block removes.
    const phase = Let(
      fract(
        pointU.field.circle_params.y
          .div(f32(ARROW_PHASE_SECONDS))
          .add(arrow_phase_offset({ p: vec2(uvSeed.x.div(stepU), uvSeed.y.div(stepV)) })),
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
    const pos = Var(uvSeed)
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
      const duv = Let(arrow_uv_step({ m: basis, dir_uv: dirUv, px: len }))
      pos.assign(pos.add(duv))
      offPx.assign(offPx.add(arrow_uv_to_px(basis, duv)))
      remain.assign(max(remain.sub(len), f32(0)))
    }

    // ── re-symbolize from the water THIS GLYPH IS STANDING IN ─────────────────────────────────
    //
    // Not the water its seed launched from. An arrow that moves while keeping its launch colour is
    // the failure that still looks like a working animation, which is why the advected module
    // binds no tint buffer at all — there is no launch colour to read by accident.
    const vu = Let(loadAtUv(flowUTex.node, pos).x)
    const vv = Let(loadAtUv(flowVTex.node, pos).x)
    const dirPx = Let(arrow_uv_to_px(basis, vec2(vu, vv.neg().mul(aspect))))
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
    //   · the seed had no ground under it (off the horizon, past a projection's edge);
    //   · the seed, or the walk's end, is outside the coverage domain;
    const onGrid = Let(inUnit(uvSeed.x).mul(inUnit(uvSeed.y)).mul(inUnit(pos.x)).mul(inUnit(pos.y)))
    const size = Let(
      basePx
        .mul(scale)
        .mul(step(f32(1e-6), speed))
        .mul(onGrid)
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
    // The seed's screen position is the lattice node MOVED ONTO ITS GROUND NODE — that offset is
    // what makes the glyph pan with the map.
    const nodeX = Let(nodeScreenX.add(snapPx.x))
    const nodeY = Let(nodeScreenY.add(snapPx.y))
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
    structs: [pointU.struct, arrowViewU.struct, ArrowOut.decl],
    bindings: [
      pointU.binding,
      bandB.binding,
      flowUTex.binding,
      flowVTex.binding,
      arrowViewU.binding,
    ],
    funcs: [
      ...getGpuProjectionFuncs(),
      ...UNPROJECT_FUNCS,
      ...ARROW_VIEW_FUNCS,
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
