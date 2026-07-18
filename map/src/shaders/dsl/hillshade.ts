// ═══ Shader DSL — hillshade (raster-dem shaded relief) shader (#777 Phase II) ═══
//
// A hillshade tile is structurally a raster tile with a different fragment: the
// vertex stage, the procedural N×N grid, the per-projection dispatch, the pole
// caps and the VsOut varyings are SHARED VERBATIM with raster.ts (rasterVsTile /
// rasterVsOut / rasterU / rasterTileU / rasterTex / rasterTexSampler) so a
// projection fix lands once (design §1). Only the fragment is new: it decodes
// the RGBA8-packed DEM elevation, takes a 3×3 Sobel derivative, applies the
// Mercator latitude correction, and shades via the Mapbox `standard` (legacy) or
// `basic` (GDAL-Lambert) illumination model.
//
// DEM decode (design §2): DEM tiles arrive as PNG (RGBA8) with RGB-packed
// elevation; the RHI has no r16/float sample format, so the height is decoded in
// the fragment (mirrors MapLibre). The DEM MUST be sampled NEAREST (bilinear over
// packed RGB corrupts the decode) — the renderer (INC-3) binds a nearest sampler.
//
// Uniform authority: the shared vertex uniforms (mvp / proj_params /
// cam_ecef_center / globe_eye for the hemisphere cull) come from the raster
// `Uniforms` + `TileUniforms` structs; the raster-colour lanes of `Uniforms` are
// dead here (the renderer writes them 0). The hillshade-specific lighting +
// decode params live in a dedicated `HillshadeUniforms` (group 0, binding 3);
// the per-tile zoom-dependent derivative scale in `HillshadeTileUniforms`
// (group 1, binding 1).
//
// Residuals (design §3): `resampling: linear` decoded-height smoothing and the
// cross-tile 1px edge backfill are the documented two-pass upgrade path; the MVP
// fragment renders the nearest 3×3 field (byte-parity with MapLibre `nearest`).

import {
  fn,
  module,
  vec2,
  vec2u,
  f32,
  atan,
  atan2,
  exp,
  cos,
  sin,
  mod,
  abs,
  pow,
  sqrt,
  clamp,
  dot,
  length,
  mix,
  degrees,
  textureSample,
  f32T,
  vec2fT,
  vec4fT,
  vec2uT,
  If,
  when,
  Discard,
  type ModuleDecl,
} from '@xgis/shader-dsl'
import { ioStruct, builtin, location, uniformStruct } from '@xgis/shader-dsl'
import { emitModule } from '@xgis/shader-dsl'
import {
  rasterVsTile,
  rasterVsOut,
  rasterU,
  rasterTileU,
  rasterTex,
  rasterTexSampler,
} from './raster'
import { needs_backface_cull, PROJECTION_CONSTS, getGpuProjectionFuncs } from './projections'
import { ECEF_CONSTS } from './ecef'
import { compute_log_frag_depth } from './log-depth'
import { PI } from './consts'

// ── Hillshade lighting + DEM-decode uniforms (group 0, binding 3) ──
//
// The renderer resolves the anchor / bearing geometry (design §4) so the shader
// consumes a single FINAL azimuth: hs_light.x already includes the +π orientation
// and, for anchor=viewport, the camera bearing. Colours are PREMULTIPLIED by the
// renderer (the output is premultiplied-alpha, drawn with a premultiplied blend),
// mirroring MapLibre's hillshade_program colour upload.
const HS = uniformStruct(
  'HillshadeUniforms',
  { group: 0, binding: 3, as: 'hs' },
  {
    // elevation unpack: x=redFactor, y=greenFactor, z=blueFactor, w=baseShift.
    // elevation_m = dot(rgb*255, unpack.rgb) - unpack.w
    hs_unpack: vec4fT,
    // x=azimuth_rad (final, incl. +π and viewport bearing), y=altitude_rad,
    // z=exaggeration, w=method flag (0 = standard, ≥0.5 = basic).
    hs_light: vec4fT,
    hs_shadow: vec4fT, // premultiplied shadow-side RGBA
    hs_highlight: vec4fT, // premultiplied lit-side RGBA
    hs_accent: vec4fT, // premultiplied accent RGBA
    // x = dem texel size (1/dimension); y = deriv_scale =
    // tileSize / pow(2, exaggeration_zoom + 28.2562 − zoom) (design §3 step 2),
    // computed per-frame from the render zoom (exact for the single-LOD steady
    // state; a documented approximation for transient parent-fallback / pitched
    // mixed-LOD tiles — the single-pass MVP does not carry a per-tile scale). zw reserved (0).
    hs_texel: vec4fT,
  },
)
// Exported (distinct barrel name) for the INC-3 CPU packer, which derives its
// typed write surface from reflect() over the SAME struct declaration. The
// vertex reuses the raster global 'Uniforms' + per-tile 'TileUniforms' (so
// vs_tile + writeRasterTileUniform are shared verbatim — no hillshade per-tile
// uniform, which keeps hillshade inside the single-global + single-pool Material seam).
export { HS as hillshadeU }

