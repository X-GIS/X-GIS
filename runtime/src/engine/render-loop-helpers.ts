// Pure free functions extracted from XGISMap.renderFrame's per-frame
// render path. No `this`, no module state, no GPU coupling — each takes
// explicit inputs and returns a value with NO side effects on map state.
// Moved verbatim from map.ts so the hot render loop reads shorter while
// behaviour stays byte-identical. Mirrors map-geo-helpers.ts in spirit.

import type { LabelDef } from '@xgis/compiler'
import { resolveNumberShape, resolveColorShape, resolveSteppedShape } from './render/paint-shape-resolve'
import { hexToRgba } from './feature-helpers'

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
