// Pure free functions extracted from XGISMap.renderFrame's per-frame
// render path. No `this`, no module state, no GPU coupling — each takes
// explicit inputs and returns a value with NO side effects on map state.
// Moved verbatim from map.ts so the hot render loop reads shorter while
// behaviour stays byte-identical. Mirrors map-geo-helpers.ts in spirit.

import type { LabelDef } from '@xgis/compiler'
import {
  resolveNumberShape,
  resolveColorShape,
  resolveSteppedShape,
} from './render/paint-shape-resolve'
import { hexToRgba } from './feature-helpers'
import { EARTH, lonLatToECEF } from '@xgis/shared'
import { EARTH_R } from '@xgis/geo'
import { mercatorYToLat } from '@xgis/geo'
import {
  projectCpu,
  projectGeomCpu,
  needsBackfaceCullCpu,
  projMercatorCpu,
} from './shaders/dsl/cpu-projections'
import { isGlobeProj } from '@xgis/geo'
import type { Camera } from './camera'
import { WORLD_MERC } from '@xgis/geo'
import { xlog } from '@xgis/shared'

// Projected-x world circumference for the x-periodic flat NON-Mercator set
// (equirect 1 / natural_earth 2 / oblique_mercator 6). This is the SAME
// `world_off_m = wo·2π·EARTH_R` the GPU project_geom applies (projections.ts
// world-copy arms), NOT the Mercator-metre WORLD_MERC constant — conceptually
// it is the projected-x circumference. (Numerically WORLD_MERC ≈ this value,
// but they are kept distinct so the non-merc copy offset tracks project_geom.)
const WORLD_CIRC = 2 * Math.PI * EARTH.sphereR

/** Pop a WebGPU validation error scope and report BOTH failure outcomes.
 *  Fire-and-forget (the popErrorScope promise is intentionally NOT awaited
 *  in the 60 Hz loop). Two things can go wrong and BOTH are now logged:
 *    1. the scope RESOLVES with a real validation error → log it with `tag`;
 *    2. the pop itself REJECTS (scope-stack mismatch / device lost) → log it.
 *  Audit ⑧ B2: the rejection branch was previously `.catch(() => {})`, which
 *  silently dropped a real fault signal (a stack mismatch means an earlier
 *  push/pop is unbalanced; a device-lost reject is the first sign of a GPU
 *  fault). This is the side-effecting exception to this file's pure-helper
 *  rule — it owns only the `xlog` logger, no map state. */
export function reportErrorScope(popPromise: Promise<GPUError | null>, tag: string): void {
  popPromise
    .then((err) => {
      if (err) xlog.error(`[X-GIS ${tag}]`, err.message)
    })
    .catch((e) => {
      xlog.error(
        `[X-GIS ${tag}] popErrorScope rejected`,
        e instanceof Error ? e.message : String(e),
      )
    })
}

/** Per-show label paint resolution. Collapses the unified LabelShapes
 *  bundle (text-size / -color / -halo / font / icon-size / -opacity /
 *  -color / opacity) plus map-aligned point-label bearing into a single
 *  `effectiveDef` snapshot for the per-feature dispatch loop. Data-driven
 *  shapes fall through to their static `def.*` defaults here; the per-
 *  feature `applyFeatureExprs` evaluator overrides them downstream.
 *
 *  Pure: reads only its arguments + the shared (pure) shape resolvers;
 *  mutates nothing on the map. Moved verbatim from renderFrame — the
 *  ONLY wiring change is that `show.fill` and `this.camera.bearing` are
 *  now explicit `layerFill` / `cameraBearing` parameters. */