// VsOut / U / Tile / DEM texture are the raster authorities, shared verbatim.
const VsOut = rasterVsOut
const U = rasterU
const tex = rasterTex
const texSampler = rasterTexSampler

const hillshadeFragmentOutput = (pickEnabled: boolean) =>
  ioStruct('HillshadeFragmentOutput', {
    color: location(0, vec4fT),
    ...(pickEnabled ? { pick: location(1, vec2uT, 'flat') } : {}),
    depth: builtin('frag_depth', f32T),
  })

// DEM elevation decode (design §2). textureSample returns normalised [0,1] →
// ×255 before the unpack dot (mirror MapLibre's texture()*255). Reusable fn,
// called 8× (the 3×3 Sobel stencil, centre excluded). Sampled NEAREST — the
// renderer binds a nearest sampler so the packed RGB is never bilinear-blended.
const hsElevation = fn('hs_elevation', { uv: vec2fT }, ({ uv }) => {
  const t = textureSample(tex.node, texSampler.node, uv).rgb.mul(255)
  return dot(t, HS.field.hs_unpack.rgb).sub(HS.field.hs_unpack.w)
})

const buildFs = (pickEnabled: boolean) => {
  const HillshadeFragmentOutput = hillshadeFragmentOutput(pickEnabled)
  return fn(
    'fs_hillshade',
    { input: VsOut },
    (p) => {
      const pin = p.input

      // Per-fragment hemisphere cull — identical to raster fs_tile (#595): recover
      // latitude from the abs_merc_y varying and discard the back hemisphere. Flat
      // projections short-circuit to +1 inside needs_backface_cull (no per-pixel cost).
      const latRad = f32(2)
        .mul(atan(exp(pin.abs_merc_y)))
        .sub(PI.div(2))
      const latDeg = degrees(latRad)
      const cosC = needs_backface_cull(pin.abs_lon, latDeg, U.field.proj_params, U.field.globe_eye)
      If(cosC.lt(0), () => {
        Discard()
      })

      // ── 3×3 Sobel stencil (design §3 step 1–2) ──
      // Neighbour taps at uv ± dem_texel. a b c / d · f / g h i (row-major,
      // centre excluded). CLAMP_TO_EDGE at a tile edge yields a ≤1-DEM-texel flat
      // seam — exactly MapLibre's pre-backfill state (edge backfill is deferred).
      const texel = HS.field.hs_texel.x
      const e = (dx: number, dy: number) =>
        hsElevation({ uv: vec2(pin.uv.x.add(texel.mul(dx)), pin.uv.y.add(texel.mul(dy))) })
      const a = e(-1, -1)
      const b = e(0, -1)
      const c = e(1, -1)
      const d = e(-1, 0)
      const f = e(1, 0)
      const g = e(-1, 1)
      const h = e(0, 1)
      const i = e(1, 1)

      // Sobel derivative (MapLibre hillshade_prepare weights), scaled by the
      // per-tile deriv_scale, then Mercator latitude-corrected (design §3 step 3):
      // divide by cos(lat) — the vertical-exaggeration correction. lat is already
      // radians from the abs_merc_y recompute above.
      const derivX = c.add(f.mul(2)).add(i).sub(a).sub(d.mul(2)).sub(g)
      const derivY = g.add(h.mul(2)).add(i).sub(a).sub(b.mul(2)).sub(c)
      const scale = HS.field.hs_texel.y.div(cos(latRad))
      const deriv = vec2(derivX.mul(scale), derivY.mul(scale))

      const azimuth = HS.field.hs_light.x
      const altitude = HS.field.hs_light.y
      const intensity = HS.field.hs_light.z
      const method = HS.field.hs_light.w

      // Method dispatch (design §3 step 4). standard (0) = MapLibre legacy (uses
      // accent, ignores altitude); basic (≥0.5) = GDAL Lambert (uses altitude).
      // combined / igor / multidirectional are mapped to basic by the renderer.
      const outColor = when(
        [
          [
            method.lt(0.5),
            () => {
              // ── standard ──
              const slope = atan(length(deriv).mul(0.625))
              // atan2 handles deriv.x == 0 (→ ±π/2); no GLSL-style guard needed.
              const aspect = atan2(deriv.y, deriv.x.mul(-1))
              const base = intensity.mul(-1.75).add(1.875)
              const maxValue = PI.mul(0.5)
              // scaledSlope = (slope^base / maxValue^base) * maxValue, except the
              // intensity=0.5 identity (base=1) short-circuits to slope. Guarding
              // the pow against the base=1 identity keeps byte-parity with MapLibre.
              const scaledSlope = when([[abs(intensity.sub(0.5)).lt(1e-6), () => slope]], () =>
                pow(slope, base).div(pow(maxValue, base)).mul(maxValue),
              )
              const accent = cos(scaledSlope)
              const accentColor = HS.field.hs_accent
                .mul(f32(1).sub(accent))
                .mul(clamp(intensity.mul(2), 0, 1))
              const shade = abs(mod(aspect.add(azimuth).div(PI).add(0.5), 2).sub(1))
              const shadeColor = mix(HS.field.hs_shadow, HS.field.hs_highlight, shade)
                .mul(sin(scaledSlope))
                .mul(clamp(intensity.mul(2), 0, 1))
              return accentColor.mul(f32(1).sub(shadeColor.a)).add(shadeColor)
            },
          ],
        ],
        () => {
          // ── basic (GDAL Lambert) ──
          const d2 = deriv.mul(intensity.mul(2))
          const cang = sin(altitude)
            .sub(
              d2.y
                .mul(cos(azimuth))
                .mul(cos(altitude))
                .sub(d2.x.mul(sin(azimuth)).mul(cos(altitude))),
            )
            .div(sqrt(f32(1).add(dot(d2, d2))))
          const shade = clamp(cang, 0, 1)
          return when([[shade.gt(0.5), () => HS.field.hs_highlight.mul(shade.mul(2).sub(1))]], () =>
            HS.field.hs_shadow.mul(f32(1).sub(shade.mul(2))),
          )
        },
      )

      return HillshadeFragmentOutput.construct({
        color: outColor,
        ...(pickEnabled ? { pick: vec2u(0, 0) } : {}),
        depth: compute_log_frag_depth({ view_w: pin.view_w, fc: U.field.proj_params.w }),
      })
    },
    { stage: 'fragment' },
  )
}

