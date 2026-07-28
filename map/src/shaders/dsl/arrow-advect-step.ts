// ═══ Shader DSL — advance every S-111 arrow along the current (#1409) ═══
//
// One fragment = one ARROW. The pass runs over the arrow-position state texture (128×128),
// not over the coverage grid, so "how many arrows are in flight" and "how big is the data"
// are independent numbers — a global field animates at the same cost as a harbour.
//
// The velocity pair is the INPUT here and only that. `u_tex`/`v_tex` carry the S-111 current
// as normalized [-1,1] components (flow-field-pack.ts); this shader reads them at the position
// an arrow currently occupies and moves that arrow. Nothing here draws anything — the picture
// is the catalogue SCAROW glyph, drawn by the arrow VS from the state this writes, and
// re-symbolized there from the data under its NEW position.
//
// THE Y SIGN, derived rather than asserted (same derivation as flow-advect.ts, opposite sign
// because this steps FORWARD in time and that one steps backward):
//   uv.x increases EASTWARD  — origin is the SW cell centre, lon = originLon + col·dLon.
//   uv.y increases SOUTHWARD — row 0 is the NORTHERNMOST row (coverage-arrow-show.ts:85), and
//     packFlowFieldUV preserves row order.
// So a NORTHWARD current (+v) must DECREASE uv.y: next.y = pos.y − v·stepY.
// Getting this backwards produces a field that flows smoothly against its own arrowheads.
//
// RESPAWN. An arrow that leaves the domain, or that lands where there is no current, has to be
// recycled. The earlier objection to this — a recycled glyph needs a fade, and a fade on a
// large recognizable glyph reads as a blink (#1333's design note) — was the stated reason for
// keeping the motion in a separate layer, and it is not a reason to reject the user's design.
// It is a thing to handle: recycling is spread by a per-arrow speed-biased lottery, so arrows
// retire a few at a time out of 16 384 rather than in visible waves.
//
// AN ARROW IS ON A LEASH, and recycles to its OWN origin (#1419). Both halves are what makes
// the drawn glyph land where the data it reports actually is: the arrow VS maps a grid-uv
// displacement to screen by SCALING a pair of basis vectors the CPU projected, from the origin
// to origin+ARROW_DRIFT_UV in each grid axis. That linearization holds over the range the
// basis spans and nowhere else, so an arrow free to wander the whole domain — which a respawn
// to a uniformly random uv also produces immediately — would be drawn by extrapolating the
// basis 20× its length. Bounding the excursion is therefore not a look choice; it is the
// condition under which the position is right at all.
//
// Bindings (texture/sampler INTERLEAVED — WebGL2 binds a sampler object to the LAST texture
// unit touched, rhi-webgl2.ts:372, so a sampler must follow its own texture):
//   0 = state_tex   previous arrow positions       1 = state_samp  (nearest — exact texel)
//   2 = u_tex       east component, r16float       3 = u_samp      (linear)
//   4 = v_tex       north component, r16float      5 = v_samp      (linear)
//   6 = u           ArrowAdvectParams
//   7 = origin_tex  where each arrow belongs — NO sampler: it is read with textureLoad at this
//                   fragment's own texel, which is exact by construction and keeps the
//                   interleaving rule above trivially satisfied (nothing to interleave).
//
import {
  fn,
  module,
  f32,
  vec2,
  vec3,
  vec4,
  fract,
  floor,
  sqrt,
  abs,
  max,
  step,
  mix,
  textureSample,
  textureLoad,
  textureDimensions,
  toF32,
  toI32,
  vec2i,
  u32,
  Var,
  If,
  Let,
  u32T,
  f32T,
  vec2fT,
  vec4fT,
  texture2dfT,
  samplerT,
  type ModuleDecl,
} from '@xgis/shader-dsl'
import { ioStruct, builtin, location, uniformStruct, resource } from '@xgis/shader-dsl'
import { emitModule, emitGlslModule, stageOf } from '@xgis/shader-dsl'

const U = uniformStruct(
  'ArrowAdvectParams',
  { group: 0, binding: 6, as: 'u' },
  {
    // x,y = grid-uv displacement for ONE frame at a normalized component of 1 (the CPU folds in
    //       the peak speed, the grid's degree extent, cos(lat) and the frame delta —
    //       flow-advect-params.ts, shared with the trail step so the two cannot disagree).
    // z   = base respawn probability per frame.
    // w   = EXTRA respawn probability per unit of normalized speed.
    step: vec4fT,
    // x = per-frame random seed; y,z,w pad.
    seed: vec4fT,
  },
)

const VsOut = ioStruct('ArrowAdvectOut', {
  pos: builtin('position', vec4fT),
  uv: location(0, vec2fT),
})

const stateTex = resource('state_tex', texture2dfT, { group: 0, binding: 0 })
const stateSamp = resource('state_samp', samplerT, { group: 0, binding: 1 })
const uTex = resource('u_tex', texture2dfT, { group: 0, binding: 2 })
const uSamp = resource('u_samp', samplerT, { group: 0, binding: 3 })
const vTex = resource('v_tex', texture2dfT, { group: 0, binding: 4 })
const vSamp = resource('v_samp', samplerT, { group: 0, binding: 5 })
const originTex = resource('origin_tex', texture2dfT, { group: 0, binding: 7 })

