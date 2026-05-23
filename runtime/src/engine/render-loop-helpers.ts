// Pure free functions extracted from XGISMap.renderFrame's per-frame
// render path. No `this`, no module state, no GPU coupling — each takes
// explicit inputs and returns a value with NO side effects on map state.
// Moved verbatim from map.ts so the hot render loop reads shorter while
// behaviour stays byte-identical. Mirrors map-geo-helpers.ts in spirit.

import type { LabelDef } from '@xgis/compiler'
import { resolveNumberShape, resolveColorShape, resolveSteppedShape } from './render/paint-shape-resolve'
import { hexToRgba } from './feature-helpers'
import { WORLD_MERC } from './gpu/gpu-shared'
import { projectWgsl, needsBackfaceCullWgsl } from './projection/projection-wgsl-mirror'
import { globeForward } from './projection/globe'

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
  const resolvedSize = shapes && shapes.size.kind !== 'data-driven'
    ? resolveNumberShape(shapes.size, z, elapsedMs).value
    : def.size
  // text-color: null shape → fall back to the layer fill hex.
  // data-driven goes through applyFeatureExprs.
  let resolvedColor: [number, number, number, number] | undefined
  if (shapes && shapes.color !== null && shapes.color.kind !== 'data-driven') {
    const c = resolveColorShape(shapes.color, z, elapsedMs)
    if (c !== null) resolvedColor = c.value as [number, number, number, number]
    else if (shapes.color.kind === 'constant') resolvedColor = shapes.color.value as [number, number, number, number]
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
  if (shapes?.haloWidth && shapes.haloWidth.kind !== 'data-driven') {
    haloWidthOverride = resolveNumberShape(shapes.haloWidth, z, elapsedMs).value
  }
  if (shapes?.haloColor && shapes.haloColor.kind !== 'data-driven') {
    const c = resolveColorShape(shapes.haloColor, z, elapsedMs)
    haloColorOverride = (c !== null
      ? c.value as [number, number, number, number]
      : (shapes.haloColor.kind === 'constant'
        ? shapes.haloColor.value as [number, number, number, number]
        : undefined))
  }
  if (shapes?.haloBlur && shapes.haloBlur.kind !== 'data-driven') {
    haloBlurOverride = resolveNumberShape(shapes.haloBlur, z, elapsedMs).value
  }
  let resolvedHalo = def.halo
  if (haloWidthOverride !== undefined || haloColorOverride !== undefined || haloBlurOverride !== undefined) {
    // Mapbox spec defaults: text-halo-color transparent black,
    // text-halo-width 0. Used as fallback when a knob is
    // resolved but `def.halo` is absent (haloWidth-only style).
    const baseColor = haloColorOverride ?? def.halo?.color ?? [0, 0, 0, 0]
    const baseWidth = haloWidthOverride ?? def.halo?.width ?? 0
    const baseBlur = haloBlurOverride !== undefined
      ? haloBlurOverride : def.halo?.blur
    resolvedHalo = baseBlur !== undefined
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
  if (shapes?.font && shapes.font.kind !== 'data-driven') {
    const stack = resolveSteppedShape(shapes.font, z)
    if (stack !== null && stack.length > 0) resolvedFont = [...stack]
  }
  if (shapes?.fontWeight && shapes.fontWeight.kind !== 'data-driven') {
    resolvedFontWeight = resolveNumberShape(shapes.fontWeight, z, elapsedMs).value
  }
  if (shapes?.fontStyle && shapes.fontStyle.kind !== 'data-driven') {
    const v = resolveSteppedShape(shapes.fontStyle, z)
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
  const useMapRotForPoints = !isLineLabel
    && (rotAlign === 'map'
      || (rotAlign === 'auto' && false))  // auto = viewport for point, no extra rotation
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
  const resolvedIconSize = shapes && shapes.iconSize !== null && shapes.iconSize.kind !== 'data-driven'
    ? resolveNumberShape(shapes.iconSize, z, elapsedMs).value
    : def.iconSize
  // text-opacity — non-constant forms only land here. The
  // constant form is already folded into label-color's alpha
  // at convert-time (applyAlphaMultiplier). Multiplied into
  // resolvedColor.a + resolvedHalo.color.a so halo also fades.
  // Data-driven goes through applyFeatureExprs. Iter 113.
  if (shapes && shapes.opacity !== null && shapes.opacity.kind !== 'data-driven') {
    const op = resolveNumberShape(shapes.opacity, z, elapsedMs).value
    const clamped = Math.max(0, Math.min(1, op))
    if (resolvedColor !== undefined) {
      resolvedColor = [resolvedColor[0], resolvedColor[1], resolvedColor[2], resolvedColor[3] * clamped]
    }
    if (resolvedHalo !== undefined) {
      const hc = resolvedHalo.color as [number, number, number, number]
      resolvedHalo = { ...resolvedHalo, color: [hc[0], hc[1], hc[2], hc[3] * clamped] }
    }
  }
  // icon-opacity — both constant and non-constant route through
  // shapes.iconOpacity (PropertyShape). Falls back to def.iconOpacity
  // (LabelDef constant) when no shape was authored.
  const resolvedIconOpacity = shapes && shapes.iconOpacity !== null && shapes.iconOpacity.kind !== 'data-driven'
    ? resolveNumberShape(shapes.iconOpacity, z, elapsedMs).value
    : def.iconOpacity
  // icon-color — constant + zoom-interp route through
  // shapes.iconColor (PropertyShape<RGBA>); data-driven is
  // handled by the per-feature evaluator below (mirrors color).
  let resolvedIconColor: [number, number, number, number] | undefined
  if (shapes && shapes.iconColor !== null && shapes.iconColor.kind !== 'data-driven') {
    const ic = resolveColorShape(shapes.iconColor, z, elapsedMs)
    if (ic !== null) resolvedIconColor = ic.value as [number, number, number, number]
    else if (shapes.iconColor.kind === 'constant') resolvedIconColor = shapes.iconColor.value as [number, number, number, number]
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

/** The four per-frame label anchor projectors, lifted verbatim from
 *  renderFrame. They form a tight family: `projectMerc` does the raw
 *  merc-metre → screen matrix multiply; `projectLonLat` dispatches by
 *  active projection (mercator / globe / non-mercator CPU mirror) and
 *  delegates the mercator arm to `projectMerc`; `projectMercAny` inverts
 *  absolute merc metres to lon/lat for non-merc before reusing
 *  `projectLonLat`; `projectLonLatCopies` mirrors the polygon renderer's
 *  visible-world-copy loop for mercator labels.
 *
 *  Behaviour is byte-identical to the inline closures. The ONLY wiring
 *  change is that the per-frame locals they used to capture (MVP, camera
 *  centre, projection flags, projected focus, the visible-world-copy
 *  list) are now explicit factory parameters, and the two reused scratch
 *  containers (`_projScratch`, `_projectScratch`) are factory locals
 *  created exactly once per frame — same lifetime + reuse contract as the
 *  captured closure consts. Callers must still copy values out of a
 *  returned tuple/array before the next call, exactly as before.
 *
 *  `makeLabelProjectors` is invoked ONCE per frame, replacing the inline
 *  closure definitions — no extra per-frame allocation beyond what the
 *  closures already incurred. */
export function makeLabelProjectors(
  mvp: Float32Array,
  w: number,
  h: number,
  ccx: number,
  ccy: number,
  projType: number,
  centerLon: number,
  centerLat: number,
  isMerc: boolean,
  isGlobe: boolean,
  globeCenter: [number, number, number],
  lblCenter: [number, number],
  projectionName: string | null | undefined,
  visibleWorldCopies: number[],
): {
  projectMerc: (mx: number, my: number, worldMercatorOffset?: number) => [number, number] | null
  projectLonLat: (lon: number, lat: number, worldMercatorOffset?: number) => [number, number] | null
  projectMercAny: (sx: number, sy: number) => [number, number] | null
  projectLonLatCopies: (lon: number, lat: number) => Array<[number, number]>
} {
  // `projectScreen` is a SHARED 2-element scratch — caller copies
  // values out before the next call.
  const _projScratch: [number, number] = [0, 0]
  const projectMerc = (
    mx: number, my: number, worldMercatorOffset: number = 0,
  ): [number, number] | null => {
    const rtcX = (mx + worldMercatorOffset) - ccx
    const rtcY = my - ccy
    const cw = mvp[3]! * rtcX + mvp[7]! * rtcY + mvp[15]!
    if (cw <= 0) return null
    const ccx_ = mvp[0]! * rtcX + mvp[4]! * rtcY + mvp[12]!
    const ccy_ = mvp[1]! * rtcX + mvp[5]! * rtcY + mvp[13]!
    const ndcX = ccx_ / cw
    const ndcY = ccy_ / cw
    if (ndcX < -1.5 || ndcX > 1.5 || ndcY < -1.5 || ndcY > 1.5) return null
    _projScratch[0] = (ndcX + 1) * 0.5 * w
    _projScratch[1] = (1 - ndcY) * 0.5 * h
    return _projScratch
  }

  const projectLonLat = (
    lon: number, lat: number, worldMercatorOffset: number = 0,
  ): [number, number] | null => {
    if (isMerc) {
      // Inlined lonLatToMercator to skip the per-call allocation
      // (used to be `[mx, my] = lonLatToMercator(lon, lat)`).
      const DEG2RAD = Math.PI / 180
      const R = 6378137
      const LAT_LIMIT = 85.051129
      const lat_c = lat < -LAT_LIMIT ? -LAT_LIMIT : (lat > LAT_LIMIT ? LAT_LIMIT : lat)
      const mx = lon * DEG2RAD * R
      const my = Math.log(Math.tan(Math.PI / 4 + lat_c * DEG2RAD / 2)) * R
      const proj = projectMerc(mx, my, worldMercatorOffset)
      if (!proj) return null
      // Return a FRESH 2-tuple — projectMerc's scratch can't survive
      // across multiple projectLonLat calls in the same expression
      // (`projectLonLatCopies` builds a list of results).
      return [proj[0], proj[1]]
    }
    if (isGlobe) {
      // True 3D globe: hemisphere-cull, then sphere RTC against
      // the focus through the FULL 4×4 orbit MVP (the z column is
      // significant here, unlike the flat path which drops it).
      if (needsBackfaceCullWgsl(projType, lon, lat, centerLon, centerLat) < 0) return null
      const g = globeForward(lon, lat)
      const rx = g[0] - globeCenter[0]
      const ry = g[1] - globeCenter[1]
      const rz = g[2] - globeCenter[2]
      const cw = mvp[3]! * rx + mvp[7]! * ry + mvp[11]! * rz + mvp[15]!
      if (cw <= 0) return null
      const ndcX = (mvp[0]! * rx + mvp[4]! * ry + mvp[8]! * rz + mvp[12]!) / cw
      const ndcY = (mvp[1]! * rx + mvp[5]! * ry + mvp[9]! * rz + mvp[13]!) / cw
      if (ndcX < -1.5 || ndcX > 1.5 || ndcY < -1.5 || ndcY > 1.5) return null
      return [(ndcX + 1) * 0.5 * w, (1 - ndcY) * 0.5 * h]
    }
    // Non-Mercator: exact CPU mirror of the GPU per-vertex path.
    // Cull the back hemisphere first (same thresholds as the
    // shader's needs_backface_cull), then project unconditionally
    // and apply the shared MVP. worldMercatorOffset is unused —
    // non-Mercator collapses to a single world copy.
    if (needsBackfaceCullWgsl(projType, lon, lat, centerLon, centerLat) < 0) return null
    const p = projectWgsl(projType, lon, lat, centerLon, centerLat)
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null
    const rtcX = p[0] - lblCenter[0]
    const rtcY = p[1] - lblCenter[1]
    const cw = mvp[3]! * rtcX + mvp[7]! * rtcY + mvp[15]!
    if (cw <= 0) return null
    const ndcX = (mvp[0]! * rtcX + mvp[4]! * rtcY + mvp[12]!) / cw
    const ndcY = (mvp[1]! * rtcX + mvp[5]! * rtcY + mvp[13]!) / cw
    if (ndcX < -1.5 || ndcX > 1.5 || ndcY < -1.5 || ndcY > 1.5) return null
    return [(ndcX + 1) * 0.5 * w, (1 - ndcY) * 0.5 * h]
  }

  const projectMercAny = (sx: number, sy: number): [number, number] | null => {
    if (isMerc) return projectMerc(sx, sy)
    const R = 6378137
    const lon = sx / (Math.PI / 180 * R)
    const lat = (2 * Math.atan(Math.exp(sy / R)) - Math.PI / 2) / (Math.PI / 180)
    return projectLonLat(lon, lat, 0)
  }

  // iter-260 (Plan AAA B.7) — projectLonLatCopies output array
  // reused across calls. Each caller iterates the returned
  // array immediately + doesn't retain it across calls;
  // scratch reuse safe.
  const _projectScratch: Array<[number, number]> = []
  const projectLonLatCopies = (lon: number, lat: number): Array<[number, number]> => {
    _projectScratch.length = 0
    if (projectionName !== 'mercator') {
      const proj = projectLonLat(lon, lat, 0)
      if (proj) _projectScratch.push(proj)
      return _projectScratch
    }
    for (const wo of visibleWorldCopies) {
      const proj = projectLonLat(lon, lat, wo * WORLD_MERC)
      if (proj) _projectScratch.push(proj)
    }
    return _projectScratch
  }

  return { projectMerc, projectLonLat, projectMercAny, projectLonLatCopies }
}
