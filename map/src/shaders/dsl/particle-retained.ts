// ═══ Shader DSL — retained geo-anchored PARTICLE-FLOW shader (the wind-map aesthetic) ═══
//
// The GPU half of the host DRAWING API's retained PARTICLE-FLOW batch (#826) — an ANIMATED reading
// of the SAME per-gu outflow field the static arrow draws (design §1.3). Candidate (b): a STATELESS
// vertex-shader integration (design §3.2). Each instance is one particle whose position at time `t`
// is a CLOSED-FORM function of a static per-instance seed — there is NO state buffer, no ping-pong,
// no compute pass; the whole effect is `f(seed, t)`, which is why a pinned `t` yields a
// byte-reproducible frame (the §5 deterministic-probe seam) and why the twin comes for free.
//
// It reuses the proven retained spine wholesale:
//   • the SAME geo→clip ladder (`project_geo`) + `pointU` frame uniform + per-copy world_offset as
//     icon/arrow/circle — a camera move rewrites only the ~160 B frame uniform;
//   • the arrow's #825 TWO-POINT trick — project the origin AND a direction tip, derive the
//     screen-space drift direction (cc, ss) from their clip-space delta, so the drift is GEOGRAPHIC
//     under any camera / pitch / globe (not a baked screen angle);
//   • the circle's 6-vertex bounding square + analytic disc SDF (fwidth AA) for the particle dot.
//
// The ONLY genuinely new input is the scalar animation clock `t` (seconds). It rides the FREE
// `circle_params.y` lane of the per-copy frame uniform (design §3.0 / §5-Q2 — a frame-uniform field
// written O(1)/frame at the per-copy write site, with ZERO bloat to the shared 160 B pointU that
// icon/arrow/circle/point read; `.y` is written-as-0 and read by no sibling, so those paths stay
// byte-identical). The graphics manager writes it nonzero ONLY when a particle batch exists.
//
// Closed-form drift (design §3.2), evaluated per vertex:
//   phase = fract(t / lifetime + phase_norm)            // 0→1 saw, loops; phase_norm de-syncs
//   drift = phase · drift_px  along the projected (cc, ss) direction
//   alpha = fadeIn(phase) · fadeOut(phase)              // fades hide the fract respawn jump
// Within a gu the field is piecewise-CONSTANT, so constant-velocity drift is EXACT here, not an
// approximation (design §3.2, §6.1 — cross-cell advection is candidate (a)'s deferred territory).

import {
  fn,
  module,
  transformMat4,
  f32,
  u32,
  max,
  length,
  fwidth,
  fract,
  smoothstep,
  vec2,
  vec3,
  vec4,
  when,
  Switch,
  Discard,
  If,
  Let,
  f32T,
  u32T,
  vec2fT,
  vec3fT,
  vec4fT,
  type ModuleDecl,
} from '@xgis/shader-dsl'
import { ioStruct, builtin, location, storageBuffer } from '@xgis/shader-dsl'
import { emitModule, emitGlslModule, stageOf } from '@xgis/shader-dsl'
import {
  flat_rel,
  needs_backface_cull,
  PROJECTION_CONSTS,
  getGpuProjectionFuncs,
} from './projections'
import { pointU } from './point'
import { PARTICLE_RETAINED_FEAT } from './particle-retained-feat-layout'

const STRIDE = u32(PARTICLE_RETAINED_FEAT.stride)
const F = PARTICLE_RETAINED_FEAT.slot

// Fade band, in phase units: the particle fades in over the first FADE of its life and out over
// the last FADE, so it is invisible at phase 0 / 1 — hiding the instantaneous `fract` respawn.
const FADE = 0.2

const featB = storageBuffer('feat_data', f32T, { group: 1, binding: 0, access: 'read' })
const tintB = storageBuffer('tint_data', vec4fT, { group: 1, binding: 1, access: 'read' })
const featData = featB.node

