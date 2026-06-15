// ═══ Mapbox symbol layer → xgis conversion: text-paint / icon / gap passes ═══
// Append-only sub-passes lifted verbatim from convertSymbolLayer in layers.ts
// to keep that god-file under its shrink-only ratchet ceiling. Each pass reads
// the layer + its (already safePropsBag-guarded) layout/paint bags and pushes
// onto the SAME utils[] / warnings[] accumulators the caller threads in, at the
// SAME source position — so the emitted utility + warning order is byte-identical.
// Zero logic change; comments are regression guards kept intact.

import type { MapboxLayer } from './types'
import { exprToXgis } from './expressions'
import { interpolateZoomCall } from './paint'
import { colorToXgis } from './colors'
import {
  unwrapLiteralTuple,
  unwrapLiteralScalar,
  applyAlphaMultiplier,
  isOmittedValue,
  fmtSigned,
} from './layers-helpers'

/** TEXT PAINT pass — text-color / text-opacity / text-size / text-halo-*.
 *  Appends label-color / label-opacity / label-size / label-halo* utilities
 *  (and clamp warnings) onto the caller-supplied accumulators in place. */
export function convertTextPaintProperties(
  layer: MapboxLayer,
  layout: Record<string, unknown>,
  paint: Record<string, unknown>,
  utils: string[],
  warnings: string[],
): void {
  // text-color → label-color-X (Batch 1c-8g). The runtime falls
  // back to the layer's `fill` colour when label-color is unset, so
  // emitting label-color explicitly guarantees the user-intended
  // text colour even on layers that share fill/stroke with the
  // underlying point/polygon. Interpolate-by-zoom routes through
  // the `[interpolate(zoom, …)]` bracket form (every non-trivial
  // Mapbox style uses zoom-interpolated text-color).
  // Mapbox spec defaults — emit explicitly when the source style
  // omits the property. Without this the runtime falls back to its
  // own defaults (e.g. layer fill colour for label-color, 12 px for
  // label-size, no wrap for label-max-width) which DIVERGE from
  // Mapbox's well-known defaults (#000, 16 px, 10 ems). The user's
  // goal is "Mapbox 스타일이 다르게 렌더링되면 안 된다" — emit
  // defaults here so converted styles render identically without
  // changing baseline behaviour for hand-authored xgis.
  // Treat null the same as undefined — Mapbox spec: a null paint
  // value falls back to property default. Same pattern as the paint.ts
  // add* helpers (26b8b20).
  const textColor = paint['text-color']
  // Mapbox `text-opacity` is a paint-axis alpha multiplier on top of
  // text-color's own alpha. When BOTH are simple constants, fold
  // text-opacity into the colour's alpha hex so a single
  // label-color-#rrggbbaa utility carries both. Non-constant forms
  // (zoom interp / data-driven) on either axis fall back to the
  // existing color emission and the spurious "ignored property:
  // text-opacity" warning fires per the layers.ts:992 loop —
  // implementing the non-constant case needs a separate paint shape
  // axis (deferred).
  const textOpacity = unwrapLiteralScalar(paint['text-opacity'])
  const textOpacityConst =
    typeof textOpacity === 'number' && Number.isFinite(textOpacity) && textOpacity >= 0 && textOpacity <= 1
      ? textOpacity : null
  if (!isOmittedValue(textColor)) {
    const interp = interpolateZoomCall(textColor, warnings, (val, w) => colorToXgis(val, w))
    if (interp !== null) {
      utils.push(`label-color-[${interp}]`)
    } else {
      const colorStr = colorToXgis(textColor, warnings)
      if (colorStr) {
        utils.push(`label-color-${applyAlphaMultiplier(colorStr, textOpacityConst)}`)
      } else {
        // Data-driven shape (case / match / get). Route through the
        // generic expression converter — produces a ternary or match
        // body with hex literals for the leaves. lower.ts stores it
        // as `LabelDef.colorExpr`; the runtime evaluates per feature.
        const expr = exprToXgis(textColor, warnings)
        if (expr !== null) {
          utils.push(`label-color-[${expr}]`)
        } else {
          // Couldn't convert — fall back to Mapbox spec default.
          utils.push(`label-color-${applyAlphaMultiplier('#000000', textOpacityConst)}`)
        }
      }
    }
  } else {
    // Mapbox text-color default = "#000000".
    utils.push(`label-color-${applyAlphaMultiplier('#000000', textOpacityConst)}`)
  }

  // iter 113 — non-constant text-opacity (zoom-interp or data-driven).
  // Constant text-opacity is folded into label-color's alpha above;
  // anything else lands on a dedicated `label-opacity-[…]` utility.
  // lower.ts threads zoom-interp into LabelShapes.opacity (PropertyShape
  // zoom-interpolated) and bracket-binding into LabelShapes.opacity
  // (PropertyShape data-driven). Runtime resolves per frame and
  // multiplies into resolvedColor.a + resolvedHalo.color.a.
  if (textOpacity !== undefined && textOpacity !== null && textOpacityConst === null) {
    const interp = interpolateZoomCall(paint['text-opacity'], warnings,
      (val) => typeof val === 'number' && Number.isFinite(val)
        ? String(Math.max(0, Math.min(1, val))) : null)
    if (interp !== null) {
      utils.push(`label-opacity-[${interp}]`)
    } else {
      const expr = exprToXgis(paint['text-opacity'], warnings)
      if (expr !== null) utils.push(`label-opacity-[${expr}]`)
      else warnings.push(`Symbol layer "${layer.id}" — text-opacity non-constant form could not be converted.`)
    }
  }

  // text-size — constant or interpolate-by-zoom. The bracket binding
  // form `label-size-[interpolate(zoom, …)]` is recognised by the
  // lower pass (lower.ts:499) and produces `LabelDef.sizeZoomStops`
  // for per-frame interpolation.
  const textSize = unwrapLiteralScalar(layout['text-size'])
  if (typeof textSize === 'number' && Number.isFinite(textSize)) {
    // Mapbox spec: text-size >= 0. Clamp to prevent
    // `label-size--5` (double-dash utility name) on typo'd
    // negatives. Same class as the line-width / opacity clamps.
    // Number.isFinite gate also rejects NaN / Infinity (typeof NaN
    // === 'number' is true; Math.max(0, NaN) = NaN emits invalid
    // `label-size-NaN`).
    if (textSize < 0) {
      warnings.push(`Symbol layer "${layer.id}" — text-size ${textSize} is negative; Mapbox spec requires >= 0. Clamped to 0 (labels won't render at this zoom).`)
    }
    utils.push(`label-size-${Math.max(0, textSize)}`)
  } else if (textSize !== undefined && textSize !== null) {
    const interp = interpolateZoomCall(textSize, warnings,
      (val) => typeof val === 'number' && Number.isFinite(val) ? String(Math.max(0, val)) : null)
    if (interp !== null) {
      utils.push(`label-size-[${interp}]`)
    } else {
      // Data-driven shape (case / match / get → number). Route
      // through the generic expression converter; lower.ts stores
      // as `LabelDef.sizeExpr`; runtime evaluates per feature.
      const expr = exprToXgis(textSize, warnings)
      if (expr !== null) {
        utils.push(`label-size-[${expr}]`)
      } else {
        warnings.push(`Symbol layer "${layer.id}" — text-size expression form not converted: ${JSON.stringify(textSize).slice(0, 80)}`)
        utils.push('label-size-16')
      }
    }
  } else {
    // Mapbox text-size default = 16.
    utils.push('label-size-16')
  }

  // text-halo-width / text-halo-color → label-halo-N + label-halo-color-X.
  // Both accept zoom-interpolated forms (common on basemap styles
  // that grow halos with zoom for legibility).
  const haloWidth = unwrapLiteralScalar(paint['text-halo-width'])
  if (typeof haloWidth === 'number' && Number.isFinite(haloWidth)) {
    // Same negative + zero skip as the circle-stroke-width fix.
    // Number.isFinite rejects NaN/Infinity — see addStrokeWidth.
    // Both legitimately mean "no halo"; without the tighter type
    // guard a negative literal fell through to the else-if interp
    // path and emitted label-halo-[-N] as a bracket binding.
    if (haloWidth < 0) {
      warnings.push(`Symbol layer "${layer.id}" — text-halo-width ${haloWidth} is negative; Mapbox spec requires >= 0. Skipped (no halo).`)
    }
    if (haloWidth > 0) utils.push(`label-halo-${haloWidth}`)
  } else if (haloWidth !== undefined && haloWidth !== null) {
    // Same negative-clamp guard as text-size — Mapbox spec
    // text-halo-width >= 0.
    const interp = interpolateZoomCall(haloWidth, warnings,
      (val) => typeof val === 'number' && Number.isFinite(val) ? String(Math.max(0, val)) : null)
    if (interp !== null) {
      utils.push(`label-halo-[${interp}]`)
    } else {
      // Per-feature halo width — `["case", …]` / `["match", …]` selecting
      // halo size by feature class. lower.ts has no binding-form arm
      // for the bracket numeric here yet (mirror of text-size's expr
      // path), but emitting the utility lets the IR carry the AST so
      // a follow-up plumbing PR doesn't need a converter change.
      const expr = exprToXgis(haloWidth, warnings)
      if (expr !== null) utils.push(`label-halo-[${expr}]`)
    }
  }
  const haloColor = paint['text-halo-color']
  if (!isOmittedValue(haloColor)) {
    const interp = interpolateZoomCall(haloColor, warnings, (val, w) => colorToXgis(val, w))
    if (interp !== null) {
      utils.push(`label-halo-color-[${interp}]`)
    } else {
      const colorStr = colorToXgis(haloColor, warnings)
      if (colorStr) {
        utils.push(`label-halo-color-${colorStr}`)
      } else {
        // Per-feature halo colour (`["match", ["get","class"], …]`).
        // Mirror of the text-color data-driven path above. Without this
        // fallback, halos with a match expression silently dropped and
        // labels rendered without their declared halo — typical pattern
        // for road shields that pick halo colour by network class.
        const expr = exprToXgis(haloColor, warnings)
        if (expr !== null) utils.push(`label-halo-color-[${expr}]`)
      }
    }
  }
  // text-halo-blur — Mapbox feathering width in pixels. Constant
  // form only for now; the runtime shader smoothstep widens by this
  // value. Real-world use: most basemap styles set 0.5–1.0 px so
  // the halo doesn't look like a hard outline.
  const haloBlur = unwrapLiteralScalar(paint['text-halo-blur'])
  if (typeof haloBlur === 'number' && Number.isFinite(haloBlur)) {
    if (haloBlur < 0) {
      warnings.push(`Symbol layer "${layer.id}" — text-halo-blur ${haloBlur} is negative; Mapbox spec requires >= 0. Skipped (no halo blur).`)
    }
    if (haloBlur > 0) utils.push(`label-halo-blur-${haloBlur}`)
  }

}