export function resolveLabelEffectiveDef(
  def: LabelDef,
  shapes: NonNullable<LabelDef['shapes']> | undefined,
  z: number,
  elapsedMs: number,
  layerFill: string | null | undefined,
  cameraBearing: number,
): LabelDef {
  // text-size: constant / zoom-interpolated paths resolve to a
  // concrete number; data-driven needs the per-feature eval
  // path, so we treat its placeholder as the static `def.size`.
  const resolvedSize =
    shapes && shapes.textLayout.size.kind !== 'data-driven'
      ? resolveNumberShape(shapes.textLayout.size, z, elapsedMs).value
      : def.size
  // text-color: null shape → fall back to the layer fill hex.
  // data-driven goes through applyFeatureExprs.
  let resolvedColor: [number, number, number, number] | undefined
  if (shapes && shapes.textPaint.color !== null && shapes.textPaint.color.kind !== 'data-driven') {
    const c = resolveColorShape(shapes.textPaint.color, z, elapsedMs)
    if (c !== null) resolvedColor = c.value as [number, number, number, number]
    else if (shapes.textPaint.color.kind === 'constant')
      resolvedColor = shapes.textPaint.color.value as [number, number, number, number]
  }
  if (resolvedColor === undefined) {
    resolvedColor = hexToRgba(layerFill) ?? [1, 1, 1, 1]
  }
  // text-halo: width + colour resolve independently. When the
  // shape is null the halo axis was never authored; reuse the
  // legacy `def.halo` object as the static fallback so a halo
  // declared without zoom-stops still applies.
  // Iter 130 perf: previous impl did up to 3 object spreads
  // per label per frame to merge haloWidth / haloColor /
  // haloBlur into resolvedHalo. Per-frame label count at z=14
  // OFM Liberty Seoul reaches ~300 labels → ~900 spreads/frame
  // = significant alloc churn on the JS GC. Resolve the 3 knobs
  // into locals first; build resolvedHalo ONCE at the end
  // (single allocation, only when any knob actually changed).
  let haloWidthOverride: number | undefined
  let haloColorOverride: [number, number, number, number] | undefined
  let haloBlurOverride: number | undefined
  if (shapes?.textPaint.haloWidth && shapes.textPaint.haloWidth.kind !== 'data-driven') {
    haloWidthOverride = resolveNumberShape(shapes.textPaint.haloWidth, z, elapsedMs).value
  }
  if (shapes?.textPaint.haloColor && shapes.textPaint.haloColor.kind !== 'data-driven') {
    const c = resolveColorShape(shapes.textPaint.haloColor, z, elapsedMs)
    haloColorOverride =
      c !== null
        ? (c.value as [number, number, number, number])
        : shapes.textPaint.haloColor.kind === 'constant'
          ? (shapes.textPaint.haloColor.value as [number, number, number, number])
          : undefined
  }
  if (shapes?.textPaint.haloBlur && shapes.textPaint.haloBlur.kind !== 'data-driven') {
    haloBlurOverride = resolveNumberShape(shapes.textPaint.haloBlur, z, elapsedMs).value
  }
  let resolvedHalo = def.halo
  if (
    haloWidthOverride !== undefined ||
    haloColorOverride !== undefined ||
    haloBlurOverride !== undefined
  ) {
    // Mapbox spec defaults: text-halo-color transparent black,
    // text-halo-width 0. Used as fallback when a knob is
    // resolved but `def.halo` is absent (haloWidth-only style).
    const baseColor = haloColorOverride ?? def.halo?.color ?? [0, 0, 0, 0]
    const baseWidth = haloWidthOverride ?? def.halo?.width ?? 0
    const baseBlur = haloBlurOverride !== undefined ? haloBlurOverride : def.halo?.blur
    resolvedHalo =
      baseBlur !== undefined
        ? { color: baseColor, width: baseWidth, blur: baseBlur }
        : { color: baseColor, width: baseWidth }
  }
  // Font resolution: family stack / weight / style are three
  // independent PropertyShapes resolved through the shared
  // shape helpers — `resolveNumberShape` for the numeric
  // weight axis, `resolveSteppedShape` for the array / enum
  // axes (font stack / style don't interpolate; they step at
  // the last zoom stop <= camera zoom). Source-format-specific
  // font-name parsing stays in the converter, not the runtime.
  let resolvedFont = def.font
  let resolvedFontWeight = def.fontWeight
  let resolvedFontStyle = def.fontStyle
  if (shapes?.textLayout.font && shapes.textLayout.font.kind !== 'data-driven') {
    const stack = resolveSteppedShape(shapes.textLayout.font, z)
    if (stack !== null && stack.length > 0) resolvedFont = [...stack]
  }
  if (shapes?.textLayout.fontWeight && shapes.textLayout.fontWeight.kind !== 'data-driven') {
    resolvedFontWeight = resolveNumberShape(shapes.textLayout.fontWeight, z, elapsedMs).value
  }
  if (shapes?.textLayout.fontStyle && shapes.textLayout.fontStyle.kind !== 'data-driven') {
    const v = resolveSteppedShape(shapes.textLayout.fontStyle, z)
    if (v !== null) resolvedFontStyle = v
  }
  // text-rotation-alignment: 'map' makes point labels rotate
  // with the map bearing (text follows the world, not the
  // viewport). 'auto' resolves to viewport for point placement
  // and map for line — matching our existing default behaviour
  // (point labels = no rotation, line labels = tangent rotation
  // computed in screen space). For explicit 'map' on points we
  // bake camera bearing into the label rotate. Mapbox 'pitch-
  // alignment: map' (text laid on the ground plane with
  // perspective) requires shader-side MVP integration — not
  // implemented; we still honour the user intent for the
  // rotation knob since it's the more common request.
  const isLineLabel = def.placement === 'line' || def.placement === 'line-center'
  const rotAlign = def.rotationAlignment ?? 'auto'
  const useMapRotForPoints = !isLineLabel && (rotAlign === 'map' || (rotAlign === 'auto' && false)) // auto = viewport for point, no extra rotation
  // Bearing rotation for `map`-aligned point labels. Camera
  // bearing is in degrees CCW; text-rotate is degrees CW.
  // Negate so a 30° map rotation yields a 30° label rotation
  // in the same visual direction.
  const bearingDeg = useMapRotForPoints ? -cameraBearing : 0
  // icon-size — shapes.iconSize is the iter 523 PropertyShape
  // path. Constant + zoom-interp both resolve here; absent
  // shape falls back to def.iconSize (= constant from
  // LabelDef) or the spec default 1 at dispatchIcon. Mirror
  // of the text-size resolve above.
  const resolvedIconSize =
    shapes && shapes.icon.iconSize !== null && shapes.icon.iconSize.kind !== 'data-driven'
      ? resolveNumberShape(shapes.icon.iconSize, z, elapsedMs).value
      : def.iconSize
  // text-opacity — non-constant forms only land here. The
  // constant form is already folded into label-color's alpha
  // at convert-time (applyAlphaMultiplier). Multiplied into
  // resolvedColor.a + resolvedHalo.color.a so halo also fades.
  // Data-driven goes through applyFeatureExprs. Iter 113.
  if (
    shapes &&
    shapes.textPaint.opacity !== null &&
    shapes.textPaint.opacity.kind !== 'data-driven'
  ) {
    const op = resolveNumberShape(shapes.textPaint.opacity, z, elapsedMs).value
    const clamped = Math.max(0, Math.min(1, op))
    if (resolvedColor !== undefined) {
      resolvedColor = [
        resolvedColor[0],
        resolvedColor[1],
        resolvedColor[2],
        resolvedColor[3] * clamped,
      ]
    }
    if (resolvedHalo !== undefined) {
      const hc = resolvedHalo.color as [number, number, number, number]
      resolvedHalo = { ...resolvedHalo, color: [hc[0], hc[1], hc[2], hc[3] * clamped] }
    }
  }
  // icon-opacity — both constant and non-constant route through
  // shapes.iconOpacity (PropertyShape). Falls back to def.iconOpacity
  // (LabelDef constant) when no shape was authored.
  const resolvedIconOpacity =
    shapes && shapes.icon.iconOpacity !== null && shapes.icon.iconOpacity.kind !== 'data-driven'
      ? resolveNumberShape(shapes.icon.iconOpacity, z, elapsedMs).value
      : def.iconOpacity
  // icon-color — constant + zoom-interp route through
  // shapes.iconColor (PropertyShape<RGBA>); data-driven is
  // handled by the per-feature evaluator below (mirrors color).
  let resolvedIconColor: [number, number, number, number] | undefined
  if (shapes && shapes.icon.iconColor !== null && shapes.icon.iconColor.kind !== 'data-driven') {
    const ic = resolveColorShape(shapes.icon.iconColor, z, elapsedMs)
    if (ic !== null) resolvedIconColor = ic.value as [number, number, number, number]
    else if (shapes.icon.iconColor.kind === 'constant')
      resolvedIconColor = shapes.icon.iconColor.value as [number, number, number, number]
  }
  if (resolvedIconColor === undefined) resolvedIconColor = def.iconColor
  // Iter 133 perf: in-place field set instead of conditional
  // spreads. Pre-fix did `{ ...def, ...(cond ? { field } : {}) }`
  // × 7 conditionals → ~8 object allocations per label per frame
  // (300 labels × 8 = 2.4k objs/frame at z=14 OFM Liberty Seoul,
  // dominant GC-pressure source after iter 130's halo merge fix).
  // Single { ...def } copy + direct assignment for each resolved
  // override yields the same effectiveDef shape with 1 alloc.
  const effectiveDef = { ...def, size: resolvedSize, color: resolvedColor }
  if (resolvedHalo !== undefined) effectiveDef.halo = resolvedHalo
  if (resolvedFont !== undefined) effectiveDef.font = resolvedFont
  if (resolvedFontWeight !== undefined) effectiveDef.fontWeight = resolvedFontWeight
  if (resolvedFontStyle !== undefined) effectiveDef.fontStyle = resolvedFontStyle
  if (resolvedIconSize !== undefined) effectiveDef.iconSize = resolvedIconSize
  if (resolvedIconOpacity !== undefined) effectiveDef.iconOpacity = resolvedIconOpacity
  if (resolvedIconColor !== undefined) effectiveDef.iconColor = resolvedIconColor
  if (bearingDeg !== 0) effectiveDef.rotate = (def.rotate ?? 0) + bearingDeg
  return effectiveDef
}

