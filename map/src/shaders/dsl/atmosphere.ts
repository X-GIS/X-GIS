// ═══ Globe atmosphere — limb-glow gradient (#1258) + MapLibre `sky` root (#2052) ═══
//
// Phase 1 of #1258: a screen-space radial gradient banded around the globe's projected
// silhouette (inner: horizon tint; outer: falloff to space black), drawn as its own
// fullscreen-triangle pass immediately after the background clear (background-pass.ts's
// own header already named this "a separate, deferred pass" — this module is that pass's
// shader half). NO scattering simulation, NO sun/time-of-day — a gradient, not a model.
//
// #2052 T5 Phase 1 adds the MapLibre `sky` ROOT's zenith-angle ramp to the SAME fragment
// — the design doc's load-bearing observation is that the sky root, the Mapbox sky LAYER
// and 6/7 of the Mapbox `fog` root are one `f(ray)` evaluator with three converter
// front-ends, so this is a shader-body change inside an existing pass, not a new pass.
// See "WHERE THE HORIZON IS" below for the one piece of geometry that is NOT free.
//
// ── WHY A RAY-SPHERE TEST, NOT A 2D SCREEN CIRCLE ──
//
// The globe's on-screen silhouette is an ellipse-ish shape that depends on pitch and
// bearing; approximating it as a 2D circle centred on the projected globe centre drifts
// off the true limb under tilt. The exact answer is geometric instead: for the camera ray
// through each pixel, how close does it pass to the planet SPHERE (not to a screen point)?
// That is ray-sphere closest-approach, and `ray_from_corners` (unproject-dsl.ts, #1520) is
// already the precision-safe way to get a per-pixel world-space ray from four CPU-unprojected
// corners — reused verbatim rather than re-derived. The closest-approach distance itself needs
// no cancellation-prone algebra (everything here is `dot`/`distance` of camera-relative
// vectors, all small — see unproject-dsl.ts's header for why that class of arithmetic is safe).
//
// ── THE RADIUS IS A CONSTANT, DELIBERATELY ──
//
// `unproject-dsl.ts`'s backward map needs the local OSCULATING sphere (a sub-pixel-accurate
// radius that varies with latitude) because a data lattice node is placed by it. This is a
// decorative glow; the equatorial radius is sub-0.2% off the true local radius everywhere,
// which is invisible in a soft gradient. Using the plain constant keeps this module free of
// the whole `projections.ts` const-table dependency for one number nothing here needs exactly.
//
// ── WHERE THE HORIZON IS, AND WHY IT IS NOT `dot(ray, up)` (#2052) ──
//
// The design doc parameterises the sky root as a gradient in ZENITH ANGLE — `sky-color`
// overhead, `horizon-color` at the horizon. On the globe arm the horizon is the sphere
// LIMB, and the limb is NOT at `dot(ray, up) == 0`: for an eye at altitude h the tangent
// rays make an angle α with the eye→centre direction where sin α = R/(R+h), so the limb
// sits at `dot(ray, up) == −cos α` — which is 0 only for an eye ON the surface and runs to
// −1 as the eye recedes. A ramp anchored on the up-plane therefore paints the horizon
// colour in open space at every globe altitude the camera actually uses.
//
// So the ramp is parameterised against the limb itself, in the one variable that already
// exists here: `cos γ = dot(ray, normalize(centre − eye))`, +1 at the nadir and −1 at the
// zenith, against `cos α = sqrt(1 − (R/d)²)`. `cos γ < cos α` is EXACTLY the existing
// `t > 0 && tca > 0` miss test (substitute distClosest² = d² − tca²), so no second
// silhouette test is introduced — the sky and the glow agree about where the limb is by
// construction, not by two tunings that must be kept in sync.
//
// ── NO GL-SPECIFIC VERTEX TWIN ──
//
// `scene-upscale.ts`'s vertex twin exists because it SAMPLES a previously-rendered texture,
// and GL/WebGPU disagree on which texture row is v=0. This shader samples nothing — the
// varying is the triangle's own clip position, and clip-space vertex output is one convention
// on both backends. One vertex function serves both emits.