/** ICON pass — icon-image / icon-size / icon-anchor / icon-offset / icon-rotate /
 *  icon-rotation-alignment / icon-opacity / icon-color / icon-halo* / icon-text-fit.
 *  Appends label-icon-* utilities (and gap warnings) in place. iconImage is the
 *  function-level unwrapped icon-image scalar the caller already computed. */
export function convertIconProperties(
  layer: MapboxLayer,
  layout: Record<string, unknown>,
  paint: Record<string, unknown>,
  iconImage: unknown,
  utils: string[],
  warnings: string[],
): void {
  // ── Icon (Batch 2 — sprite atlas) ──
  // `icon-image` is a sprite-atlas key. Constant string form only;
  // data-driven (`["get", "marker"]`) silently drops to no-icon for
  // now and surfaces a warning. icon-size / icon-anchor / icon-offset
  // / icon-rotate take their Mapbox defaults when absent.
  if (typeof iconImage === 'string') {
    utils.push(`label-icon-image-${iconImage}`)
  } else if (iconImage !== undefined && iconImage !== null) {
    // Data-driven `icon-image: ["match", ["get", "subclass"], …]`
    // (OFM POI layers) — emit as bracket binding so the lower
    // resolves a per-feature expression AST onto LabelDef.iconImageExpr.
    // Runtime TextStage evaluates the AST per feature, picks the
    // resolved sprite key, and dispatches IconStage.addIcon.
    const expr = exprToXgis(iconImage, warnings)
    if (expr !== null) {
      utils.push(`label-icon-image-[${expr}]`)
    } else {
      warnings.push(`Symbol layer "${layer.id}" — icon-image expression could not be converted: ${JSON.stringify(iconImage).slice(0, 80)}`)
    }
  }
  // icon-size — Mapbox spec: >= 0, default 1. Pre-fix the typeof
  // number gate accepted NaN / Infinity (typeof both === 'number')
  // and emitted invalid utilities (`label-icon-size-NaN` /
  // `-Infinity`) which the lower pass would parseFloat to NaN /
  // Infinity and propagate into per-vertex scale as a poison value.
  // Negative iconSize passed through fmtSigned's bracket form
  // (`label-icon-size-[-2]`) which lower DID accept; the runtime
  // multiplied sprite quad dimensions by the negative scale,
  // flipping the icon and rendering it back-to-front. Clamp + warn
  // matches the text-size pattern (layers.ts:496).
  const iconSize = unwrapLiteralScalar(layout['icon-size'])
  if (typeof iconSize === 'number' && Number.isFinite(iconSize)) {
    if (iconSize < 0) {
      warnings.push(`Symbol layer "${layer.id}" — icon-size ${iconSize} is negative; Mapbox spec requires >= 0. Clamped to 0 (icon hidden).`)
    }
    const clamped = Math.max(0, iconSize)
    if (clamped !== 1) utils.push(`label-icon-size-${fmtSigned(clamped)}`)
  } else if (iconSize !== undefined && iconSize !== null
      && typeof iconSize !== 'number') {
    // Non-constant icon-size — zoom-interp emits the bracket binding
    // form `label-icon-size-[interpolate(zoom, …)]` which lower.ts
    // (iter 523 arm) accumulates into LabelDef.shapes.iconSize as a
    // ZoomStop list. Per-frame resolve at map.ts dispatchIcon. Data-
    // driven (case / match / get) doesn't yet have a path through the
    // labelIconSize accumulator; falls through to the warning.
    const interp = interpolateZoomCall(iconSize, warnings,
      (val) => typeof val === 'number' && Number.isFinite(val) ? String(Math.max(0, val)) : null)
    if (interp !== null) {
      utils.push(`label-icon-size-[${interp}]`)
    } else {
      warnings.push(`Symbol layer "${layer.id}" — icon-size non-constant form not yet supported.`)
    }
  }
  const iconAnchor = unwrapLiteralScalar(layout['icon-anchor'])
  if (typeof iconAnchor === 'string') {
    // Mapbox spec: icon-anchor 9-way enum. Lower rejects unknown
    // values silently (lower.ts:1254 `valid.includes` gate), so a
    // typo would land as `label-icon-anchor-centre` in xgis and the
    // icon would render at the default 'center' anchor with no
    // diagnostic. Warn at convert-time on enum mismatch — mirror
    // of the symbol-placement / text-transform enum validators
    // earlier in this function.
    const validIconAnchors = ['center', 'top', 'bottom', 'left', 'right',
      'top-left', 'top-right', 'bottom-left', 'bottom-right']
    if (!validIconAnchors.includes(iconAnchor)) {
      warnings.push(`Symbol layer "${layer.id}" — icon-anchor "${iconAnchor.slice(0, 40)}" is not a valid enum value; expected one of: ${validIconAnchors.join(', ')}.`)
    } else if (iconAnchor !== 'center') {
      utils.push(`label-icon-anchor-${iconAnchor}`)
    }
  }
  // Per-element v8 literal-wrap unwrap (mirror of text-offset / text-translate).
  const iconOffsetRaw = unwrapLiteralTuple(layout['icon-offset'])
  const iconOffset = Array.isArray(iconOffsetRaw) && iconOffsetRaw.length === 2
    ? iconOffsetRaw.map(c => {
        while (Array.isArray(c) && c.length === 2 && c[0] === 'literal') c = c[1]
        return c
      })
    : null
  if (iconOffset !== null
      && typeof iconOffset[0] === 'number' && typeof iconOffset[1] === 'number') {
    // Two utilities so the xgis-utility-name grammar (`-` is the
    // segment separator) can carry signed numbers without a custom
    // string-comma syntax. Mirrors the `label-offset-x-N` /
    // `label-offset-y-M` split for text-offset.
    if (iconOffset[0] !== 0) utils.push(`label-icon-offset-x-${fmtSigned(iconOffset[0])}`)
    if (iconOffset[1] !== 0) utils.push(`label-icon-offset-y-${fmtSigned(iconOffset[1])}`)
  }
  const iconRotate = unwrapLiteralScalar(layout['icon-rotate'])
  if (typeof iconRotate === 'number' && iconRotate !== 0) {
    utils.push(`label-icon-rotate-${fmtSigned(iconRotate)}`)
  }

  // icon-rotation-alignment "map" — icon rotates with the line
  // tangent when symbol-placement=line (OFM road_oneway / road_
  // oneway_opposite arrows). The "viewport" / "auto" values match
  // X-GIS' default render and are suppressed at the warning loop
  // below (no utility emitted). Only "map" needs the runtime
  // tangent-rotation dispatch path, so we emit a utility for that
  // single value.
  const iconRotAlign = unwrapLiteralScalar(layout['icon-rotation-alignment'])
  if (iconRotAlign === 'map') {
    utils.push('label-icon-rotation-alignment-map')
  } else if (typeof iconRotAlign === 'string'
      && iconRotAlign !== 'viewport' && iconRotAlign !== 'auto') {
    // Mapbox spec: icon-rotation-alignment enum is one of
    // map / viewport / auto. Unknown values (typos like "MAP" /
    // "screen") would silently fall through to X-GIS' default
    // (viewport-aligned icons) without diagnostic.
    warnings.push(`Symbol layer "${layer.id}" — icon-rotation-alignment "${iconRotAlign.slice(0, 40)}" is not a valid enum; expected 'map' | 'viewport' | 'auto'.`)
  }

  // icon-opacity (paint property) — Mapbox alpha multiplier on icon
  // fragment. Constant emits a static utility; zoom-interp / data-
  // driven emit a bracket-binding utility that lower.ts threads into
  // LabelShapes.iconOpacity. Runtime dispatchIcon resolves per frame
  // (zoom) or per feature (data-driven) and overrides def.iconOpacity.
  // Iter 113 — was previously deferred with a warn.
  const iconOpacity = unwrapLiteralScalar(paint['icon-opacity'])
  if (typeof iconOpacity === 'number' && Number.isFinite(iconOpacity) && iconOpacity !== 1) {
    utils.push(`label-icon-opacity-${Math.max(0, Math.min(1, iconOpacity))}`)
  } else if (iconOpacity !== undefined && iconOpacity !== null && typeof iconOpacity !== 'number') {
    const interp = interpolateZoomCall(paint['icon-opacity'], warnings,
      (val) => typeof val === 'number' && Number.isFinite(val)
        ? String(Math.max(0, Math.min(1, val))) : null)
    if (interp !== null) {
      utils.push(`label-icon-opacity-[${interp}]`)
    } else {
      const expr = exprToXgis(paint['icon-opacity'], warnings)
      if (expr !== null) utils.push(`label-icon-opacity-[${expr}]`)
      else warnings.push(`Symbol layer "${layer.id}" — icon-opacity non-constant form could not be converted.`)
    }
  }

  // icon-color: SDF icon tint — Mapbox spec multiplies the sampled
  // SDF texel by an authored colour for sdf:true sprites (highway-
  // shield colour variants etc.). Plan §4, iter 138: the IconRenderer
  // now carries a per-vertex tint + fragment SDF path, so icon-color
  // is plumbed end-to-end the same way text-color is. Constant emits
  // `label-icon-color-<hex>`; zoom-interp / data-driven emit a
  // bracket binding lower.ts threads into LabelShapes.iconColor.
  // Raster sprites ignore the tint (spec) — handled in the renderer.
  const iconColor = paint['icon-color']
  if (!isOmittedValue(iconColor)) {
    const interp = interpolateZoomCall(iconColor, warnings, (val, w) => colorToXgis(val, w))
    if (interp !== null) {
      utils.push(`label-icon-color-[${interp}]`)
    } else {
      const colorStr = colorToXgis(iconColor, warnings)
      if (colorStr) {
        utils.push(`label-icon-color-${colorStr}`)
      } else {
        const expr = exprToXgis(iconColor, warnings)
        if (expr !== null) utils.push(`label-icon-color-[${expr}]`)
        else warnings.push(`Symbol layer "${layer.id}" — icon-color non-constant form could not be converted.`)
      }
    }
  }
  // icon-halo-color / icon-halo-width / icon-halo-blur: SDF icon halo
  // — same Plan §4 dependency as icon-color. Text halo is supported
  // because TextStage emits SDF glyphs; icons are PNG sprites today
  // and need an SDF icon path. Surface specific gap warnings rather
  // than burying in the generic ignoredText blob.
  if (paint['icon-halo-color'] !== undefined && paint['icon-halo-color'] !== null) {
    warnings.push(`Symbol layer "${layer.id}" — icon-halo-color set but X-GIS' IconStage doesn't yet support SDF icon halos (Plan §4 deferred — needs an SDF icon rendering path; PNG sprites can't carry a halo).`)
  }
  if (paint['icon-halo-width'] !== undefined && paint['icon-halo-width'] !== null) {
    warnings.push(`Symbol layer "${layer.id}" — icon-halo-width set but X-GIS' IconStage has no SDF icon halo path (Plan §4 — see icon-halo-color).`)
  }
  if (paint['icon-halo-blur'] !== undefined && paint['icon-halo-blur'] !== null) {
    warnings.push(`Symbol layer "${layer.id}" — icon-halo-blur set but X-GIS' IconStage has no SDF icon halo path (Plan §4 — see icon-halo-color).`)
  }
  // icon-text-fit: stretch icon to fit text bbox per Mapbox spec
  // (`none` / `width` / `height` / `both`). X-GIS' IconStage emits
  // fixed-quad icons sized by icon-size; per-label-bbox sizing needs
  // a different vertex placement pipeline (Plan §4).
  const iconTextFitRaw = unwrapLiteralScalar(layout['icon-text-fit'])
  if (typeof iconTextFitRaw === 'string' && iconTextFitRaw !== 'none') {
    warnings.push(`Symbol layer "${layer.id}" — icon-text-fit "${iconTextFitRaw}" set but X-GIS' IconStage doesn't stretch icons to text bbox yet (Plan §4 deferred — needs per-label-bbox quad placement). Icon renders at its native icon-size.`)
  }

}