/** #1042 — label-anchor horizon margin, expressed as a FRACTION of the
 *  per-frame visibility headroom `(1 − cosH)`, where `cosH = EARTH_R / |eye|`
 *  is the cosine of the horizon half-angle. The globe tile/anchor cull is a
 *  BINARY tangent-circle test (`dot(e,eye) ≤ EARTH_R·|e|`): an anchor one pixel
 *  inside the limb passes, yet its SCREEN-SPACE quad (tens of px of glyphs)
 *  still draws past the limb — at low zoom + extreme pitch a whole row of
 *  country labels floats above the horizon (#1042 probe, 2026-07-13). We
 *  therefore require a label anchor to sit an angular band INSIDE the tangent
 *  circle before it is drawn. Because the surface near the limb is foreshortened
 *  to sub-pixel, that band trims a WIDE angular rim (the crushed, unreadable
 *  near-limb meridian where the floaters pile up) for a small screen-space cost
 *  — matching MapLibre / Google-Earth, which drop labels within a limb band.
 *
 *  Why a FRACTION of `(1 − cosH)`, NOT an absolute cosine offset `cosH + m`:
 *  globeMode is projection-gated, not zoom-gated (it runs at city zoom), so
 *  `cosH → 1` as the camera nears the surface. An absolute additive margin `m`
 *  is only safe while `m < 1 − cosH`, and the headroom collapses fast —
 *  measured `1 − cosH` is 0.0027 at z12 and 4e-5 at z18 — so ANY fixed `m > 0`
 *  (even 0.008) would eventually exceed it and cull even the DEAD-CENTRE anchor,
 *  blanking every globe label from ~z12 in. Scaling by the headroom keeps the
 *  band a fixed fraction of the visible cap at every zoom: it can never cross
 *  the sub-eye point (fraction < 1) yet still trims the limb rim where one
 *  exists (low zoom). 0.15 matches the sibling flat-path ORTHO_RIM_LABEL_MARGIN,
 *  the codebase's own answer to the same crushed-limb-rim phenomenon, and stays
 *  clear of front-side labels at z3–4 (no label-count regression).
 *
 *  Applied ONLY by the label-pass projector (via the `labelHorizonMargin` gate);
 *  `map.project()` / projectLonLatToScreenCss answer "where does this lon/lat
 *  land", not "should a label draw", so they keep the exact binary tangent cull.
 *  Exported for the calibration / regression gate. */