// geo → clip, reused VERBATIM from icon-retained/arrow-retained/circle-retained/point vs_point.
// Called TWICE (origin + direction tip) so the drift direction is a projected screen direction,
// correct under any camera (the arrow's #825 two-point trick).
const project_geo = fn(
  'project_geo',
  {
    ecefH: vec3fT,
    ecefL: vec3fT,
    absLon: f32T,
    absLat: f32T,
    mxH: f32T,
    mxL: f32T,
    myH: f32T,
    myL: f32T,
  },
  (a) => {
    const camH = pointU.field.cam_ecef_h.swizzle('xyz')
    const camL = pointU.field.cam_ecef_l.swizzle('xyz')
    const ecefRtc = a.ecefH.sub(camH).add(a.ecefL.sub(camL))
    const mvp = pointU.field.mvp
    const worldOffset = pointU.field.circle_params.x
    return when(
      [
        [
          pointU.field.proj_params.x.lt(0.5),
          () => {
            const camMercH = pointU.field.cam_ecef_h.swizzle('xy')
            const camMercL = pointU.field.cam_ecef_l.swizzle('xy')
            const relX = a.mxH.sub(camMercH.x).add(a.mxL.sub(camMercL.x)).add(worldOffset)
            const relY = a.myH.sub(camMercH.y).add(a.myL.sub(camMercL.y))
            return transformMat4(mvp, vec4(relX, relY, 0, 1))
          },
        ],
        [
          pointU.field.proj_params.x.lt(6.5),
          () => {
            const relG = flat_rel(a.absLon, a.absLat, pointU.field.proj_params, a.absLon)
            return transformMat4(mvp, vec4(relG.x, relG.y, 0, 1))
          },
        ],
      ],
      () => transformMat4(mvp, vec4(ecefRtc, 1)),
    )
  },
)

const ParticleOut = ioStruct('ParticleRetainedOut', {
  position: builtin('position', vec4fT),
  loc: location(0, vec2fT),
  tint: location(1, vec4fT, 'flat'),
  alpha: location(2, f32T, 'flat'),
  cos_c: location(3, f32T, 'flat'),
})

const vs = fn(
  'vs_particle_retained',
  {
    inst: builtin('instance_index', u32T),
    vi: builtin('vertex_index', u32T),
  },
  (p) => {
    const rd = (slot: number) => featData.at(p.inst.mul(STRIDE).add(slot), f32T)

    const absLon = rd(F.abs_lon)
    const absLat = rd(F.abs_lat)
    const originClip = project_geo({
      ecefH: vec3(rd(F.ecef_x_h), rd(F.ecef_y_h), rd(F.ecef_z_h)),
      ecefL: vec3(rd(F.ecef_x_l), rd(F.ecef_y_l), rd(F.ecef_z_l)),
      absLon,
      absLat,
      mxH: rd(F.merc_x_h),
      mxL: rd(F.merc_x_l),
      myH: rd(F.merc_y_h),
      myL: rd(F.merc_y_l),
    })
    const tipClip = project_geo({
      ecefH: vec3(rd(F.tip_ecef_x_h), rd(F.tip_ecef_y_h), rd(F.tip_ecef_z_h)),
      ecefL: vec3(rd(F.tip_ecef_x_l), rd(F.tip_ecef_y_l), rd(F.tip_ecef_z_l)),
      absLon: rd(F.tip_abs_lon),
      absLat: rd(F.tip_abs_lat),
      mxH: rd(F.tip_merc_x_h),
      mxL: rd(F.tip_merc_x_l),
      myH: rd(F.tip_merc_y_h),
      myL: rd(F.tip_merc_y_l),
    })

    // Screen-space DRIFT direction from the clip-space delta (origin → tip). NDC is per-axis
    // normalized, so scale each axis by the viewport extent to recover true SCREEN-px direction
    // before normalizing (the ×2 NDC→px factor cancels). +y flips (screen down → NDC up). Same
    // derivation as the arrow's orientation.
    const vp = pointU.field.viewport
    const ndcOrigin = originClip.swizzle('xy').div(originClip.w)
    const ndcTip = tipClip.swizzle('xy').div(tipClip.w)
    const dsx = ndcTip.x.sub(ndcOrigin.x).mul(vp.x)
    const dsy = ndcTip.y.sub(ndcOrigin.y).neg().mul(vp.y)
    const dlen = max(length(vec2(dsx, dsy)), f32(1e-6))
    const cc = dsx.div(dlen)
    const ss = dsy.div(dlen)

    // ── Closed-form phase (design §3.2). `t` = the animation clock in the FREE circle_params.y
    // lane (design §3.0). phase_norm de-syncs particles so the field breathes, not marches. ──
    const t = pointU.field.circle_params.y
    const lifetime = max(rd(F.lifetime_s), f32(1e-3))
    const phase = fract(t.div(lifetime).add(rd(F.phase_norm)))
    const driftPx = phase.mul(rd(F.drift_px))

    // Drift the origin `driftPx` screen-px along (cc, ss); screen-px → NDC (× clip.w), +y flips.
    const driftNdc = vec2(
      driftPx.mul(cc).mul(f32(2).div(vp.x)),
      driftPx.mul(ss).neg().mul(f32(2).div(vp.y)),
    )
    const driftedClip = originClip.add(vec4(driftNdc.mul(originClip.w), 0, 0))

    // ── Bounding square (6 verts): qx, qy ∈ {-1, +1} corners, sized to the disc radius. ──
    const qx = f32(0)
    const qy = f32(0)
    Switch(p.vi)
      .case(0, () => {
        qx.assign(f32(-1))
        qy.assign(f32(-1))
      })
      .case(1, () => {
        qx.assign(f32(-1))
        qy.assign(f32(1))
      })
      .case(2, () => {
        qx.assign(f32(1))
        qy.assign(f32(1))
      })
      .case(3, () => {
        qx.assign(f32(-1))
        qy.assign(f32(-1))
      })
      .case(4, () => {
        qx.assign(f32(1))
        qy.assign(f32(1))
      })
      .case(5, () => {
        qx.assign(f32(1))
        qy.assign(f32(-1))
      })
      .default(() => {
        /* vi ∈ 0..5 */
      })

    // Half-extent in px: radius + 2 px AA headroom (the disc SDF's fill edge sits at |loc| = 1).
    const radius = rd(F.radius_px)
    const half = radius.add(f32(2))
    const offXpx = qx.mul(half)
    const offYpx = qy.mul(half)
    // px → NDC around the DRIFTED centre, perspective-correct (× clip.w). Screen +y down → NDC −y.
    const offNdc = vec2(offXpx.mul(f32(2).div(vp.x)), offYpx.neg().mul(f32(2).div(vp.y)))
    const clip = driftedClip.add(vec4(offNdc.mul(driftedClip.w), 0, 0))

    // Fade in at birth, out at death — invisible at phase 0/1, hiding the instantaneous respawn.
    const fadeIn = smoothstep(f32(0), f32(FADE), phase)
    const fadeOut = f32(1).sub(smoothstep(f32(1).sub(f32(FADE)), f32(1), phase))

    const o = ParticleOut.var()
    o.position.assign(clip)
    // uv normalised so |uv| = 1 at the radius edge — the point-renderer disc convention.
    o.loc.assign(vec2(offXpx, offYpx).div(max(radius, f32(1))))
    o.tint.assign(tintB.node.at(p.inst, vec4fT))
    o.alpha.assign(fadeIn.mul(fadeOut))
    o.cos_c.assign(
      needs_backface_cull(absLon, absLat, pointU.field.proj_params, pointU.field.globe_eye),
    )
    return o.$
  },
  { stage: 'vertex' },
)