export const buildHillshadeModule = (pickEnabled: boolean): ModuleDecl =>
  module({
    // Same shared projection + ecef consts as raster (vs_tile needs them). apply_log_depth
    // is handle-called from the shared vs_tile; getGpuProjectionFuncs are the extern
    // injection seam (needs_backface_cull is called by fs_hillshade).
    consts: [...PROJECTION_CONSTS, ...ECEF_CONSTS],
    structs: [
      U.struct,
      rasterTileU.struct,
      HS.struct,
      VsOut.decl,
      hillshadeFragmentOutput(pickEnabled).decl,
    ],
    bindings: [U.binding, tex.binding, texSampler.binding, HS.binding, rasterTileU.binding],
    funcs: [...getGpuProjectionFuncs(), rasterVsTile, hsElevation, buildFs(pickEnabled)],
  })

/** Full hillshade shader: shared vs_tile + fs_hillshade (DEM decode → Sobel →
 *  standard/basic shade). `pickEnabled` toggles the pick attachment field.
 *  vs_tile handle-calls apply_log_depth, so module() collects it transitively
 *  (same as raster) — no explicit funcs entry needed. */
export const emitHillshadeWgsl = (pickEnabled: boolean): string =>
  emitModule(buildHillshadeModule(pickEnabled))