export const LABEL_HORIZON_MARGIN = 0.15

/** #1042 R2 — screen-space limb inset. The angular LABEL_HORIZON_MARGIN above
 *  is a HEADROOM fraction, so at the low-zoom / extreme-pitch probe camera the
 *  screen compression varies with azimuth and floaters interleave with fine
 *  labels in angular depth — no angular threshold separates them (that is the
 *  round-1 refutation). The round-2 gate is SCREEN-SPACE: a label anchor may
 *  draw only if its projected screen point sits at least this many px INSIDE the
 *  projected globe silhouette, so the label's quad — vertically centred on the
 *  anchor — stays on the disc instead of floating past the limb into empty sky.
 *
 *  Value: HALF the ~14 px default text line-height at DPR 1. The geometric
 *  requirement is the quad's half-extent (the anchor is the quad's centre, so
 *  only half the height rises toward the sky). The probe's OWN keep-witness
 *  proves 14 (a full line-height) would be wrong: at the probe camera (globe z2,
 *  lat 20, pitch 85, 860×720) the "visibly-fine" Kenya anchor (lon 37.9, lat 0.2)
 *  projects just 11.8 px inside the silhouette even though it is 14.8° inside the
 *  horizon — screen compression, the whole point of this gate — while the
 *  floating Chad anchor (lon 18.7, lat 15.4) sits 2.9 px in. 7 px cleanly
 *  separates them (Chad culled, Kenya kept) with ~4 px margin each side. A future
 *  refinement can pass the real per-label quad half-height in place of this
 *  constant. Exported for the regression gate; applied ONLY by the label pass
 *  alongside LABEL_HORIZON_MARGIN — map.project() keeps the exact tangent cull. */
export const LABEL_LIMB_INSET_PX = 7

/** Samples around the horizon circle for the screen-space limb polygon. 64 is
 *  smooth enough that the chord-to-arc gap is < 0.3 px at the probe disc (the
 *  measured Kenya inset moves < 0.2 px from K=64 to K=2048) while the whole build
 *  is 64 matrix projections per frame — negligible next to the O(100s) label
 *  anchors it gates. */
const LIMB_SAMPLES = 64

/** Build the globe's projected screen silhouette (the "limb polygon") for the
 *  label pass. The silhouette of a sphere under any projection is its horizon
 *  circle — the locus of surface points whose view ray is tangent to the sphere:
 *  centre `ê·(R·cosH)`, radius `R·sinH`, in the plane ⊥ ê, where ê = eye/|eye|
 *  and cosH = R/|eye|. This is the SAME sphere/horizon model the anchor back-face
 *  cull uses, so the silhouette and the anchors live in one frame.
 *
 *  Each sample is projected through the IDENTICAL matrix + focus path the anchors
 *  use (focus-subtract → mvp → NDC → screen px), so the inset test is
 *  frame-consistent by construction. Samples with cw ≤ 0 (behind the camera — a
 *  single contiguous arc, since the w<0 half-space cuts the circle in one piece)
 *  are dropped; survivors keep circular order so the closing edge is one chord
 *  across the dropped (off-screen / behind) arc and the FRONT arc the on-screen
 *  anchors test against is intact. Returns null when < 8 survive (degenerate /
 *  extreme camera) so the caller keeps only the cheaper angular margin — never
 *  throws. #1042 round 2. */
function buildGlobeLimbPolygon(
  mvp: Float32Array,
  w: number,
  h: number,
  eye: readonly [number, number, number],
  focus?: readonly [number, number, number],
): { xs: Float64Array; ys: Float64Array; n: number } | null {
  const eyeLen = Math.hypot(eye[0], eye[1], eye[2])
  if (!(eyeLen > EARTH_R)) return null // eye at/under the surface — no horizon
  const ex = eye[0] / eyeLen,
    ey = eye[1] / eyeLen,
    ez = eye[2] / eyeLen // ê
  const cosH = EARTH_R / eyeLen
  const sinH = Math.sqrt(Math.max(0, 1 - cosH * cosH))
  const cCx = ex * (EARTH_R * cosH), // circle centre on ê, R·cosH from Earth centre
    cCy = ey * (EARTH_R * cosH),
    cCz = ez * (EARTH_R * cosH)
  const r = EARTH_R * sinH // circle radius
  // Orthonormal basis u,v ⊥ ê. u = normalize(ê × zAxis); fall back to xAxis when
  // ê ≈ ±z (the cross with z degenerates there).
  let ax = 0,
    ay = 0,
    az = 1
  if (Math.abs(ez) > 0.99) {
    ax = 1
    az = 0
  }
  let ux = ey * az - ez * ay,
    uy = ez * ax - ex * az,
    uz = ex * ay - ey * ax
  const ul = Math.hypot(ux, uy, uz) || 1
  ux /= ul
  uy /= ul
  uz /= ul
  const vx = ey * uz - ez * uy, // v = ê × u (unit: ê ⊥ u, both unit)
    vy = ez * ux - ex * uz,
    vz = ex * uy - ey * ux
  const fx = focus ? focus[0] : 0,
    fy = focus ? focus[1] : 0,
    fz = focus ? focus[2] : 0
  const xs = new Float64Array(LIMB_SAMPLES)
  const ys = new Float64Array(LIMB_SAMPLES)
  let n = 0
  for (let k = 0; k < LIMB_SAMPLES; k++) {
    const t = (k / LIMB_SAMPLES) * (Math.PI * 2)
    const ct = Math.cos(t),
      st = Math.sin(t)
    // p = m + r·(u·cos t + v·sin t) — a point on the sphere's horizon circle.
    // SAME projection as the anchor path: focus-subtract → mvp → NDC → screen px.
    const rx = cCx + r * (ux * ct + vx * st) - fx
    const ry = cCy + r * (uy * ct + vy * st) - fy
    const rz = cCz + r * (uz * ct + vz * st) - fz
    const cw = mvp[3]! * rx + mvp[7]! * ry + mvp[11]! * rz + mvp[15]!
    if (cw <= 0) continue // behind the camera — drop (one contiguous arc)
    const ndcX = (mvp[0]! * rx + mvp[4]! * ry + mvp[8]! * rz + mvp[12]!) / cw
    const ndcY = (mvp[1]! * rx + mvp[5]! * ry + mvp[9]! * rz + mvp[13]!) / cw
    xs[n] = (ndcX + 1) * 0.5 * w
    ys[n] = (1 - ndcY) * 0.5 * h
    n++
  }
  if (n < 8) return null // extreme/degenerate camera — skip the screen test
  return { xs, ys, n }
}

