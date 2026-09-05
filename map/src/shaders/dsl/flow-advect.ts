// ═══ Shader DSL — IBFV flow advection, in GRID space (#1333) ═══
//
// One step of van Wijk's Image-Based Flow Visualization over an S-100 vector field
// (design: docs/plans/2026-07-27-grid-vector-field-flow-visualization.md). Each frame the
// previous flow image is resampled at the position reached by stepping BACKWARD along the
// velocity field, decayed, and blended with a time-varying noise pattern. The eye integrates
// the result into a sense of current.
//
// THE POINT OF THE WHOLE TECHNIQUE, and the reason it replaced the arrow-glyph drift: there
// are NO PARTICLES here, so there is nothing to recycle, so there is no lifetime, no fade,
// and no respawn. The blink that the drift model forced is not tuned away — it is
// unrepresentable. A `fract`-driven phase, a lifetime, or a fade term appearing anywhere in
// this file would mean the technique has been reverted by accident; flow-advect.test.ts
// asserts their absence.
//
// GRID SPACE, NOT SCREEN SPACE (design §3.2.1). The pass runs over the coverage's own raster,
// so `uv` IS field uv and the advection is pure texture math. Two defects are avoided:
//   - a screen-space pass would need a per-fragment screen→geo inverse, which is exactly the
//     Mercator-only bake that coverage-ramp.ts's tessellation was introduced to retire;
//   - screen-space history is invalidated by camera motion, so panning would smear or reset
//     the animation.
// It follows that this module imports NOTHING from ./projections — and must not. The drawing
// of the advected field onto the map is a separate concern, handled by the existing
// tessellated coverage drape, which is already projection-general and globe-capable.
//
// Bindings:
//   0 = prev_tex   previous flow image (filterable; sampled at the back-stepped uv)
//   1 = u_tex      east velocity component, r16float, normalized to [-1,1]  (flow-field-pack)
//   2 = v_tex      north velocity component, r16float, normalized to [-1,1]
//   3 = samp       linear sampler, shared by all three
//   4 = u          AdvectParams