import {
  fn,
  f32,
  normalize,
  dot,
  distance,
  clamp,
  pow,
  select,
  mix,
  max,
  sqrt,
  length,
  smoothstep,
  vec2,
  vec4,
  Let,
  Var,
  If,
  module,
  emitModule,
  emitGlslStages,
  ioStruct,
  builtin,
  location,
  uniformStruct,
  type ModuleDecl,
  vec2fT,
  vec4fT,
  u32T,
} from '@xgis/shader-dsl'
import { ray_from_corners } from './unproject-dsl'

/** Equatorial earth radius, metres — a plain constant (see header for why this module does
 *  not pull in `projections.ts`'s EARTH_R const-table entry for it). */
const ATMOSPHERE_EARTH_R_M = 6378137
/** Outer glow radius as a multiple of the planet radius — how far the rim extends past the
 *  limb. 1.025 reads as a THIN rim (the issue's own wording), not a haze. */
const ATMOSPHERE_OUTER_SCALE = 1.025
/** Falloff shape from the limb (t=0) to the outer radius (t=1). Higher = a tighter band
 *  hugging the silhouette; 2.0 is a soft, unremarkable gradient — not a tuned physical curve. */
const ATMOSPHERE_GLOW_EXPONENT = 2.0
/** Floor under the authored `sky-horizon-blend` (#2052). `smoothstep(0, e1, x)` is undefined
 *  at e1 == 0, and MapLibre's spec range is `[0, 1]` inclusive, so the "sharp horizon" end of
 *  that range has to land on a width rather than on a division by zero. 1/256 of the
 *  limb→zenith arc is well under a pixel at any viewport this renders at, so the clamp is
 *  invisible where it bites and the ramp stays total over the whole authored domain. */
const SKY_HORIZON_BLEND_MIN = 1 / 256

const VsAtmosphereOut = ioStruct('VsAtmosphereOut', {
  pos: builtin('position', vec4fT),
  /** The triangle's own clip-space xy, reused as NDC (w = 1 for all three verts, so the
   *  rasteriser's linear interpolation is exact across the covered viewport — the same
   *  fullscreen-triangle property `scene-upscale.ts`'s uv relies on). */
  ndc: location(0, vec2fT),
})

/** group 0 binding 0 — the per-frame camera + colour uniform (atmosphere-uniform.ts packs
 *  it CPU-side). Four camera-ray corners + their shared eye + the local zenith, exactly the
 *  camera description `ray_from_corners` needs (#1520's "why the camera arrives as four
 *  corner rays" — field-lattice.ts's fieldViewU header — applies here verbatim); plus the
 *  two style colours. */
const atmosphereU = uniformStruct(
  'AtmosphereView',
  { group: 0, binding: 0, as: 'atm' },
  {
    /** xyz = world-space ray direction at NDC (−1, −1); w unused. */
    ray_bl: vec4fT,
    /** …at NDC (+1, −1). */
    ray_br: vec4fT,
    /** …at NDC (−1, +1). */
    ray_tl: vec4fT,
    /** …at NDC (+1, +1). */
    ray_tr: vec4fT,
    /** xyz = the ray ORIGIN in the MVP's own world space (not assumed to be the world
     *  origin — see `ray_from_corners`'s own doc). */
    eye: vec4fT,
    /** xyz = world-space zenith at the world origin (the ECEF radial at the camera's RTC
     *  focus — globe mode's `localFrame(...).up`). */
    up: vec4fT,
    /** Straight-alpha RGBA at the limb edge (t=0) — the horizon tint. */
    inner_color: vec4fT,
    /** Straight-alpha RGBA at the glow's outer radius (t=1) — typically alpha 0, so the
     *  already-black space background shows through unchanged past the rim. */
    outer_color: vec4fT,
    /** #2052 — MapLibre `sky-color`: straight-alpha RGBA at the ZENITH end of the sky ramp. */
    sky_color: vec4fT,
    /** #2052 — MapLibre `horizon-color`: straight-alpha RGBA at the LIMB end of the ramp. */
    horizon_color: vec4fT,
    /** #2052 — x = `sky-horizon-blend` (0..1, the ramp width as a fraction of the limb→zenith
     *  arc); y = the sky ENABLE flag (0 = the style authored no `sky` root). y is a hard flag
     *  rather than "both colours at alpha 0" because it gates a BRANCH: with the sky off the
     *  fragment must take the pre-#2052 path expression-for-expression, so a style with no sky
     *  stays bit-identical instead of merely arithmetically-equal. z, w unused. */
    sky_params: vec4fT,
  },
)
const atm = atmosphereU.field