/** Signed distance (screen px) from point (px,py) to a closed polygon of the
 *  first `n` vertices in xs/ys: POSITIVE inside, NEGATIVE outside, magnitude =
 *  distance to the nearest edge. One O(n) pass fuses the even-odd crossing-number
 *  in/out test with a per-edge point-to-segment distance. Used by the globe label
 *  pass to keep an anchor an inset inside the projected globe silhouette. #1042. */
function signedDistToPolygonPx(
  xs: Float64Array,
  ys: Float64Array,
  n: number,
  px: number,
  py: number,
): number {
  let inside = false
  let minD2 = Infinity
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = xs[i]!,
      yi = ys[i]!,
      xj = xs[j]!,
      yj = ys[j]!
    if (yi > py !== yj > py) {
      const xCross = xi + ((py - yi) / (yj - yi)) * (xj - xi)
      if (px < xCross) inside = !inside
    }
    const dx = xj - xi,
      dy = yj - yi
    const segLen2 = dx * dx + dy * dy
    let t = segLen2 > 0 ? ((px - xi) * dx + (py - yi) * dy) / segLen2 : 0
    if (t < 0) t = 0
    else if (t > 1) t = 1
    const cpx = xi + t * dx,
      cpy = yi + t * dy
    const ddx = px - cpx,
      ddy = py - cpy
    const d2 = ddx * ddx + ddy * ddy
    if (d2 < minD2) minD2 = d2
  }
  return (inside ? 1 : -1) * Math.sqrt(minD2)
}

/** The four per-frame label anchor projectors. They form a tight family:
 *  `projectMerc` does the raw merc-metre → screen matrix multiply;
 *  `projectLonLat` dispatches by active projection and delegates the
 *  mercator arm to `projectMerc`; `projectMercAny` inverts absolute merc
 *  metres to lon/lat for non-merc before reusing `projectLonLat`;
 *  `projectLonLatCopies` mirrors the polygon renderer's visible-world-copy
 *  loop for mercator labels.
 *
 *  Display-projection split (projection-display-layer-restore): the anchors
 *  must land on the SAME surface as their features.
 *
 *  - `flat` omitted (globe 7 / tilted azimuthal promoted to 7 + globeMode):
 *    the ECEF projector — `lonLatToECEF → ECEF-MVP → NDC → CSS px`. `mvp`
 *    is `getECEFFrameView().matrix`. lonLatToECEF(lon ± 360°) is the same
 *    point, so world copies collapse to one result.
 *
 *  - `flat` provided (projType 0-6, untilted): the CPU mirror of the
 *    per-vertex shader reprojection (polygon.ts vs_main flat branch). `mvp`
 *    is the flat Mercator-metre MVP (`getViewForProjection → getFrameView`).
 *      · Mercator (projType < 0.5): `rel = merc(lon,lat) − cam_merc`
 *        (cam_merc = ccx/ccy), matching the shader `project(abs) − cam`
 *        branch. World copies are real here → projectLonLatCopies iterates
 *        `flat.visibleWorldCopies`.
 *      · non-Mercator (1-6): `rel = project_geom(lon,lat,refLon) −
 *        project(cam)` — the CPU mirror of `flat_rel` (projections.ts) — with
 *        a backface-cull gate for the ortho/azimuthal/stereographic discs.
 *        refLon = the anchor lon (the label analog of the shader's
 *        tile-centre refLon).
 *
 *  The reused scratch containers (`_projScratch`, `_projectScratch`) are
 *  factory locals created once per frame. Callers must copy values out of a
 *  returned tuple/array before the next call. Invoked ONCE per frame. */