const fs = fn(
  'fs_particle_retained',
  { in: ParticleOut },
  (p) => {
    const pin = p.in
    If(pin.cos_c.lt(0), () => {
      Discard()
    })
    // fwidth is a derivative — MUST be a Let in uniform control flow (mirrors fs_circle_retained).
    const aa = Let(fwidth(length(pin.loc)).mul(1.5))
    const dist = length(pin.loc)
    // Disc coverage — 1 inside the radius, smooth AA band at the edge (|loc| = 1). Multiply by the
    // per-particle life-fade so a particle is invisible at birth/death (hiding the respawn jump).
    const fillAlpha = Let(f32(1).sub(smoothstep(f32(1).sub(aa), f32(1).add(aa), dist)))
    const out = vec4(pin.tint.swizzle('xyz'), pin.tint.w.mul(fillAlpha).mul(pin.alpha))
    If(out.w.lt(f32(0.004)), () => {
      Discard()
    })
    return out
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

export const buildParticleRetainedModule = (): ModuleDecl =>
  module({
    consts: [...PROJECTION_CONSTS],
    structs: [pointU.struct, ParticleOut.decl],
    bindings: [pointU.binding, featB.binding, tintB.binding],
    funcs: [...getGpuProjectionFuncs(), project_geo, vs, fs],
  })

/** Full retained-particle-flow shader: shared projection consts + injected projection fns + the
 *  two-point geo-directional stateless-drift disc VS + analytic disc-SDF (fwidth AA) FS. */
export const emitParticleRetainedWgsl = (): string => emitModule(buildParticleRetainedModule())

/** GLSL ES 3.00 twin for the WebGL2 backend (#823) — same module, split per stage. `emulateStorage`
 *  lowers the feat (array<f32>) + tint (array<vec4f>) storage buffers to R32F data textures,
 *  matching WebGl2Device's storage-buffer emulation. Consumed by RetainedParticleDraper behind a
 *  live WebGL2 backend guard — the WebGPU boot never pays for this emit (#778 P6). The twin is
 *  FREE by construction: candidate (b) is a pure dual-source DSL pipeline (design §3.2). */
export const emitParticleRetainedGlsl = (stage: 'vertex' | 'fragment'): string => {
  const m = buildParticleRetainedModule()
  const keep = stage === 'vertex' ? 'vs_particle_retained' : 'fs_particle_retained'
  return emitGlslModule(
    { ...m, funcs: m.funcs.filter((f) => stageOf(f) === undefined || f.name === keep) },
    stage,
    { emulateStorage: true },
  )
}