export const vsAtmosphere = fn(
  'vs_atmosphere',
  { vi: builtin('vertex_index', u32T) },
  (p) => {
    const pos = vec2(-1, -1)
    If(p.vi.eq(1), () => pos.assign(vec2(3, -1)))
    If(p.vi.eq(2), () => pos.assign(vec2(-1, 3)))
    return VsAtmosphereOut.construct({ pos: vec4(pos, 0, 1), ndc: pos })
  },
  { stage: 'vertex' },
)

export const fsAtmosphere = fn(
  'fs_atmosphere',
  { input: VsAtmosphereOut },
  (p) => {
    const d = Let(
      ray_from_corners({
        ndc: p.input.ndc,
        bl: atm.ray_bl,
        br: atm.ray_br,
        tl: atm.ray_tl,
        tr: atm.ray_tr,
      }),
    )
    const dn = Let(normalize(d))
    const eye = Let(atm.eye.swizzle('xyz'))
    const up = Let(atm.up.swizzle('xyz'))
    // The sphere centre: the world origin sits ON the surface (ray_from_corners's own
    // world-space contract), so the centre is R below it along the zenith.
    const center = Let(up.mul(f32(-ATMOSPHERE_EARTH_R_M)))
    // Closest approach of the ray line to the centre — the standard point-to-line
    // projection, in camera-relative metres throughout (no earth-radius-scale term).
    const tca = Let(dot(center.sub(eye), dn))
    const closest = Let(eye.add(dn.mul(tca)))
    const distClosest = Let(distance(closest, center))
    const band = f32(ATMOSPHERE_EARTH_R_M * (ATMOSPHERE_OUTER_SCALE - 1))
    const t = Let(distClosest.sub(f32(ATMOSPHERE_EARTH_R_M)).div(band))
    const tt = Let(clamp(t, f32(0), f32(1)))
    const falloff = Let(pow(f32(1).sub(tt), f32(ATMOSPHERE_GLOW_EXPONENT)))
    // Zero inside the disc (t <= 0, painted over by the globe itself) and behind the
    // camera (tca <= 0) — the falloff curve alone already reaches zero past the outer
    // radius, so nothing extra is needed for that side.
    const visible = Let(t.gt(f32(0)).and(tca.gt(f32(0))))
    const glow = Let(select(visible, falloff, f32(0)))
    const rgb = Let(mix(atm.outer_color.swizzle('xyz'), atm.inner_color.swizzle('xyz'), glow))
    // NOT `.mul(glow)` again. `mix` alone already lands exactly ON `outer_color.w` at glow=0 —
    // the correct end of the ramp (0 for the default "fade to space", or a caller's chosen
    // persistent tint if they set a nonzero outer alpha) — so the extra multiply protected
    // nothing that was not already true. What it DID do is square an already-squared curve
    // (ATMOSPHERE_GLOW_EXPONENT=2 applied to `falloff`, so alpha collapsed to ∝(1-t)^4 instead
    // of the intended ∝(1-t)^2), which is the #1258 gate regression: measured on the real
    // render (SwiftShader/WebGL2, the gate's exact camera), the four pixels past the silhouette
    // read alpha 0.58/0.25/0.09/0.02 with this line as a bare `mix`, vs. 0.48/0.20/0.06/0.01
    // (rounding to 0 under 8-bit display a pixel sooner) with the extra `.mul(glow)` in place —
    // half the exponent's worth of visible screen width, on a band that was already only a
    // few pixels wide to begin with.
    const a = Let(mix(atm.outer_color.w, atm.inner_color.w, glow))

    // ── MapLibre `sky` root — the zenith-angle ramp (#2052 T5 Phase 1) ──
    //
    // Everything below reads the SAME ray/sphere quantities the glow just used; see the
    // header for why the ramp is anchored on the limb angle rather than on `dot(ray, up)`.
    const dSafe = Let(max(length(center.sub(eye)), f32(1)))
    // cos of the angle between the ray and the eye→centre direction. `tca` is already that
    // dot against the UN-normalised eye→centre vector, so this is one divide, not a second dot.
    const cosRay = Let(tca.div(dSafe))
    // cos of the limb half-angle. Written as `1 − (R/d)²` rather than `1 − R²/d²` to keep
    // every term O(1): R² is 4.07e13 and would spend most of an f32's mantissa before the
    // subtraction. `max(…, 0)` covers an eye at or inside the surface (d ≤ R), where there is
    // no limb — the ramp then degenerates to the hemisphere test, bounded rather than NaN.
    const rOverD = Let(f32(ATMOSPHERE_EARTH_R_M).div(dSafe))
    const cosLimb = Let(sqrt(max(f32(1).sub(rOverD.mul(rOverD)), f32(0))))
    // 0 exactly AT the limb, 1 exactly at the zenith (cosRay = −1); negative on the rays that
    // hit the planet. The denominator is cosLimb + 1 ∈ [1, 2] and so needs no guard.
    const skyT = Let(cosLimb.sub(cosRay).div(cosLimb.add(f32(1))))
    const skyBlend = Let(max(atm.sky_params.x, f32(SKY_HORIZON_BLEND_MIN)))
    const skyMix = Let(smoothstep(f32(0), skyBlend, skyT))
    const skyRgb = Let(mix(atm.horizon_color.swizzle('xyz'), atm.sky_color.swizzle('xyz'), skyMix))
    // Zero on the planet's own disc: the sky must REPLACE the space background above the
    // horizon, never paint over the earth surface the later passes draw.
    const skyA = Let(
      select(skyT.gt(f32(0)), mix(atm.horizon_color.w, atm.sky_color.w, skyMix), f32(0)),
    )

    const out = Var(vec4(rgb, a))
    // Glow OVER sky, straight alpha (the pass's colour target blends `src·a + dst·(1−a)`).
    // Deliberately a BRANCH, not an algebraic `select`: at skyA = 0 the composite reduces to
    // (rgb·a)/a, which is the identity in ℝ and a rounding in f32 — a style that authors no
    // `sky` has to be bit-identical to pre-#2052, not merely close, because that byte-identity
    // is the invariant the whole phase is gated on. The condition is uniform across the draw,
    // so both backends take it coherently.
    If(atm.sky_params.y.gt(f32(0.5)), () => {
      const oa = Let(a.add(skyA.mul(f32(1).sub(a))))
      const orgb = Let(
        rgb
          .mul(a)
          .add(skyRgb.mul(skyA.mul(f32(1).sub(a))))
          .div(max(oa, f32(1e-6))),
      )
      out.assign(vec4(orgb, oa))
    })
    return out
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

export const atmosphereModule: ModuleDecl = module({
  structs: [VsAtmosphereOut.decl, atmosphereU.decl],
  bindings: [atmosphereU.binding],
  funcs: [ray_from_corners, vsAtmosphere, fsAtmosphere],
})

/** WGSL authority. */
export const emitAtmosphereWgsl = (): string => emitModule(atmosphereModule)

/** Both GLSL ES 3.00 stages from ONE lowering (see `emitHeatmapAccumGlslStages` for the
 *  same shape) — this module carries exactly one vs/fs entry each, so nothing needs pruning
 *  or naming. */
export const emitAtmosphereGlslStages = (): { vertex: string; fragment: string } =>
  emitGlslStages(atmosphereModule)

export { atmosphereU }