export function makeLabelProjectors(
  mvp: Float32Array,
  w: number,
  h: number,
  flat?: {
    projType: number
    ccx: number
    ccy: number
    centerLon: number
    centerLat: number
    visibleWorldCopies: readonly number[]
  },
  // Absolute sphere-ECEF camera position (GlobeView.eye). Used ONLY by the
  // `!flat` (globe/ECEF) branch to back-face/horizon-cull far-hemisphere
  // anchors so labels behind the globe don't render through it. Ignored on the
  // flat path (which keeps its own needsBackfaceCullCpu rim gate).
  // `readonly` so the camera's `ECEF` tuple (a readonly triple) passes
  // without a copy; the body only reads the components.
  eye?: readonly [number, number, number],
  // Camera focus in absolute sphere-ECEF metres (camera.getECEFCenter()) — the
  // RTC origin of the globe `mvp` (buildGlobeMatrix subtracts the same focus
  // `target`). The `!flat` branch projects `e − focus` because that `mvp` is
  // the RTC (focus-relative) matrix; geometry feeds it `vertex − cameraCenter`
  // too. Omitting it fed ABSOLUTE ECEF into the RTC matrix → labels splayed off
  // their features and, under pitch, shot off the top of the screen (vanished).
  focus?: readonly [number, number, number],
  // #1042 — label pass ONLY. When true, the globe/ECEF cull additionally trims
  // a horizon MARGIN band (LABEL_HORIZON_MARGIN of the visibility headroom) so a
  // near-limb label's screen quad stays inside the globe silhouette.
  // map.project() and every other caller omit it → exact binary tangent cull.
  labelHorizonMargin = false,
): {
  projectMerc: (mx: number, my: number, worldMercatorOffset?: number) => [number, number] | null
  /** `worldCopy` is the COPY INDEX (0, ±1 — from getVisibleWorldCopies), not
   *  metres: the arm multiplies by its own period (Mercator metres vs
   *  projected-x WORLD_CIRC), mirroring projectLonLatCopies. Globe ignores it
   *  (copies collapse on ECEF). #727 (C). */
  projectMercAny: (sx: number, sy: number, worldCopy?: number) => [number, number] | null
  projectLonLat: (lon: number, lat: number, worldMercatorOffset?: number) => [number, number] | null
  projectLonLatCopies: (lon: number, lat: number) => Array<[number, number]>
} {
  // ── 3D / globe path: ECEF projector. Works for every projection because
  //    mvp is getECEFFrameView().matrix; lonLatToECEF(lon ± 360°) is the
  //    same point so world copies collapse to one. ──────────────────────────
  if (!flat) {
    const _projScratch: [number, number] = [0, 0]
    // Per-eye horizon-cull coefficient, multiplied by |e| for each anchor. The
    // exact tangent test uses EARTH_R (map.project and every non-label caller).
    // The label pass (labelHorizonMargin) widens it INWARD by
    // LABEL_HORIZON_MARGIN of the visibility headroom (|eye| − EARTH_R): a
    // fraction of the cap, so it never crosses the sub-eye point as cosH→1 at
    // high zoom. Precomputed once (eye is fixed for this projector). See #1042.
    const eyeLen = eye ? Math.hypot(eye[0], eye[1], eye[2]) : 0
    const horizonCullCoeff =
      labelHorizonMargin && eye ? EARTH_R + LABEL_HORIZON_MARGIN * (eyeLen - EARTH_R) : EARTH_R
    // #1042 R2 — screen-space limb polygon (label pass only). Built ONCE here,
    // tested per surviving anchor below (frame-consistent with the anchor
    // projection by construction — same mvp + focus). null for a degenerate
    // camera → the per-anchor screen test is skipped and only the angular margin
    // above applies. Cheap (LIMB_SAMPLES projections) so it is built whenever the
    // label pass is active; at city zoom the silhouette is a large off-screen
    // loop and the inset test then passes for every on-screen anchor.
    const limbPoly =
      labelHorizonMargin && eye ? buildGlobeLimbPolygon(mvp, w, h, eye, focus) : null

    const projectLonLat = (lon: number, lat: number): [number, number] | null => {
      const e = lonLatToECEF(lon, lat)
      // Horizon / back-face cull (mirrors the globe TILE selector, globe.ts:
      // 409-412). A surface point faces the eye iff
      //   dot(normalize(e), normalize(eye)) > EARTH_R / |eye|.
      // Multiplying both sides by |e|·|eye| (both positive) the |eye| cancels:
      //   dot(e, eye) > EARTH_R · |e|        ← visible
      //   dot(e, eye) <= EARTH_R · |e|       ← far hemisphere → cull
      // EARTH_R is imported from the SAME module the tile cull uses, so labels
      // vanish at EXACTLY the tile horizon. `eye` is absolute sphere coords and
      // `e` is the ellipsoid lonLatToECEF point; the ≤~0.19° geodetic-vs-
      // geocentric direction difference is negligible for a horizon test, so
      // normalize(e) is used directly (no frame conversion — match the sphere
      // model the tile cull uses). `horizonCullCoeff` is EARTH_R for the exact
      // tangent cull, or EARTH_R + margin·(|eye|−EARTH_R) for the label pass
      // (#1042) — the anchor must then sit an angular band inside the limb.
      if (eye) {
        const eLen = Math.hypot(e[0], e[1], e[2])
        const dotEEye = e[0] * eye[0] + e[1] * eye[1] + e[2] * eye[2]
        if (dotEEye <= horizonCullCoeff * eLen) return null
      }
      // `mvp` is the RTC (focus-relative) globe matrix, so feed it the anchor
      // relative to the camera focus — NOT absolute ECEF (the cull above stays
      // absolute). Mirrors the geometry VS's `vertex − cameraCenter`.
      const rx = e[0] - (focus ? focus[0] : 0)
      const ry = e[1] - (focus ? focus[1] : 0)
      const rz = e[2] - (focus ? focus[2] : 0)
      const cw = mvp[3]! * rx + mvp[7]! * ry + mvp[11]! * rz + mvp[15]!
      if (cw <= 0) return null
      const ndcX = (mvp[0]! * rx + mvp[4]! * ry + mvp[8]! * rz + mvp[12]!) / cw
      const ndcY = (mvp[1]! * rx + mvp[5]! * ry + mvp[9]! * rz + mvp[13]!) / cw
      if (ndcX < -1.5 || ndcX > 1.5 || ndcY < -1.5 || ndcY > 1.5) return null
      _projScratch[0] = (ndcX + 1) * 0.5 * w
      _projScratch[1] = (1 - ndcY) * 0.5 * h
      // #1042 R2 — screen-space limb inset (label pass only; limbPoly is null
      // otherwise, so map.project stays byte-identical). The anchor must sit
      // ≥ LABEL_LIMB_INSET_PX inside the projected globe silhouette so its label
      // quad stays on the disc; the angular margin above already trimmed the
      // sub-pixel crush rim. Reuses the just-computed screen point (no re-project).
      if (
        limbPoly &&
        signedDistToPolygonPx(
          limbPoly.xs,
          limbPoly.ys,
          limbPoly.n,
          _projScratch[0],
          _projScratch[1],
        ) < LABEL_LIMB_INSET_PX
      )
        return null
      return _projScratch
    }
    const projectMerc = (mx: number, my: number): [number, number] | null => {
      const DEG2RAD = Math.PI / 180
      const R = EARTH.sphereR
      const lon = mx / (DEG2RAD * R)
      const lat = mercatorYToLat(my)
      return projectLonLat(lon, lat)
    }
    // Copy index ignored: lonLatToECEF(lon ± 360°) is the same point, so world
    // copies collapse to one on the globe (see the branch header above).
    const projectMercAny = (sx: number, sy: number, _worldCopy = 0): [number, number] | null =>
      projectMerc(sx, sy)
    const _projectScratch: Array<[number, number]> = []
    const projectLonLatCopies = (lon: number, lat: number): Array<[number, number]> => {
      _projectScratch.length = 0
      const proj = projectLonLat(lon, lat)
      // Copy out of the shared scratch (matches the flat arm) — defensive
      // symmetry so a future >1-copy extension can't alias.
      if (proj) _projectScratch.push([proj[0], proj[1]])
      return _projectScratch
    }
    return { projectMerc, projectLonLat, projectMercAny, projectLonLatCopies }
  }

  // ── Flat display path (projType 0-6): CPU mirror of the per-vertex shader
  //    reprojection onto the 2D plane, against the flat Mercator-metre MVP. ──
  const { projType, ccx, ccy, centerLon, centerLat, visibleWorldCopies } = flat
  const isMerc = projType < 0.5
  // Orthographic rim-label margin: near the 90° limb a whole meridian of
  // labels (different latitudes, same near-edge longitude) compresses into a
  // few px and stacks vertically (headed ortho z0: Iraq/Saudi/…/Madagascar
  // crammed at the left edge). needs_backface_cull returns RAW cos_c for ortho,
  // so culling at cos_c < this margin trims the outer ~8.6° rim where the
  // labels are illegibly crushed. For azimuthal/stereographic it returns a
  // binary ±1 (their larger discs don't pile up) and flat/cylindrical never
  // cull, so this margin is a no-op for every projType except ortho.
  const ORTHO_RIM_LABEL_MARGIN = 0.15
  // lblCenter = project(cam) — the projected camera centre subtracted from
  // each non-Mercator anchor (Mercator subtracts ccx/ccy merc-metres directly).
  const lblCenter: [number, number] = isMerc
    ? [0, 0]
    : projectCpu(projType, centerLon, centerLat, centerLon, centerLat)
  const _projScratch: [number, number] = [0, 0]

  const projectMerc = (
    mx: number,
    my: number,
    worldMercatorOffset = 0,
  ): [number, number] | null => {
    const rtcX = mx + worldMercatorOffset - ccx
    const rtcY = my - ccy
    const cw = mvp[3]! * rtcX + mvp[7]! * rtcY + mvp[15]!
    if (cw <= 0) return null
    const ndcX = (mvp[0]! * rtcX + mvp[4]! * rtcY + mvp[12]!) / cw
    const ndcY = (mvp[1]! * rtcX + mvp[5]! * rtcY + mvp[13]!) / cw
    if (ndcX < -1.5 || ndcX > 1.5 || ndcY < -1.5 || ndcY > 1.5) return null
    _projScratch[0] = (ndcX + 1) * 0.5 * w
    _projScratch[1] = (1 - ndcY) * 0.5 * h
    return _projScratch
  }

  const projectLonLat = (
    lon: number,
    lat: number,
    worldMercatorOffset = 0,
  ): [number, number] | null => {
    if (isMerc) {
      // Shared clamped CPU Mercator mirror (proj_mercator f64 lowering) —
      // byte-equivalent to the prior inline (same formula, consts, and
      // ±85.051129 clamp); pure de-duplication onto the single source.
      const [mx, my] = projMercatorCpu(lon, lat)
      return projectMerc(mx, my, worldMercatorOffset)
    }
    // non-Mercator flat: CPU mirror of the shader `flat_rel` reprojection.
    // The cull gate matches the disc projections' GPU hemisphere cull, plus an
    // ortho rim margin (see ORTHO_RIM_LABEL_MARGIN) that trims the crushed
    // limb-meridian label pile-up. The margin only affects ortho (raw cos_c);
    // for every other projType needs_backface_cull returns ±1/1 so `< margin`
    // reduces to the original `< 0` back-hemisphere cull.
    if (needsBackfaceCullCpu(projType, lon, lat, centerLon, centerLat) < ORTHO_RIM_LABEL_MARGIN)
      return null
    const p = projectGeomCpu(projType, lon, lat, centerLon, centerLat, lon)
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null
    // World-copy offset in PROJECTED-x space: `worldMercatorOffset` here carries
    // `wo·WORLD_CIRC` (set by projectLonLatCopies), the same `world_off_m` the
    // GPU project_geom adds to p.x for the periodic non-merc arms. projectGeomCpu
    // is the no-offset mirror (cpu-projections.ts:50), so the shift is applied
    // here — feeding a shifted refLon would NOT work (equirect wraps lon-delta).
    const rtcX = p[0] + worldMercatorOffset - lblCenter[0]
    const rtcY = p[1] - lblCenter[1]
    const cw = mvp[3]! * rtcX + mvp[7]! * rtcY + mvp[15]!
    if (cw <= 0) return null
    const ndcX = (mvp[0]! * rtcX + mvp[4]! * rtcY + mvp[12]!) / cw
    const ndcY = (mvp[1]! * rtcX + mvp[5]! * rtcY + mvp[13]!) / cw
    if (ndcX < -1.5 || ndcX > 1.5 || ndcY < -1.5 || ndcY > 1.5) return null
    _projScratch[0] = (ndcX + 1) * 0.5 * w
    _projScratch[1] = (1 - ndcY) * 0.5 * h
    return _projScratch
  }

  const projectMercAny = (sx: number, sy: number, worldCopy = 0): [number, number] | null => {
    // `worldCopy` is the copy INDEX; each arm applies its own period (the same
    // split projectLonLatCopies encodes via copyPeriod) so callers stay
    // arm-agnostic. #727 (C) — tile line labels fan out per visible copy.
    if (isMerc) return projectMerc(sx, sy, worldCopy * WORLD_MERC)
    const R = EARTH.sphereR
    const lon = sx / ((Math.PI / 180) * R)
    const lat = mercatorYToLat(sy)
    return projectLonLat(lon, lat, worldCopy * WORLD_CIRC)
  }

  // Both Mercator and the x-periodic flat non-Mercator set (equirect 1 /
  // natural_earth 2 / oblique_mercator 6) have real ±360° world copies; iterate
  // `visibleWorldCopies` (the camera-derived periodic set, [0] for the
  // azimuthal discs / globe). The per-copy offset differs by space: Mercator
  // shifts in Mercator metres (wo·WORLD_MERC), non-Mercator in projected-x
  // (wo·WORLD_CIRC == the GPU project_geom `world_off_m`). Each result is copied
  // out (projectLonLat returns the shared scratch, overwritten next iteration).
  const _projectScratch: Array<[number, number]> = []
  const copyPeriod = isMerc ? WORLD_MERC : WORLD_CIRC
  const projectLonLatCopies = (lon: number, lat: number): Array<[number, number]> => {
    _projectScratch.length = 0
    for (const wo of visibleWorldCopies) {
      const proj = projectLonLat(lon, lat, wo * copyPeriod)
      if (proj) _projectScratch.push([proj[0], proj[1]])
    }
    return _projectScratch
  }

  return { projectMerc, projectLonLat, projectMercAny, projectLonLatCopies }
}