import {
  fn,
  module,
  f32,
  u32,
  vec2,
  vec3,
  vec4,
  fract,
  saturate,
  textureSample,
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
import { emitModule, emitGlslModule, emitGlslStages, stageOf } from '@xgis/shader-dsl'

/** Noise cell count across the grid. Higher = finer streaks. The noise is what the flow
 *  CARRIES; it is deliberately not a particle, so its granularity is a look control, never a
 *  count that has to be tuned against the data size. */
const NOISE_CELLS = 320

const U = uniformStruct(
  'AdvectParams',
  { group: 0, binding: 4, as: 'u' },
  {
    // x,y = velocity → grid-uv displacement for ONE frame (CPU folds in the field's peak
    //       speed, the grid extent and the frame delta, so the shader stays unit-free).
    // z   = decay applied to the advected history each frame (0..1).
    // w   = noise injection weight each frame (0..1).
    step: vec4fT,
    // x = noise animation phase; y,z,w pad.
    phase: vec4fT,
  },
)

const VsOut = ioStruct('FlowAdvectOut', {
  pos: builtin('position', vec4fT),
  uv: location(0, vec2fT),
})

const prevTex = resource('prev_tex', texture2dfT, { group: 0, binding: 0 })
const uTex = resource('u_tex', texture2dfT, { group: 0, binding: 1 })
const vTex = resource('v_tex', texture2dfT, { group: 0, binding: 2 })
const samp = resource('samp', samplerT, { group: 0, binding: 3 })

// Oversized fullscreen triangle (NDC −1..3) — the overdraw/heatmap-compose trick. This covers
// the GRID target, not the screen; there is no camera here.
const vsFull = fn(
  'vs_flow_advect',
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

/** Value noise from a 2D cell + a phase, built from fract/mul only (Hoskins' "hash without
 *  sine" shape). Deliberately NOT `sin`-based: the sine hash's quality is driver-dependent at
 *  large arguments, and this runs on both the WGSL and GLSL arms where those differ. */
const hash = fn('flow_hash', { p: vec2fT, phase: f32T }, (a) => {
  const p3 = Let(fract(vec3(a.p.x, a.p.y, a.p.x.add(a.phase)).mul(f32(0.1031))))
  // dot(p3, p3.yzx + 33.33), expanded by hand. The DSL does have `dot` (line.ts and
  // hillshade.ts import it); this stays expanded because rewriting it would move the
  // baked bytes for no pixel — a byte-identical refactor is the only reason to touch it.
  const d = Let(
    p3.x
      .mul(p3.y.add(f32(33.33)))
      .add(p3.y.mul(p3.z.add(f32(33.33))))
      .add(p3.z.mul(p3.x.add(f32(33.33)))),
  )
  const q = Let(p3.add(vec3(d, d, d)))
  return fract(q.x.add(q.y).mul(q.z))
})

const fsAdvect = fn(
  'fs_flow_advect',
  { in: VsOut },
  (p) => {
    const uv = p.in.uv

    // Velocity at THIS texel, in normalized [-1,1] components (flow-field-pack). A nodata cell
    // packs to (0,0), so an invalid region simply does not move — it never smears outward, and
    // a coastal texel decelerates toward the boundary, which is the physically sensible
    // direction rather than an artifact to correct.
    const vu = Let(textureSample(uTex.node, samp.node, uv).x)
    const vv = Let(textureSample(vTex.node, samp.node, uv).x)

    // Step BACKWARD along the field: where did the stuff at this texel come from? This is the
    // semi-Lagrangian step, and it is also the answer to "interpolate to the current at the
    // position it moved to" — the fetch below IS that interpolation, by construction.
    // THE SIGNS, derived rather than asserted — this environment has no GPU, so this comment
    // is the only human-readable justification, and "correcting" it the wrong way would invert
    // the whole field into silently wrong navigational information. (flow-advect.test.ts pins
    // both signs in the emitted WGSL, so such a change fails CI.)
    //
    //   uv.x increases EASTWARD  — origin is the SW cell centre, lon = originLon + col·dLon.
    //   uv.y increases SOUTHWARD — row 0 is the NORTHERNMOST row (coverage-arrow-show.ts:83,
    //     lat = originLat + (nLat−1−row)·dLat), packFlowFieldUV preserves row order, and both
    //     arms map uv.y=0 to texture row 0 (the GL twin's dropped V-flip exists precisely to
    //     make them agree with WebGPU's v=0-at-top).
    //
    // So displacement in uv is (+u·k, −v·k), and the BACKWARD step src = uv − displacement is
    //   x: uv.x − u·k   (subtract)
    //   y: uv.y + v·k   (ADD — the sign flips because north is −y)
    const back = Let(vec2(uv.x.sub(vu.mul(U.field.step.x)), uv.y.add(vv.mul(U.field.step.y))))
    // Clamp rather than wrap: a coverage cell is a bounded region, and wrapping would advect
    // the Atlantic into the Pacific across the seam.
    const src = Let(vec2(saturate(back.x), saturate(back.y)))

    const history = Let(textureSample(prevTex.node, samp.node, src).x.mul(U.field.step.z))
    const n = hash({ p: uv.mul(f32(NOISE_CELLS)), phase: U.field.phase.x })

    // Constant-weight blend of history and fresh noise. No lifetime, no fade, no respawn —
    // every texel is treated identically on every frame, which is why nothing can blink.
    const inject = U.field.step.w
    const out = Let(history.mul(f32(1).sub(inject)).add(n.mul(inject)))
    return vec4(out, out, out, 1)
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

// GL twin of the fullscreen VS with the V axis NON-flipped: a GL FBO stores clip y=-1 at
// texture row 0, the inverse of WebGPU's v=0-at-top, and the advect pass both READS and WRITES
// the same ping-pong pair, so the orientation must match the FBO's. Same fn name so the
// Material's vsEntry is backend-identical (mirrors heatmap-compose's vsFullGl).
const vsFullGl = fn(
  'vs_flow_advect',
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

const FLOW_ADVECT_MODULE: ModuleDecl = module({
  structs: [U.struct, VsOut.decl],
  bindings: [prevTex.binding, uTex.binding, vTex.binding, samp.binding, U.binding],
  funcs: [hash, vsFull, fsAdvect],
})

/** IBFV advection step: back-step along the field, decay the history, blend fresh noise. */
export const emitFlowAdvectWgsl = (): string => emitModule(FLOW_ADVECT_MODULE)

/** GLSL ES 3.00 twin (#1046: dual-source DSL, never a backend fork). The vertex stage swaps in
 *  the non-flipped `vsFullGl`; the fragment stage is the same module. */
export const emitFlowAdvectGlsl = (stage: 'vertex' | 'fragment'): string => {
  const funcs =
    stage === 'vertex'
      ? [vsFullGl]
      : FLOW_ADVECT_MODULE.funcs.filter(
          (f) => stageOf(f) === undefined || f.name === 'fs_flow_advect',
        )
  return emitGlslModule({ ...FLOW_ADVECT_MODULE, funcs }, stage)
}

/** Both GLSL stages from ONE lowering (see emitGlslStages). The per-stage twin above prunes
 *  the module before each emit, so it lowers + runs the optimizer fixpoint twice; the module
 *  carries one entry per stage, and the emitter's per-stage scope drops the `hash` helper from
 *  the vertex emit exactly as the prune did. `vsFullGl` replaces the WGSL `vsFull` (same fn
 *  name, no V-flip). Byte-identical to two calls of the per-stage form — pinned by
 *  map/src/render/material/glsl-stage-entry-parity.test.ts. */
export const emitFlowAdvectGlslStages = (): { vertex: string; fragment: string } =>
  emitGlslStages({ ...FLOW_ADVECT_MODULE, funcs: [hash, vsFullGl, fsAdvect] })

/** Noise granularity, exported so the CPU side can document/tune it alongside the step. */
export const FLOW_NOISE_CELLS = NOISE_CELLS

/** The u32 the fullscreen triangle draws. */
export const FLOW_ADVECT_VERTEX_COUNT = u32(3)
