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
// The DEM sampler is therefore NOT selectable — but `resampling` never selected
// it anyway. MapLibre binds its DEM nearest for BOTH values too, and applies the
// flag to the texture filter on the Sobel-DERIVATIVE output of its prepare pass
// (maplibre-gl 5.24.0, dist/maplibre-gl-dev.js lines 64424 / 64443 / 64453). Shading per
// fragment from a nearest DEM makes the relief flat across each DEM texel — the
// MapLibre `nearest` look — so `resampling: linear`, the Mapbox default, is not
// what renders, and the compiler's `hillshade-resampling-nearest` utility reaches
// no runtime reader (it describes what already happens). An explicitly authored
// `linear` warns at convert time (#2166). Making it real means bilinearly blending
// the DECODED neighbour heights in hs_elevation before the Sobel (design §5) —
// equivalent to filtering the derivative, because the Sobel is a linear
// convolution at integer texel offsets, and STILL SINGLE-PASS.
//
// Residuals: that 4-tap blend (#2215), and the cross-tile 1px edge backfill.
// NOTE "two-pass" in the design doc names a DIFFERENT residual — the
// DEM→derivative-FBO upgrade under "Upgrade path" — so do not size #2215
// against it.

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
  exp2,
  log2,
  cos,
  sin,
  mod,
  abs,
  min,
  pow,
  select,
  sqrt,
  clamp,
  saturate,
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
    // x = dem texel size (1/dimension); y = deriv_base = the ZOOM-INDEPENDENT
    // half of the design §3 step-2 derivative scale, tileSize / pow(2, 28.2562).
    // The zoom-dependent half is per TILE, so hs_deriv_scale applies it in the
    // fragment from the tile's own zoom. zw reserved (0).
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
const Tile = rasterTileU
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

// Sobel derivative scale (design §3 step 2), completed PER TILE.
//
// The Sobel stencil measures metres of elevation per DEM texel, so turning it
// into a slope needs the ground size of a texel — which is set by the ZOOM OF
// THE TILE BEING DRAWN, not by the camera. MapLibre gets this for free (it bakes
// the scale in a per-tile prepare pass, where `u_zoom` IS the tile's zoom); the
// single-pass MVP had only the camera zoom, in a frame uniform. Every tile that
// is not a leaf at the camera's own zoom therefore shaded at the wrong contrast:
// a parent fallback, and — since source `maxzoom` is honoured (#1489) — every
// magnified leaf of a shallow DEM. The error is 2^Δz, so one level out is already
// a doubling, which is the reported tile-to-tile brightness jump.
//
// `merc_span` is TileUniforms.merc_y.y, and a Mercator tile row is exactly
// 2π/2^z tall in the shader's log(tan(π/4+φ/2)) units — so the tile's own zoom
// reads straight back out of a lane the packer already writes. That lane is
// computed in f64 and stored whole (raster-renderer's "avoid f32 cancellation at
// high zoom" split) rather than differenced from two near-equal f32 bounds, so
// recovering the zoom costs no precision. `base` is hillshadeDerivBase — the
// zoom-INDEPENDENT half, tileSize / 2^28.2562.
export const hsDerivScale = fn(
  'hs_deriv_scale',
  { base: f32T, merc_span: f32T },
  ({ base, merc_span }) => {
    const tileZ = log2(PI.mul(2).div(merc_span))
    // MapLibre's zoom-exaggeration ramp: (z−15)·k below z15, flat 0 at/above it.
    // min(z−15, 0) IS that clamp — the term vanishes exactly where MapLibre's
    // `u_zoom < 15.0` guard does, with no branch.
    const k = select(tileZ.lt(2), f32(0.4), select(tileZ.lt(4.5), f32(0.35), f32(0.3)))
    const exaggerationZoom = min(tileZ.sub(15), 0).mul(k)
    return base.mul(exp2(tileZ.sub(exaggerationZoom)))
  },
)