/** THE LEASH — how far, in grid-uv, an arrow may drift from its own origin before it recycles.
 *
 *  Lives here, with the pass that enforces it, and is imported by the two places that must
 *  agree with it: the generator packs each instance's basis anchors at exactly this distance,
 *  and the arrow VS divides the displacement by it. One number, three consumers, no restatement.
 *
 *  5% of the grid span is ~30 cells on a 596×433 CBOFS grid — unmistakably motion, still local
 *  enough for the VS's two-basis linearization to be accurate over the whole excursion. */
export const ARROW_DRIFT_UV = 0.05

/** rgba8 → grid-uv. r/g hold the LOW byte of x/y, b/a the HIGH byte, so each axis carries 16
 *  bits across two channels — see arrow-advect-state.ts, whose CPU seed writes this same layout
 *  and whose `decodeArrowPosition` is the numeric twin this must agree with.
 *
 *  EXPORTED because the advected arrow VS decodes the same two textures (#1419). It takes this
 *  fn OBJECT, so both modules emit one definition of it and a change to the encoding cannot
 *  reach the update without reaching the draw — the drift that would show up as arrows which
 *  advect correctly and are DRAWN somewhere else. */
export const decodeArrowPos = fn('decode_arrow_pos', { c: vec4fT }, (a) =>
  vec2(a.c.z.add(a.c.x.div(f32(255))), a.c.w.add(a.c.y.div(f32(255)))),
)

/** grid-uv → rgba8, the exact inverse: high = floor(p·255)/255, low = fract(p·255). */
const encodeArrowPos = fn('encode_arrow_pos', { p: vec2fT }, (a) => {
  const s = Let(a.p.mul(f32(255)))
  return vec4(fract(s.x), fract(s.y), floor(s.x).div(f32(255)), floor(s.y).div(f32(255)))
})

/** Value noise from a 2D cell + a seed, `fract`/`mul` only (Hoskins' "hash without sine").
 *  Deliberately NOT sine-based: the sine hash's quality at large arguments is driver-dependent,
 *  and this runs on both the WGSL and GLSL arms where those differ. */
const hash = fn('arrow_advect_hash', { p: vec2fT, seed: f32T }, (a) => {
  const p3 = Let(fract(vec3(a.p.x, a.p.y, a.p.x.add(a.seed)).mul(f32(0.1031))))
  // dot(p3, p3.yzx + 33.33), expanded — the DSL has no `dot` in this surface.
  const d = Let(
    p3.x
      .mul(p3.y.add(f32(33.33)))
      .add(p3.y.mul(p3.z.add(f32(33.33))))
      .add(p3.z.mul(p3.x.add(f32(33.33)))),
  )
  const q = Let(p3.add(vec3(d, d, d)))
  return fract(q.x.add(q.y).mul(q.z))
})

/** Oversized fullscreen triangle (NDC −1..3) covering the STATE texture. No camera here. */
const vsFull = fn(
  'vs_arrow_advect',
  { idx: builtin('vertex_index', u32T) },
  (p) => {
    const pos = Var(vec2(-1, -1))
    If(p.idx.eq(1), () => {
      pos.assign(vec2(3, -1))
    }).elif(p.idx.eq(2), () => {
      pos.assign(vec2(-1, 3))
    })
    const o = VsOut.var()
    o.pos.assign(vec4(pos, 0, 1))
    o.uv.assign(vec2(pos.x.add(1).mul(0.5), f32(1).sub(pos.y.add(1).mul(0.5))))
    return o.$
  },
  { stage: 'vertex' },
)