/** GAP-WARNINGS pass — deferred specific-gap notes (text-writing-mode,
 *  text-max-angle, symbol-z-order, symbol-avoid-edges) plus the consolidated
 *  ignored-properties note. Warning-only: appends to warnings[] in place. */
export function convertGapWarnings(
  layer: MapboxLayer,
  layout: Record<string, unknown>,
  paint: Record<string, unknown>,
  warnings: string[],
): void {
  // text-writing-mode: CJK / Arabic vertical text per Mapbox spec
  // (`horizontal` default / `vertical`). X-GIS' TextStage walks glyph
  // advances horizontally only; vertical text needs a per-glyph
  // rotation + advance flip path. Surface specific gap.
  const writingModeRaw = unwrapLiteralTuple(layout['text-writing-mode'])
  if (Array.isArray(writingModeRaw) && writingModeRaw.length > 0
      && !(writingModeRaw.length === 1 && writingModeRaw[0] === 'horizontal')) {
    warnings.push(`Symbol layer "${layer.id}" — text-writing-mode set but X-GIS' TextStage walks glyph advances horizontally only; CJK / Arabic vertical text needs per-glyph rotation + advance flip (Plan §4 deferred).`)
  }
  // text-max-angle: per-glyph orientation clamp on line-placed labels
  // (default 45°). X-GIS' line-label path emits labels at segment
  // tangents without clamping the inter-glyph angular delta. Surface
  // specific gap.
  const maxAngleRaw = unwrapLiteralScalar(layout['text-max-angle'])
  if (typeof maxAngleRaw === 'number' && Number.isFinite(maxAngleRaw) && maxAngleRaw !== 45) {
    warnings.push(`Symbol layer "${layer.id}" — text-max-angle ${maxAngleRaw} set but X-GIS' line-label path doesn't clamp per-glyph orientation deltas yet (Plan §4 deferred — labels follow segment tangents without the angular gate). Default 45° matches X-GIS behaviour silently.`)
  }
  // symbol-z-order: per-feature draw-order override (`auto` default /
  // `viewport-y` / `source`). X-GIS uses symbol-sort-key for ordering;
  // symbol-z-order would need a separate sort pass after collision.
  // Surface specific gap.
  const zOrderRaw = unwrapLiteralScalar(layout['symbol-z-order'])
  if (typeof zOrderRaw === 'string' && zOrderRaw !== 'auto') {
    warnings.push(`Symbol layer "${layer.id}" — symbol-z-order "${zOrderRaw}" set but X-GIS uses symbol-sort-key for label ordering; symbol-z-order would need a separate sort pass after collision (Plan §4 deferred).`)
  }
  // symbol-avoid-edges: skip labels whose bbox crosses tile boundaries.
  // X-GIS today uses cross-tile collision instead — symbol-avoid-edges
  // is moot for X-GIS' rendering model but the authored intent isn't
  // reflected. Surface so the author knows the knob doesn't apply.
  const avoidEdgesRaw = unwrapLiteralScalar(layout['symbol-avoid-edges'])
  if (avoidEdgesRaw === true) {
    warnings.push(`Symbol layer "${layer.id}" — symbol-avoid-edges: true set but X-GIS uses cross-tile collision so labels at tile seams aren't double-rendered. The avoid-edges knob is moot for this rendering model — no effect.`)
  }

  const ignoredText: string[] = []
  // Unsupported symbol properties — surface ONE consolidated note per
  // layer so style authors know which knobs landed without effect.
  // Excludes properties whose absence is invisible (text-optional,
  // text-padding when icon-padding isn't used) and the per-Batch
  // already-warned set (data-driven icon-image is its own warning).
  for (const k of [
    // text-writing-mode / text-max-angle: specific gap warnings (iter 90)
    // text-opacity: routed through LabelShapes.opacity (iter 113) — was
    // listed here pre-fix when only the constant fold path existed.
    // icon-color: handled by the specific gap warning above (iter 88)
    // icon-halo-color / -width / -blur: specific gap warnings (iter 89)
    // icon-text-fit: specific gap warning (iter 89)
    'icon-rotation-alignment',
    // symbol-z-order / symbol-avoid-edges: specific gap warnings (iter 91)
    // icon-pitch-alignment: viewport/auto match X-GIS billboard
    // icons; only 'map' is the real gap. Listing it here surfaces
    // 'map' via the consolidated note; viewport/auto suppressed
    // inline below.
    'icon-pitch-alignment',
  ]) {
    // Treat null the same as undefined per Mapbox spec — both mean
    // "property omitted, use default". Pre-fix a null value emitted
    // a spurious warning even though no real declaration existed.
    const lv = layout[k]
    const pv = paint[k]
    if ((lv !== undefined && lv !== null) || (pv !== undefined && pv !== null)) {
      // icon-rotation-alignment: "viewport" is X-GIS' DEFAULT icon
      // render behaviour (icon-renderer paints axis-aligned to the
      // screen). Layers that explicitly request viewport — OFM
      // highway-shield-* (9 layers across bright/liberty/positron) —
      // are NOT lossy; the rendered output matches Mapbox. Only the
      // "map" value (OFM bright road_oneway / road_oneway_opposite —
      // 2 layers, rotation along symbol-placement=line) is a real
      // gap. "auto" with line placement is also a gap, but no OFM
      // hits use that combination today.
      if (k === 'icon-rotation-alignment') {
        // viewport/auto match X-GIS' default icon render; map is
        // handled by the per-segment tangent-rotation path (iter 506
        // — runtime adds the line tangent to def.iconRotate when
        // def.iconRotationAlignment === 'map'). All three values now
        // route correctly — silence the warning.
        const v = unwrapLiteralScalar(lv ?? pv)
        if (v === 'viewport' || v === 'auto' || v === 'map') continue
      }
      // icon-pitch-alignment: viewport / auto match X-GIS' billboard
      // icon rendering (icons stay screen-aligned regardless of
      // camera pitch). 'map' would project the icon quad onto the
      // ground plane — Plan §4 deferred.
      if (k === 'icon-pitch-alignment') {
        const v = unwrapLiteralScalar(lv ?? pv)
        if (v === 'viewport' || v === 'auto') continue
      }
      ignoredText.push(k)
    }
  }
  if (ignoredText.length > 0) {
    warnings.push(`Symbol layer "${layer.id}" — ignored properties (Batch 1d/1e+): ${ignoredText.join(', ')}`)
  }

}