const buildFs = (pickEnabled: boolean, methodFlag: number) => {
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
      const scale = hsDerivScale({
        base: HS.field.hs_texel.y,
        merc_span: Tile.field.merc_y.y,
      }).div(cos(latRad))
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

      // ── The five MapLibre v5 methods, one builder each ──
      // Named (not inlined into the `when` chain) so a pipeline can be SPECIALISED to
      // one method: `methodFlag >= 0` emits that arm ALONE, with no dispatch at all.
      const METHOD_BODY: ReadonlyArray<() => ReadonlyNode<'vec4<f32>'>> = [
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
            .mul(saturate(intensity.mul(2)))
          const shade = abs(mod(aspect.add(azimuth).div(PI).add(0.5), 2).sub(1))
          const shadeColor = mix(HS.field.hs_shadow, HS.field.hs_highlight, shade)
            .mul(sin(scaledSlope))
            .mul(saturate(intensity.mul(2)))
          return accentColor.mul(f32(1).sub(shadeColor.a)).add(shadeColor)
        },
        () => {
          // ── basic (GDAL Lambert) ──
          const d2 = deriv.mul(intensity.mul(2))
          const shade = clamp(lambertCang(d2, azimuth, altitude), 0, 1)
          return shadeSplit(shade, HS.field.hs_shadow, HS.field.hs_highlight)
        },
        () => {
          // ── combined (slope-weighted Lambert angle) ──
          const d2 = deriv.mul(intensity.mul(2))
          const cang = clamp(acos(lambertCang(d2, azimuth, altitude)), 0, PI.mul(0.5))
          const slopeW = atan(length(d2)).mul(4).div(PI).div(PI)
          const shadow = cang.mul(slopeW)
          const highlight = PI.mul(0.5).sub(cang).mul(slopeW)
          return HS.field.hs_shadow.mul(shadow).add(HS.field.hs_highlight.mul(highlight))
        },
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
      ]

      // A SPECIALISED pipeline (methodFlag 0..4) emits its arm alone — no dispatch,
      // no other method's math, no shared-temp pressure from arms that never run.
      // methodFlag < 0 keeps the runtime 5-way dispatch (the un-specialised shader).
      const outColor =
        methodFlag >= 0
          ? METHOD_BODY[Math.min(4, methodFlag)]!()
          : when(
              [
                [method.lt(0.5), METHOD_BODY[0]!],
                [method.lt(1.5), METHOD_BODY[1]!],
                [method.lt(2.5), METHOD_BODY[2]!],
                [method.lt(3.5), METHOD_BODY[3]!],
              ],
              METHOD_BODY[4]!,
            )

      return HillshadeFragmentOutput.construct({
        // raster_params.x = the LAYER's opacity paint (#777 gap): the relief is
        // premultiplied-alpha, so one scalar multiply on the whole RGBA fades it — the
        // hillshade layer now honours `opacity` like every other layer (was hardcoded 1).
        // pin.vis = the PER-TILE fade opacity (TileUniforms.tile_ecef_center.w, the lane
        // the shared vs_tile already interpolates) — a freshly-streamed DEM tile ramps
        // 0→1 over its cached parent instead of popping, exactly as raster fs_tile does.
        color: outColor.mul(U.field.raster_params.x).mul(pin.vis),
        ...(pickEnabled ? { pick: vec2u(0, 0) } : {}),
        depth: compute_log_frag_depth({ view_w: pin.view_w, fc: U.field.proj_params.w }),
      })
    },
    { stage: 'fragment' },
  )
}

/** The hillshade shader module. `methodFlag` SPECIALISES the fragment to one
 *  `hillshade-method` (0 standard / 1 basic / 2 combined / 3 igor / 4
 *  multidirectional — the hillshadeMethodFlag encoding); the default −1 keeps the
 *  runtime 5-way dispatch.
 *
 *  Why specialise (#hillshade-perf): the method is a per-LAYER constant, but the
 *  uber-shader made it a per-FRAGMENT branch — and the optimizer's shared temps
 *  then hoisted every arm's prerequisites (two atan2, an acos, three atan, the
 *  extra sources' Lambert terms) above the branch, so a `basic` relief paid for
 *  `standard` + `combined` + `igor` + `multidirectional` on every pixel. Measured:
 *  all five methods cost the SAME, and cutting the dispatch cut hillshade's frame
 *  cost 140.5 → 115.1 ms (−52 % of its excess over an identical raster tile draw)
 *  on the software rasteriser. One pipeline per method is the standard uber-shader
 *  → static-permutation answer, and a style uses one or two. */
export const buildHillshadeModule = (pickEnabled: boolean, methodFlag = -1): ModuleDecl =>
  module({
    // Same shared projection + ecef consts as raster (vs_tile needs them). apply_log_depth
    // is handle-called from the shared vs_tile; getGpuProjectionFuncs are the extern
    // injection seam (needs_backface_cull is called by fs_hillshade).
    consts: [...PROJECTION_CONSTS, ...ECEF_CONSTS],
    structs: [
      U.struct,
      Tile.struct,
      HS.struct,
      VsOut.decl,
      hillshadeFragmentOutput(pickEnabled).decl,
    ],
    bindings: [U.binding, tex.binding, texSampler.binding, HS.binding, Tile.binding],
    funcs: [
      ...getGpuProjectionFuncs(),
      rasterVsTile,
      hsElevation,
      hsDerivScale,
      buildFs(pickEnabled, methodFlag),
    ],
  })

/** Full hillshade shader: shared vs_tile + fs_hillshade (DEM decode → Sobel →
 *  standard/basic shade). `pickEnabled` toggles the pick attachment field;
 *  `methodFlag` specialises the fragment to one method (see buildHillshadeModule).
 *  vs_tile handle-calls apply_log_depth, so module() collects it transitively
 *  (same as raster) — no explicit funcs entry needed. */
export const emitHillshadeWgsl = (pickEnabled: boolean, methodFlag = -1): string =>
  emitModule(buildHillshadeModule(pickEnabled, methodFlag))
