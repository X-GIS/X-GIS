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
): {
  projectMerc: (mx: number, my: number, worldMercatorOffset?: number) => [number, number] | null
  projectLonLat: (lon: number, lat: number, worldMercatorOffset?: number) => [number, number] | null
  projectMercAny: (sx: number, sy: number) => [number, number] | null
  projectLonLatCopies: (lon: number, lat: number) => Array<[number, number]>
} {
  // ── 3D / globe path: ECEF projector. Works for every projection because
  //    mvp is getECEFFrameView().matrix; lonLatToECEF(lon ± 360°) is the
  //    same point so world copies collapse to one. ──────────────────────────
  if (!flat) {
    const _projScratch: [number, number] = [0, 0]

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
      // model the tile cull uses).
      if (eye) {
        const eLen = Math.hypot(e[0], e[1], e[2])
        const dotEEye = e[0] * eye[0] + e[1] * eye[1] + e[2] * eye[2]
        if (dotEEye <= EARTH_R * eLen) return null
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
      return _projScratch
    }
    const projectMerc = (mx: number, my: number): [number, number] | null => {
      const DEG2RAD = Math.PI / 180
      const R = EARTH.sphereR
      const lon = mx / (DEG2RAD * R)
      const lat = mercatorYToLat(my)
      return projectLonLat(lon, lat)
    }
    const projectMercAny = (sx: number, sy: number): [number, number] | null => projectMerc(sx, sy)
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

  const projectMercAny = (sx: number, sy: number): [number, number] | null => {
    if (isMerc) return projectMerc(sx, sy)
    const R = EARTH.sphereR
    const lon = sx / ((Math.PI / 180) * R)
    const lat = mercatorYToLat(sy)
    return projectLonLat(lon, lat, 0)
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
