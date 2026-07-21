// ═══ Shader DSL — hillshade (raster-dem shaded relief) shader (#777 Phase II) ═══
//
// A hillshade tile is structurally a raster tile with a different fragment: the
// vertex stage, the procedural N×N grid, the per-projection dispatch, the pole
// caps and the VsOut varyings are SHARED VERBATIM with raster.ts (rasterVsTile /
// rasterVsOut / rasterU / rasterTileU / rasterTex / rasterTexSampler) so a
// projection fix lands once (design §1). Only the fragment is new: it decodes
// the RGBA8-packed DEM elevation, takes a 3×3 Sobel derivative, applies the
// Mercator latitude correction, and shades via the full MapLibre v5 method set —
// `standard` (legacy), `basic` (GDAL-Lambert), `combined`, `igor`, and
// `multidirectional` (up to 4 averaged Lambert sources).
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
  vec4,
  f32,
  acos,
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
  type ReadonlyNode,
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
    // z=exaggeration, w=method flag (0 standard / 1 basic / 2 combined /
    // 3 igor / 4 multidirectional — MapLibre v5 method set).
    hs_light: vec4fT,
    hs_shadow: vec4fT, // premultiplied shadow-side RGBA (source 1)
    hs_highlight: vec4fT, // premultiplied lit-side RGBA (source 1)
    hs_accent: vec4fT, // premultiplied accent RGBA
    // x = dem texel size (1/dimension); y = deriv_scale =
    // tileSize / pow(2, exaggeration_zoom + 28.2562 − zoom) (design §3 step 2),
    // computed per-frame from the render zoom (exact for the single-LOD steady
    // state; a documented approximation for transient parent-fallback / pitched
    // mixed-LOD tiles — the single-pass MVP does not carry a per-tile scale). zw reserved (0).
    hs_texel: vec4fT,
    // Extra illumination sources 2..4 (method=multidirectional only; the spec
    // allows multiple sources solely there). Each hs_lightN carries x=azimuth_rad
    // (prefolded like hs_light.x), y=altitude_rad. hs_light2.z = TOTAL source
    // count (1..4); unused sources are zero-filled and gated off by the count.
    hs_light2: vec4fT,
    hs_light3: vec4fT,
    hs_light4: vec4fT,
    hs_shadow2: vec4fT, // premultiplied shadow RGBA (source 2)
    hs_highlight2: vec4fT, // premultiplied highlight RGBA (source 2)
    hs_shadow3: vec4fT,
    hs_highlight3: vec4fT,
    hs_shadow4: vec4fT,
    hs_highlight4: vec4fT,
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
      // centre excluded). The stencil CENTRE is clamped one texel inside the
      // tile so all nine taps stay interior: with the raw uv, CLAMP_TO_EDGE
      // collapsed the border row/column into a one-sided difference and drew
      // a flat bright seam along every tile edge — the user-visible per-tile
      // grid. Holding the interior derivative across the last texel removes
      // the seam line; true cross-tile continuity (neighbour edge backfill,
      // MapLibre DEMData.backfillBorder) remains the deferred completion.
      const texel = HS.field.hs_texel.x
      const cu = clamp(pin.uv.x, texel, f32(1).sub(texel))
      const cvv = clamp(pin.uv.y, texel, f32(1).sub(texel))
      const e = (dx: number, dy: number) =>
        hsElevation({ uv: vec2(cu.add(texel.mul(dx)), cvv.add(texel.mul(dy))) })
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

      // Unclamped Lambert cosine-of-incidence for one light source over the
      // exaggeration-scaled derivative (the shared core of basic / combined /
      // multidirectional — MapLibre's cang expression, azimuth prefolded +π).
      const lambertCang = (
        d2: ReadonlyNode<'vec2<f32>'>,
        az: ReadonlyNode<'f32'>,
        alt: ReadonlyNode<'f32'>,
      ) =>
        sin(alt)
          .sub(
            d2.y
              .mul(cos(az))
              .mul(cos(alt))
              .sub(d2.x.mul(sin(az)).mul(cos(alt))),
          )
          .div(sqrt(f32(1).add(dot(d2, d2))))

      // Highlight-vs-shadow split of a clamped Lambert shade (basic +
      // multidirectional share it): shade>0.5 lerps the highlight in, else the
      // shadow (MapLibre basic_hillshade / multidirectional_hillshade body).
      const shadeSplit = (
        shade: ReadonlyNode<'f32'>,
        shadowC: ReadonlyNode<'vec4<f32>'>,
        highlightC: ReadonlyNode<'vec4<f32>'>,
      ) =>
        when([[shade.gt(0.5), () => highlightC.mul(shade.mul(2).sub(1))]], () =>
          shadowC.mul(f32(1).sub(shade.mul(2))),
        )

      // Method dispatch (MapLibre v5 hillshade.fragment.glsl parity):
      // 0 standard / 1 basic / 2 combined / 3 igor / 4 multidirectional.
      const outColor = when(
        [
          [
            method.lt(0.5),
            () => {
              // ── standard (MapLibre legacy; uses accent, ignores altitude) ──
              const slope = atan(length(deriv).mul(0.625))
              // atan2 handles deriv.x == 0 (→ ±π/2); no GLSL-style guard needed.
              const aspect = atan2(deriv.y, deriv.x.mul(-1))
              const base = intensity.mul(-1.75).add(1.875)
              const maxValue = PI.mul(0.5)
              // scaledSlope = ((base^slope − 1) / (base^maxValue − 1)) · maxValue —
              // MapLibre's exponential slope curve. The intensity=0.5 identity
              // (base=1, denominator 0) short-circuits to slope, mirroring
              // MapLibre's `intensity != 0.5` guard.
              const scaledSlope = when([[abs(intensity.sub(0.5)).lt(1e-6), () => slope]], () =>
                pow(base, slope).sub(1).div(pow(base, maxValue).sub(1)).mul(maxValue),
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
          [
            method.lt(1.5),
            () => {
              // ── basic (GDAL Lambert) ──
              const d2 = deriv.mul(intensity.mul(2))
              const shade = clamp(lambertCang(d2, azimuth, altitude), 0, 1)
              return shadeSplit(shade, HS.field.hs_shadow, HS.field.hs_highlight)
            },
          ],
          [
            method.lt(2.5),
            () => {
              // ── combined (slope-weighted Lambert angle) ──
              const d2 = deriv.mul(intensity.mul(2))
              const cang = clamp(acos(lambertCang(d2, azimuth, altitude)), 0, PI.mul(0.5))
              const slopeW = atan(length(d2)).mul(4).div(PI).div(PI)
              const shadow = cang.mul(slopeW)
              const highlight = PI.mul(0.5).sub(cang).mul(slopeW)
              return HS.field.hs_shadow.mul(shadow).add(HS.field.hs_highlight.mul(highlight))
            },
          ],
          [
            method.lt(3.5),
            () => {
              // ── igor (aspect-weighted slope strength; ignores altitude) ──
              const d2 = deriv.mul(intensity.mul(2))
              const aspect = atan2(d2.y, d2.x.mul(-1))
              const slopeStrength = atan(length(d2)).mul(2).div(PI)
              const aspectStrength = f32(1).sub(
                abs(mod(aspect.add(azimuth).div(PI).add(0.5), 2).sub(1)),
              )
              return HS.field.hs_shadow
                .mul(slopeStrength.mul(aspectStrength))
                .add(HS.field.hs_highlight.mul(slopeStrength.mul(f32(1).sub(aspectStrength))))
            },
          ],
        ],
        () => {
          // ── multidirectional (up to 4 Lambert sources, averaged) ──
          const d2 = deriv.mul(intensity.mul(2))
          const count = HS.field.hs_light2.z
          const contrib = (
            az: ReadonlyNode<'f32'>,
            alt: ReadonlyNode<'f32'>,
            shadowC: ReadonlyNode<'vec4<f32>'>,
            highlightC: ReadonlyNode<'vec4<f32>'>,
          ) => shadeSplit(clamp(lambertCang(d2, az, alt), 0, 1), shadowC, highlightC)
          const zero4 = () => vec4(0, 0, 0, 0)
          const c1 = contrib(azimuth, altitude, HS.field.hs_shadow, HS.field.hs_highlight)
          const c2 = when(
            count.gt(1.5),
            () =>
              contrib(
                HS.field.hs_light2.x,
                HS.field.hs_light2.y,
                HS.field.hs_shadow2,
                HS.field.hs_highlight2,
              ),
            zero4,
          )
          const c3 = when(
            count.gt(2.5),
            () =>
              contrib(
                HS.field.hs_light3.x,
                HS.field.hs_light3.y,
                HS.field.hs_shadow3,
                HS.field.hs_highlight3,
              ),
            zero4,
          )
          const c4 = when(
            count.gt(3.5),
            () =>
              contrib(
                HS.field.hs_light4.x,
                HS.field.hs_light4.y,
                HS.field.hs_shadow4,
                HS.field.hs_highlight4,
              ),
            zero4,
          )
          return c1.add(c2).add(c3).add(c4).div(count)
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