/** Project `[lon, lat]` → CSS-px screen coords (canvas-local) through the
 *  current camera/projection — the CPU mirror behind `map.project()`. Builds
 *  the SAME projector the label pass uses (`makeLabelProjectors`, the validated
 *  CPU mirror of the polygon/line vertex shader) so the result lands where a
 *  feature at that lon/lat is drawn. `w`/`h` are BACKING px (canvas.width); the
 *  result is divided by `dpr` to CSS px (MapLibre `project` convention).
 *  Returns null when the point is culled (behind globe / off a disc) or the
 *  input is non-finite, and the PRIMARY world copy (single-valued, like
 *  MapLibre). CAVEAT: `centerLon/centerLat` should be the frame's clamped proj
 *  centre (mercatorYToLat(centerY)); the sphere family above ±85° lat in the
 *  untilted flat branch may diverge from the live frame (follow-up). */
export function projectLonLatToScreenCss(
  camera: Camera,
  w: number,
  h: number,
  dpr: number,
  centerLon: number,
  centerLat: number,
  lonLat: readonly [number, number],
): [number, number] | null {
  if (!Number.isFinite(lonLat[0]) || !Number.isFinite(lonLat[1])) return null
  const projType = camera.projType
  const isFlatProj = !camera.globeMode && !isGlobeProj(projType)
  const view = camera.getViewForProjection(projType, w, h, dpr)
  const camMerc = projMercatorCpu(centerLon, centerLat)
  const { projectLonLat } = makeLabelProjectors(
    view.matrix,
    w,
    h,
    isFlatProj
      ? {
          projType,
          ccx: camMerc[0],
          ccy: camMerc[1],
          centerLon,
          centerLat,
          visibleWorldCopies: camera.getVisibleWorldCopies(w, h, dpr),
        }
      : undefined,
    view.eye,
  )
  const r = projectLonLat(lonLat[0], lonLat[1])
  return r ? [r[0] / dpr, r[1] / dpr] : null
}
