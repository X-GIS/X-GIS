// ═══ Globe atmosphere — limb-glow gradient (#1258) ═══
//
// Phase 1 of #1258: a screen-space radial gradient banded around the globe's projected
// silhouette (inner: horizon tint; outer: falloff to space black), drawn as its own
// fullscreen-triangle pass immediately after the background clear (background-pass.ts's
// own header already named this "a separate, deferred pass" — this module is that pass's
// shader half). NO scattering simulation, NO sun/time-of-day — a gradient, not a model.
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
  vec2,
  vec4,
  Let,
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
    const a = Let(mix(atm.outer_color.w, atm.inner_color.w, glow).mul(glow))
    return vec4(rgb, a)
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