const fsUpdate = fn(
  'fs_arrow_advect',
  { in: VsOut },
  (p) => {
    const uv = p.in.uv
    const prev = Let(textureSample(stateTex.node, stateSamp.node, uv))
    const pos = Let(decodeArrowPos({ c: prev }))

    // This arrow's own origin cell. textureLoad at THIS fragment's texel: origin texel i and
    // instance i are the same arrow (arrow-advect-state.ts), so the fetch is exact and needs no
    // sampler. Both this pass and the arrow VS read the SAME texture, so "where did arrow i
    // start" has one answer — the encoding-drift failure the state module's header warns about
    // (arrows that advect correctly and are DRAWN somewhere else) has no room to happen here.
    const dimU = textureDimensions(originTex.node)
    const texel = Let(vec2i(toI32(uv.x.mul(toF32(dimU.x))), toI32(uv.y.mul(toF32(dimU.y)))))
    const origin = Let(decodeArrowPos({ c: textureLoad(originTex.node, texel, u32(0)) }))

    // Velocity WHERE THE ARROW IS — not where this texel is. The state texture's uv has no
    // geographic meaning at all; it is just which arrow we are.
    const vu = Let(textureSample(uTex.node, uSamp.node, pos).x)
    const vv = Let(textureSample(vTex.node, vSamp.node, pos).x)

    const next = Let(vec2(pos.x.add(vu.mul(U.field.step.x)), pos.y.sub(vv.mul(U.field.step.y))))

    // ── Respawn ──────────────────────────────────────────────────────────────────────────
    // Two independent reasons, OR'd as a max of two 0/1 terms (no branch — a texture fetch
    // inside divergent control flow is the thing to avoid, and there is nothing to skip here):
    //
    //  (a) LEFT THE DOMAIN. A coverage cell is bounded; an arrow that walks off the edge has
    //      no data to follow and would otherwise stick to the clamped border forever, drawing a
    //      bright rim that reads as a coastline artifact.
    //  (b) LOTTERY, biased by speed. Without it every arrow drifts into the field's
    //      convergence zones and the fast water empties out — the classic failure of an
    //      un-recycled advection. Biasing by speed keeps the FAST regions refreshed (they are
    //      the ones being emptied), and it spreads retirement so no wave of arrows blinks out
    //      together.
    //
    //  (c) THE LEASH. Past ARROW_DRIFT_UV from its own origin the arrow is outside the range
    //      its screen basis was built for (see the header), so it is recycled while it is
    //      still drawn where it belongs rather than drifting into a wrong position.
    //
    // `step(edge, x)` is exactly 0 or 1, and `max` of those is exactly 0 or 1, so the `mix`
    // below is an exact select — an arrow that is NOT recycled keeps its advected position
    // bit-for-bit rather than being nudged by a fractional blend.
    const outside = Let(
      max(
        max(step(next.x, f32(0)), step(f32(1), next.x)),
        max(step(next.y, f32(0)), step(f32(1), next.y)),
      ),
    )
    const speed = Let(sqrt(vu.mul(vu).add(vv.mul(vv))))
    const drop = Let(U.field.step.z.add(speed.mul(U.field.step.w)))
    const lottery = Let(step(hash({ p: pos, seed: U.field.seed.x }), drop))
    // Chebyshev distance, not Euclidean: the two axes are leashed independently because the
    // VS's two bases are independent, and it saves a sqrt on the frame path.
    const drift = Let(max(abs(next.x.sub(origin.x)), abs(next.y.sub(origin.y))))
    const leashed = Let(step(f32(ARROW_DRIFT_UV), drift))
    const respawn = Let(max(max(outside, lottery), leashed))

    // Recycled arrows return to their OWN origin — the cell the catalogue placed them in — not
    // to a random position. A random respawn scatters instance i anywhere in the domain, which
    // its packed basis anchors cannot describe (header). Returning to the origin also means
    // every arrow's first frame after recycling is exactly the static portrayal's placement.
    const finalPos = Let(vec2(mix(next.x, origin.x, respawn), mix(next.y, origin.y, respawn)))
    return encodeArrowPos({ p: finalPos })
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

// GL twin of the fullscreen VS with the V axis NON-flipped: a GL FBO stores clip y=−1 at texture
// row 0, the inverse of WebGPU's v=0-at-top. The pass READS and WRITES the same ping-pong pair,
// so texel i must map to texel i on both arms or every arrow would swap identities each
// frame. Same fn name so the Material's vsEntry is backend-identical.
const vsFullGl = fn(
  'vs_arrow_advect',
  { idx: builtin('vertex_index', u32T) },
  (p) => {
    const pos = Var(vec2(-1, -1))
    If(p.idx.eq(1), () => {
      pos.assign(vec2(3, -1))
    }).elif(p.idx.eq(2), () => {
      pos.assign(vec2(-1, 3))
    })
    const o = VsOut.var()
    o.pos.assign(vec4(pos, 0, 1))
    o.uv.assign(vec2(pos.x.add(1).mul(0.5), pos.y.add(1).mul(0.5)))
    return o.$
  },
  { stage: 'vertex' },
)

const ARROW_ADVECT_MODULE: ModuleDecl = module({
  structs: [U.struct, VsOut.decl],
  bindings: [
    stateTex.binding,
    stateSamp.binding,
    uTex.binding,
    uSamp.binding,
    vTex.binding,
    vSamp.binding,
    U.binding,
    originTex.binding,
  ],
  funcs: [decodeArrowPos, encodeArrowPos, hash, vsFull, fsUpdate],
})

/** Advance every arrow one frame along the velocity field, recycling the strays. */
export const emitArrowAdvectWgsl = (): string => emitModule(ARROW_ADVECT_MODULE)

/** GLSL ES 3.00 twin (#1046: dual-source DSL, never a backend fork). */
export const emitArrowAdvectGlsl = (stage: 'vertex' | 'fragment'): string => {
  const funcs =
    stage === 'vertex'
      ? [vsFullGl]
      : ARROW_ADVECT_MODULE.funcs.filter(
          (f) => stageOf(f) === undefined || f.name === 'fs_arrow_advect',
        )
  return emitGlslModule({ ...ARROW_ADVECT_MODULE, funcs }, stage)
}

/** The vertex count the fullscreen triangle draws. */
export const ARROW_ADVECT_VERTEX_COUNT = 3
