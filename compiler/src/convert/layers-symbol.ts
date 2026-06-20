// ═══ Mapbox symbol layer → xgis conversion: text-paint / icon / gap passes ═══
// Append-only sub-passes lifted verbatim from convertSymbolLayer in layers.ts
// to keep that god-file under its shrink-only ratchet ceiling. Each pass reads
// the layer + its (already safePropsBag-guarded) layout/paint bags and pushes
// onto the SAME utils[] / warnings[] accumulators the caller threads in, at the
// SAME source position — so the emitted utility + warning order is byte-identical.
// Zero logic change; comments are regression guards kept intact.

import type { MapboxLayer } from './types'
import type { SymbolLayerOverrides } from './layers-types'
import { exprToXgis } from './expressions'
import { interpolateZoomCall } from './paint'
import { colorToXgis } from './colors'
import {
  unwrapLiteralTuple,
  unwrapLiteralScalar,
  applyAlphaMultiplier,
  isOmittedValue,
  fmtSigned,
  unwrapPairScalars,
  VALID_ANCHORS,
  parseMapboxFontName,
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
  // text-max-angle is now threaded end-to-end (label-max-angle-N →
  // LabelDef.maxAngle → curved-label angular gate). Emit handled in
  // convertTextLayoutProperties; no gap warning.
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

/** TEXT-LAYOUT pass - text-anchor / variable-anchor[-offset] / text-transform /
 *  text-offset / text-translate / text-radial-offset / collision (overlap, sort-key,
 *  padding, optional) / text-rotate / letter-spacing / max-width / line-height /
 *  justify / text-font / symbol-placement / rotation+pitch-alignment / symbol-spacing /
 *  keep-upright. Appends label-* layout utilities (and enum / clamp warnings) onto the
 *  caller-supplied accumulators in place, at the SAME source position as the inline
 *  block - so the emitted utility + warning order is byte-identical. `placement` is
 *  computed AND consumed entirely within this pass (overrides.placement ?? layout
 *  ['symbol-placement']); no coupling is left behind in convertSymbolLayer. */
export function convertTextLayoutProperties(
  layer: MapboxLayer,
  layout: Record<string, unknown>,
  paint: Record<string, unknown>,
  overrides: SymbolLayerOverrides | undefined,
  utils: string[],
  warnings: string[],
): void {
  // text-anchor → label-anchor-X. Mapbox's 9-way anchor maps 1:1
  // to the IR's 9-way LabelDef.anchor (render-node.ts:244-246).
  // Earlier versions collapsed corners to the dominant axis because
  // the lower pass only recognised 5 anchors; that shed half the
  // alignment information for any style that anchored labels to a
  // POI's corner (e.g. icons-with-labels where the label sits to
  // the bottom-right of the icon).
  // Precedence (Mapbox spec): `text-variable-anchor-offset` is the
  // modern combined form and supersedes everything else; it is emitted
  // in the offset block below (anchors + per-anchor `label-vao-*`).
  // Otherwise `text-variable-anchor` (the real layout property — NOT
  // an array stuffed into `text-anchor`) lists the candidates; falling
  // back to the static 9-way `text-anchor`. The legacy "array in
  // text-anchor" shape is kept for callers that pre-fold it that way.
  // text-variable-anchor[-offset] both accept the v8 strict `["literal",
  // [...]]` wrapper around the candidates list. Without unwrap the
  // outer Array.isArray passed and the iteration produced the operator
  // string "literal" as a (rejected) anchor name + the inner array
  // (also rejected because not a string) — net result: NO anchors
  // emitted, label fell back to the layer's static text-anchor (or
  // the runtime's "center" default).
  const variableAnchorOffset = unwrapLiteralTuple(layout['text-variable-anchor-offset'])
  const hasVAO = Array.isArray(variableAnchorOffset) && variableAnchorOffset.length >= 2
  const variableAnchor = unwrapLiteralTuple(layout['text-variable-anchor'])
  // Legacy v0/v1 styles can use array form `text-anchor: ["top", "bottom"]`
  // as a pseudo-candidate list (before text-variable-anchor landed).
  // Accept both scalar (`unwrapLiteralScalar` for `["literal", "top"]`)
  // and tuple (`unwrapLiteralTuple` for `["literal", ["top", "bottom"]]`)
  // wrap forms so the iteration below sees the actual values.
  const anchor = unwrapLiteralTuple(unwrapLiteralScalar(layout['text-anchor']))
  // Collect typos / out-of-enum anchor values so we can surface ONE
  // warning per layer (the array forms may carry multiple invalids
  // — duplicate warnings would be noisy). Mirror of iter 520's
  // icon-anchor enum gate; pre-fix invalid strings silently fell
  // through the `VALID_ANCHORS.has` check and the label rendered
  // at the IR default with no diagnostic.
  const invalidAnchors: string[] = []
  if (hasVAO) {
    // handled in the offset block (needs fmtSigned in scope)
  } else if (Array.isArray(variableAnchor) && variableAnchor.length > 0) {
    // Mapbox `text-variable-anchor`: ["top","bottom",…] — emit one
    // `label-anchor-X` per valid candidate, in priority order. lower.ts
    // accumulates these into `LabelDef.anchor` (the first) +
    // `anchorCandidates`; the runtime tries each during collision and
    // picks the first that doesn't overlap an already-placed label.
    for (let a of variableAnchor) {
      // Per-element v8 literal-wrap unwrap. Loop peel for multi-level
      // wraps from preprocessor chains. Mirror of colorToXgis (921d5ad).
      while (Array.isArray(a) && a.length === 2 && a[0] === 'literal') a = a[1]
      if (typeof a === 'string') {
        if (VALID_ANCHORS.has(a)) utils.push(`label-anchor-${a}`)
        else invalidAnchors.push(a.slice(0, 40))
      }
    }
  } else if (typeof anchor === 'string') {
    if (VALID_ANCHORS.has(anchor)) utils.push(`label-anchor-${anchor}`)
    else invalidAnchors.push(anchor.slice(0, 40))
  } else if (Array.isArray(anchor) && anchor.length > 0) {
    for (let a of anchor) {
      while (Array.isArray(a) && a.length === 2 && a[0] === 'literal') a = a[1]
      if (typeof a === 'string') {
        if (VALID_ANCHORS.has(a)) utils.push(`label-anchor-${a}`)
        else invalidAnchors.push(a.slice(0, 40))
      }
    }
  }
  if (invalidAnchors.length > 0) {
    const valid = [...VALID_ANCHORS].join(', ')
    warnings.push(`Symbol layer "${layer.id}" — text-anchor / text-variable-anchor contains invalid enum value(s): ${invalidAnchors.map(s => `"${s}"`).join(', ')}; expected one of: ${valid}.`)
  }

  // text-transform → label-uppercase / lowercase / none.
  const transform = unwrapLiteralScalar(layout['text-transform'])
  if (transform === 'uppercase' || transform === 'lowercase' || transform === 'none') {
    utils.push(`label-${transform}`)
  } else if (typeof transform === 'string') {
    // Mapbox spec: text-transform must be 'none' | 'uppercase' |
    // 'lowercase'. Only flag STRING values that don't match the enum
    // — expression-shaped values (objects/arrays from interpolate /
    // case / etc.) are valid data-driven inputs even though X-GIS
    // doesn't lower them yet.
    warnings.push(`Symbol layer "${layer.id}" — text-transform "${transform.slice(0, 40)}" is not a valid enum; expected 'none' | 'uppercase' | 'lowercase'.`)
  }

  // text-offset → label-offset-x-N + label-offset-y-N (em-units).
  // Mapbox shape: [number, number]. Constant only — interpolate /
  // expression forms wait until the binding-bracket utility lands.
  // Negative values use the bracket binding form `[<n>]` because the
  // utility-name grammar treats `-` as a segment separator — emitting
  // `label-offset-y--0.2` would lex as a malformed double-dash name.
  const offset = unwrapPairScalars(unwrapLiteralTuple(layout['text-offset']))
  if (offset !== null
      && typeof offset[0] === 'number' && Number.isFinite(offset[0])
      && typeof offset[1] === 'number' && Number.isFinite(offset[1])) {
    if (offset[0] !== 0) utils.push(`label-offset-x-${fmtSigned(offset[0])}`)
    if (offset[1] !== 0) utils.push(`label-offset-y-${fmtSigned(offset[1])}`)
  }
  // text-translate (paint) → label-translate-{x,y}-N. Pixel-space
  // offset on top of em-unit text-offset; commonly used to nudge
  // labels off the road centreline (`text-translate: [0, -8]` for
  // an 8-px upward shift). Negatives ride the bracket form like
  // text-offset.
  const translate = unwrapPairScalars(unwrapLiteralTuple(paint['text-translate']))
  if (translate !== null
      && typeof translate[0] === 'number' && Number.isFinite(translate[0])
      && typeof translate[1] === 'number' && Number.isFinite(translate[1])) {
    if (translate[0] !== 0) utils.push(`label-translate-x-${fmtSigned(translate[0])}`)
    if (translate[1] !== 0) utils.push(`label-translate-y-${fmtSigned(translate[1])}`)
  }
  // icon-translate (paint) — CSS-px viewport offset that applies ONLY
  // to the icon (e.g. shift a POI icon up 4px while keeping the label
  // centred). Distinct from text-translate; the runtime threads it
  // through dispatchIcon → IconStage.addIcon at dispatch time. Emits
  // the dedicated `label-icon-translate-{x,y}-N` utility pair (mirror
  // of icon-offset's split — `-` is the utility-grammar segment
  // separator, so signed values ride the bracket form via fmtSigned).
  // icon-translate-anchor: viewport (default) is the honoured mode; a
  // map-space anchor would shift in world coords (not implemented).
  const iconTranslateRaw = unwrapLiteralTuple(paint['icon-translate'])
  const iconTranslate = Array.isArray(iconTranslateRaw) && iconTranslateRaw.length === 2
    ? iconTranslateRaw.map(c => {
        while (Array.isArray(c) && c.length === 2 && c[0] === 'literal') c = c[1]
        return c
      })
    : null
  if (iconTranslate !== null
      && typeof iconTranslate[0] === 'number' && Number.isFinite(iconTranslate[0])
      && typeof iconTranslate[1] === 'number' && Number.isFinite(iconTranslate[1])) {
    if (iconTranslate[0] !== 0) utils.push(`label-icon-translate-x-${fmtSigned(iconTranslate[0])}`)
    if (iconTranslate[1] !== 0) utils.push(`label-icon-translate-y-${fmtSigned(iconTranslate[1])}`)
  } else if (paint['icon-translate'] !== undefined && paint['icon-translate'] !== null) {
    warnings.push(`Symbol layer "${layer.id}" — icon-translate non-constant form (expression / interpolate) not yet supported; the constant [dx, dy] form is. Offset dropped.`)
  }
  // icon-translate-anchor: only "viewport" (the spec default) is
  // honoured; "map" would offset in world space (not implemented).
  const iconTranslateAnchor = unwrapLiteralScalar(paint['icon-translate-anchor'])
  if (iconTranslateAnchor === 'map') {
    warnings.push(`Symbol layer "${layer.id}" — icon-translate-anchor "map" not implemented; icon-translate is applied in viewport (screen) space.`)
  }
  // text-radial-offset (em) → label-radial-offset-N. Only meaningful
  // alongside text-variable-anchor: the runtime pushes the label away
  // from the anchor point by this radius in each candidate anchor's
  // direction (MapLibre fromRadialOffset). Mapbox spec clamps a
  // negative radial offset to 0, so we apply the same clamp at convert
  // time — also avoids emitting `label-radial-offset-[-0.5]` (bracket
  // form for the negative) which the runtime then would honour
  // against spec.
  const radialOffset = unwrapLiteralScalar(layout['text-radial-offset'])
  // `> 0` rejects NaN (NaN > 0 = false), so no extra Number.isFinite
  // guard needed here — keep the comparison as-is.
  if (typeof radialOffset === 'number' && radialOffset > 0) {
    utils.push(`label-radial-offset-${radialOffset}`)
  }
  // text-variable-anchor-offset → ordered `label-anchor-X` candidates
  // plus a `label-vao-<i>-{x,y}-N` per pair (em units). `<i>` is the
  // 0-based pair index so the anchor name's own hyphen (`top-left`)
  // can't make the utility name ambiguous; lower.ts zips index i back
  // onto the i-th emitted candidate. Zero components are dropped (the
  // missing axis defaults to 0, mirroring text-offset).
  if (hasVAO) {
    let idx = 0
    for (let i = 0; i + 1 < variableAnchorOffset!.length; i += 2) {
      const a = variableAnchorOffset![i]
      // Per-pair offset can be the bare [x, y] OR Mapbox v8's
      // `["literal", [x, y]]` wrapper. Mirror of the unwrap applied
      // to text-offset / icon-offset (7986ea5).
      const offRaw = unwrapLiteralTuple(variableAnchorOffset![i + 1])
      // Per-element scalar wrap unwrap so `[["literal", 0], ["literal", -1]]`
      // resolves correctly. Mirror of text-offset / icon-offset.
      const off = Array.isArray(offRaw) && offRaw.length === 2
        ? offRaw.map(c => {
            while (Array.isArray(c) && c.length === 2 && c[0] === 'literal') c = c[1]
            return c
          })
        : null
      if (typeof a === 'string' && VALID_ANCHORS.has(a)
          && off !== null
          && typeof off[0] === 'number' && Number.isFinite(off[0])
          && typeof off[1] === 'number' && Number.isFinite(off[1])) {
        utils.push(`label-anchor-${a}`)
        if (off[0] !== 0) utils.push(`label-vao-${idx}-x-${fmtSigned(off[0])}`)
        if (off[1] !== 0) utils.push(`label-vao-${idx}-y-${fmtSigned(off[1])}`)
        idx++
      }
    }
  }

  // Collision controls (Batch 1e). text-padding accepts both constant
  // and interpolate-by-zoom in Mapbox.
  //
  // text-allow-overlap (Mapbox v8) and text-overlap (MapLibre 2+,
  // supersedes allow-overlap with an enum) both map onto the same
  // engine-side "always place this label regardless of collision"
  // flag. text-overlap wins if BOTH are present — MapLibre semantics
  // make text-overlap the modern source of truth.
  //   'always'      → label-allow-overlap (place ignoring collision)
  //   'never'       → no utility (default — collision applies)
  //   'cooperative' → label-allow-overlap (MapLibre's third state is
  //                   "place only if no higher-priority overlap" — we
  //                   don't have priority-aware collision yet, so the
  //                   conservative fallback is to place; a warning
  //                   surfaces so the style author knows).
  // text-overlap + text-allow-overlap both accept v8 strict
  // `["literal", "always"]` / `["literal", true]` wrappers. Without
  // the unwrap the raw `=== 'always'` / `=== true` comparison missed
  // the wrapped form and the label silently obeyed default collision.
  const textOverlap = unwrapLiteralScalar(layout['text-overlap'])
  const textAllowOverlap = unwrapLiteralScalar(layout['text-allow-overlap'])
  if (textOverlap === 'always') {
    utils.push('label-allow-overlap')
  } else if (textOverlap === 'cooperative') {
    utils.push('label-allow-overlap')
    warnings.push(`Symbol layer "${layer.id}" — text-overlap: "cooperative" approximated as "always" (priority-aware collision pending).`)
  } else if (textOverlap === 'never') {
    // Default — no utility needed.
  } else if (textOverlap !== undefined && textOverlap !== null) {
    warnings.push(`Symbol layer "${layer.id}" — unrecognised text-overlap value ${JSON.stringify(textOverlap)}; ignored.`)
  } else if (textAllowOverlap === true) {
    // Legacy fallback only when the new property is absent.
    utils.push('label-allow-overlap')
  }
  // Mapbox `symbol-sort-key` — lower values place first, winning
  // collisions against higher-keyed labels (state/city > town >
  // road shield ordering). Extracted from layout into LabelDef.
  // sortKey downstream. Constant numeric form only for now —
  // expression form (`["get", "rank"]`) drops to 0 with a warning
  // so the layer still routes through the collision system.
  const sortKey = unwrapLiteralScalar(layout['symbol-sort-key'])
  if (typeof sortKey === 'number' && Number.isFinite(sortKey)) {
    utils.push(`label-sort-key-${fmtSigned(sortKey)}`)
  } else if (sortKey !== undefined && sortKey !== null) {
    warnings.push(`Symbol layer "${layer.id}" — symbol-sort-key expression form not supported yet; flattened to 0.`)
  }
  // icon-overlap / icon-allow-overlap: ignored.
  //
  // PREVIOUS BEHAVIOUR (regression source): we propagated these to
  // `label-allow-overlap` on the rationale that "the engine routes
  // both through the same per-label collision pass today". Mapbox /
  // MapLibre spec is unambiguous that icon and text collision are
  // INDEPENDENT — `icon-allow-overlap: true` means "icons place
  // ignoring collision; text still obeys text-allow-overlap". OFM
  // styles set `icon-allow-overlap: true` on label_city/town/village/
  // city_capital to keep city dots visible, and the old code converted
  // that to "text always places" — producing 60-70 % of point labels
  // bypassing collision and the dense Korean-city-name clutter the
  // user reported on the pitched Positron view (#12.21/37.19/127.27/
  // 0/69). Now: we silently drop these flags. When icon rendering
  // arrives a dedicated `icon-allow-overlap` IR field threads them
  // through; until then they're no-ops for the text collision path.
  const iconOverlap = unwrapLiteralScalar(layout['icon-overlap'])
  if (iconOverlap !== undefined && iconOverlap !== null
      && iconOverlap !== 'always' && iconOverlap !== 'never' && iconOverlap !== 'cooperative') {
    warnings.push(`Symbol layer "${layer.id}" — unrecognised icon-overlap value ${JSON.stringify(iconOverlap)}; ignored.`)
  }
  // icon-overlap: 'never' / 'cooperative' and icon-allow-overlap: false
  // are the REAL gaps: X-GIS has no icon-side collision queue, so
  // icons always render regardless of overlap with other icons.
  // Authors of dense POI layers (e.g. city dots at low zoom) won't
  // see deduplication. Surface the gap so the lack of collision is
  // diagnostic rather than mystery. 'always' / true match X-GIS
  // default (place every icon) — silent.
  if (iconOverlap === 'never' || iconOverlap === 'cooperative') {
    warnings.push(`Symbol layer "${layer.id}" — icon-overlap "${iconOverlap}" set but X-GIS has no icon-side collision queue yet (Plan §3.1 deferred); icons place at every anchor regardless.`)
  }
  const iconAllowOverlap = unwrapLiteralScalar(layout['icon-allow-overlap'])
  if (iconAllowOverlap === false) {
    warnings.push(`Symbol layer "${layer.id}" — icon-allow-overlap: false set but X-GIS has no icon-side collision queue yet (Plan §3.1 deferred); icons place at every anchor regardless.`)
  }
  if (unwrapLiteralScalar(layout['text-ignore-placement']) === true) utils.push('label-ignore-placement')
  const padding = unwrapLiteralScalar(layout['text-padding'])
  if (typeof padding === 'number' && Number.isFinite(padding)) {
    // Mapbox spec: text-padding >= 0. Number.isFinite gate rejects
    // NaN / Infinity slipping past the typeof check.
    if (padding < 0) {
      warnings.push(`Symbol layer "${layer.id}" — text-padding ${padding} is negative; Mapbox spec requires >= 0. Clamped to 0.`)
    }
    utils.push(`label-padding-${Math.max(0, padding)}`)
  } else if (padding !== undefined && padding !== null) {
    const interp = interpolateZoomCall(padding, warnings,
      (val) => typeof val === 'number' && Number.isFinite(val) ? String(Math.max(0, val)) : null)
    if (interp !== null) utils.push(`label-padding-[${interp}]`)
  }

  // icon-padding — spec default 2. X-GIS doesn't have an icon-side
  // collision queue yet (Phase C.9), so the padding is a no-op
  // regardless of value. Warn ONLY when the author declared a non-
  // default value — declaring the default is the same as not
  // declaring it, so the absence of an implementation is invisible
  // to spec-default users. OFM bright authors `icon-padding: 2` on
  // road_oneway / road_oneway_opposite (both default values); under
  // this gate they stay lossless. Mirror of iter 494 icon-rotation-
  // alignment viewport/auto suppression.
  const iconPadding = unwrapLiteralScalar(layout['icon-padding'])
  if (typeof iconPadding === 'number' && Number.isFinite(iconPadding) && iconPadding !== 2) {
    warnings.push(`Symbol layer "${layer.id}" — icon-padding ${iconPadding} declared but X-GIS has no icon-side collision queue yet (Phase C.9); icons will pack at the spec-default spacing.`)
  } else if (iconPadding !== undefined && iconPadding !== null && typeof iconPadding !== 'number') {
    warnings.push(`Symbol layer "${layer.id}" — icon-padding non-constant form not yet supported.`)
  }

  // text-optional / icon-optional — placement-policy pair. Both spec
  // defaults are `false` (text+icon must both place, or neither does
  // — matching X-GIS' current contract: drop the pair when either
  // can't fit). `text-optional: true` lets the icon survive alone
  // when the label can't fit; `icon-optional: true` lets the label
  // survive alone when the icon can't fit. Neither is implemented
  // (would need split icon/text collision arbitration in the symbol
  // placement queue). OFM airport authors `text-optional: true` in
  // all 3 OFM styles — at dense urban zooms the airport icon (sprite
  // `airport_11`) would render alone in MapLibre when the "Airport"
  // label can't fit, but X-GIS drops both. Warn only on the non-
  // default value so OFM `icon-optional: false` (the default,
  // authored explicitly on the 4 label_* layers per style) doesn't
  // regress the lossless metric.
  const textOptional = unwrapLiteralScalar(layout['text-optional'])
  if (textOptional === true) {
    warnings.push(`Symbol layer "${layer.id}" — text-optional: true declared but X-GIS' symbol placement always pairs text + icon (deferred — needs split text/icon collision arbitration). The label may be dropped at zoom levels where MapLibre would render icon-only.`)
  }
  const iconOptional = unwrapLiteralScalar(layout['icon-optional'])
  if (iconOptional === true) {
    warnings.push(`Symbol layer "${layer.id}" — icon-optional: true declared but X-GIS' symbol placement always pairs text + icon (deferred — needs split text/icon collision arbitration). The icon may be dropped at zoom levels where MapLibre would render label-only.`)
  }

  // text-rotate (degrees clockwise) + text-letter-spacing (em-units).
  // Both can be negative (counter-clockwise rotation, condensed
  // tracking) → bracket form for negatives. Mapbox text-letter-spacing
  // is zoom-interpolatable; large basemap styles fade tracking out at
  // low zoom for legibility.
  const rotate = unwrapLiteralScalar(layout['text-rotate'])
  if (typeof rotate === 'number' && Number.isFinite(rotate) && rotate !== 0) {
    utils.push(`label-rotate-${fmtSigned(rotate)}`)
  } else if (rotate !== undefined && rotate !== null && typeof rotate !== 'number') {
    // zoom-interpolated or per-feature rotate. Routes through the
    // bracket-binding form so the IR carries the expression; the
    // lower pass currently has no `label-rotate-[…]` consumer (per
    // the diagnostic warning path at lower.ts:957) so the binding
    // surfaces a warn-level diagnostic on emit. Mirror of the
    // letter-spacing / max-width zoom-interp paths below.
    const interp = interpolateZoomCall(rotate, warnings,
      (val) => typeof val === 'number' && Number.isFinite(val) ? String(val) : null)
    if (interp !== null) {
      utils.push(`label-rotate-[${interp}]`)
    } else {
      const expr = exprToXgis(rotate, warnings)
      if (expr !== null) utils.push(`label-rotate-[${expr}]`)
    }
  }
  const letterSpacing = unwrapLiteralScalar(layout['text-letter-spacing'])
  if (typeof letterSpacing === 'number' && Number.isFinite(letterSpacing) && letterSpacing !== 0) {
    utils.push(`label-letter-spacing-${fmtSigned(letterSpacing)}`)
  } else if (letterSpacing !== undefined && letterSpacing !== null && typeof letterSpacing !== 'number') {
    const interp = interpolateZoomCall(letterSpacing, warnings,
      (val) => typeof val === 'number' && Number.isFinite(val) ? String(val) : null)
    if (interp !== null) utils.push(`label-letter-spacing-[${interp}]`)
  }

  // text-max-width / text-line-height (em-units) + text-justify
  // for multiline labels. Mapbox's text-max-width default = 10 (ems)
  // is "disabled by symbol-placement: line" per the spec — for line
  // labels we mirror that by NOT emitting the default, which leaves
  // the runtime's "undefined ⇒ no wrap" behaviour for road names etc.
  const maxWidth = unwrapLiteralScalar(layout['text-max-width'])
  // When an override is supplied (zoom-step layer split), it WINS
  // over the layout value. The outer dispatcher computes one segment
  // per step range and re-runs convertSymbolLayer with the segment's
  // resolved placement string.
  // Unwrap literal here so v8-strict `["literal", "line"]` resolves
  // to the bare enum BEFORE every downstream `=== 'line'` /
  // `=== 'line-center'` check. parseSymbolPlacementStep separately
  // handles the `["step", ["zoom"], …]` shape and feeds the segment's
  // resolved placement through overrides.placement, which is always
  // a bare string by construction.
  const placement: unknown = overrides?.placement !== undefined
    ? overrides.placement
    : unwrapLiteralScalar(layout['symbol-placement'])
  if (typeof maxWidth === 'number' && Number.isFinite(maxWidth)) {
    // Mapbox spec: text-max-width >= 0 (em units). Number.isFinite
    // rejects NaN / Infinity.
    if (maxWidth < 0) {
      warnings.push(`Symbol layer "${layer.id}" — text-max-width ${maxWidth} is negative; Mapbox spec requires >= 0. Clamped to 0 (label wraps every character).`)
    }
    utils.push(`label-max-width-${Math.max(0, maxWidth)}`)
  } else if (placement !== 'line' && placement !== 'line-center') {
    utils.push('label-max-width-10')
  }
  const lineHeight = unwrapLiteralScalar(layout['text-line-height'])
  // Spec: text-line-height >= 0 (em units).
  if (typeof lineHeight === 'number' && Number.isFinite(lineHeight)) {
    if (lineHeight < 0) {
      warnings.push(`Symbol layer "${layer.id}" — text-line-height ${lineHeight} is negative; Mapbox spec requires >= 0. Clamped to 0.`)
    }
    utils.push(`label-line-height-${Math.max(0, lineHeight)}`)
  }
  const justify = unwrapLiteralScalar(layout['text-justify'])
  if (justify === 'auto' || justify === 'left' || justify === 'center' || justify === 'right') {
    utils.push(`label-justify-${justify}`)
  } else if (typeof justify === 'string') {
    // Mapbox spec: text-justify must be 'auto' | 'left' | 'center'
    // | 'right'. Only flag string values — expression-shaped values
    // pass through to downstream handling.
    warnings.push(`Symbol layer "${layer.id}" — text-justify "${justify.slice(0, 40)}" is not a valid enum value; expected 'auto' | 'left' | 'center' | 'right'.`)
  }

  // text-font: ["Noto Sans Regular", "Noto Sans CJK KR Regular"] →
  // one `label-font-Noto-Sans` utility per stack entry PLUS
  // separate `label-font-weight-N` / `label-font-style-italic`
  // utilities derived from the trailing weight / italic words.
  //
  // Previously we kept the full Mapbox font name as one identifier
  // (e.g. `Noto-Sans-Bold`). The runtime fed that straight into
  // ctx.font as a family name, the browser failed to match any
  // installed face called "Noto-Sans-Bold", and silently fell back
  // to the OS default — so every Mapbox style rendered in the same
  // Regular weight regardless of what it asked for. Splitting
  // family from weight/style here lets the runtime build a proper
  // CSS shorthand ("700 24px Noto Sans, …") so the browser actually
  // selects the Bold / Italic face.
  //
  // Per-stack-entry semantics: Mapbox font stacks usually share the
  // same weight/style (entries differ in script coverage, not face
  // — "Noto Sans Bold" + "Noto Sans CJK KR Bold"). We parse weight/
  // style from each entry and emit a single utility for whichever
  // value appears most often (first non-default wins).
  // text-font may be wrapped as `["literal", [...]]` under v8 strict
  // tooling; the bare-array shape is the default. Without the unwrap
  // the outer Array.isArray passed and the iteration produced
  // `label-font-literal` (treating the operator string as a family
  // name). Mirror of the unwrap pattern in parseSymbolPlacementStep.
  const fontStack = unwrapLiteralTuple(layout['text-font'])
  // Mapbox spec: text-font is an Array of strings (each a font face
  // name). A single string ("Noto Sans Regular" instead of ["Noto Sans
  // Regular"]) is a spec violation — silently dropped by the
  // Array.isArray gate below. Surface so the author sees the typo.
  if (layout['text-font'] !== undefined && layout['text-font'] !== null
      && !Array.isArray(fontStack)) {
    warnings.push(`Symbol layer "${layer.id}" — text-font must be an array of strings per Mapbox spec; got ${typeof layout['text-font']} (${JSON.stringify(layout['text-font']).slice(0, 60)}). Authored font dropped — labels render with the runtime fallback font.`)
  }
  if (Array.isArray(fontStack) && fontStack.length > 0) {
    let emittedWeight: number | undefined
    let emittedStyle: 'italic' | undefined
    for (let f of fontStack) {
      // Per-element v8 literal-wrap unwrap — loop peel for multi-level
      // wraps. Mirror of colorToXgis (921d5ad).
      while (Array.isArray(f) && f.length === 2 && f[0] === 'literal') f = f[1]
      if (typeof f !== 'string' || f.length === 0) continue
      const parsed = parseMapboxFontName(f)
      utils.push(`label-font-${parsed.family.replace(/\s+/g, '-')}`)
      if (emittedWeight === undefined && parsed.weight !== undefined && parsed.weight !== 400) {
        emittedWeight = parsed.weight
      }
      if (emittedStyle === undefined && parsed.style === 'italic') {
        emittedStyle = 'italic'
      }
    }
    if (emittedWeight !== undefined) utils.push(`label-font-weight-${emittedWeight}`)
    // `label-italic` is a boolean-form utility — presence sets the
    // italic flag, absence leaves it normal. We can't reuse the
    // dotted `label-font-style-italic` form because `style` is a
    // reserved xgis keyword (used by the top-level `style { … }`
    // block) and would terminate the utility-name parser mid-token.
    if (emittedStyle !== undefined) utils.push('label-italic')
  }

  // symbol-placement → label-along-path / label-line-center.
  // The runtime walks line geometry and emits one label per feature,
  // anchored at a segment midpoint with rotation matching the local
  // tangent. Roads, waterway names, highway shields all rely on this.
  // (`placement` already pulled above for the text-max-width default
  // gating — Mapbox disables wrap for line placement.)
  if (placement === 'line') utils.push('label-along-path')
  else if (placement === 'line-center') utils.push('label-line-center')
  else if (typeof placement === 'string' && placement !== 'point') {
    // Mapbox spec: symbol-placement must be 'point' | 'line' |
    // 'line-center'. Only flag string values not in the enum.
    warnings.push(`Symbol layer "${layer.id}" — symbol-placement "${placement.slice(0, 40)}" is not a valid enum; expected 'point' | 'line' | 'line-center'.`)
  }

  // text-rotation-alignment / text-pitch-alignment — Mapbox knobs
  // controlling how labels orient relative to map vs viewport. Default
  // 'auto' resolves to viewport for point placement, map for line.
  // Plumb through verbatim so the runtime can pick the right behavior;
  // pitch-alignment: map (text projected onto the ground plane with
  // perspective) is a future runtime task — emit anyway so the IR
  // carries user intent.
  // Both alignment knobs accept the v8 strict `["literal", "<enum>"]`
  // wrapper. Without unwrap the raw === comparison missed every
  // wrapped value — the label fell back to the runtime's auto-default
  // (viewport for point, map for line) even when the style explicitly
  // requested otherwise.
  const rotAlign = unwrapLiteralScalar(layout['text-rotation-alignment'])
  if (rotAlign === 'map' || rotAlign === 'viewport' || rotAlign === 'auto') {
    utils.push(`label-rotation-alignment-${rotAlign}`)
  } else if (typeof rotAlign === 'string') {
    warnings.push(`Symbol layer "${layer.id}" — text-rotation-alignment "${rotAlign.slice(0, 40)}" is not a valid enum; expected 'map' | 'viewport' | 'auto'.`)
  }
  const pitchAlign = unwrapLiteralScalar(layout['text-pitch-alignment'])
  if (pitchAlign === 'map' || pitchAlign === 'viewport' || pitchAlign === 'auto') {
    utils.push(`label-pitch-alignment-${pitchAlign}`)
    // text-pitch-alignment=map projects label glyphs onto the ground
    // plane so they tilt with the camera. Runtime currently renders
    // labels as billboards (viewport-aligned) regardless of this
    // utility; surface the gap explicitly so authors of pitched
    // styles know why their map-aligned labels still look upright.
    // Plan §3.1 deferred — needs text-stage ground projection.
    if (pitchAlign === 'map') {
      warnings.push(`Symbol layer "${layer.id}" — text-pitch-alignment "map" set but runtime renders labels viewport-aligned regardless; ground-projection not yet implemented.`)
    }
  } else if (typeof pitchAlign === 'string') {
    warnings.push(`Symbol layer "${layer.id}" — text-pitch-alignment "${pitchAlign.slice(0, 40)}" is not a valid enum; expected 'map' | 'viewport' | 'auto'.`)
  }

  // symbol-spacing — distance between repeated labels along a line
  // in pixels. Only meaningful for placement: line. Default 250 in
  // Mapbox; emit explicitly when missing so road-name layers don't
  // collapse to a single label per feature.
  const symbolSpacing = unwrapLiteralScalar(layout['symbol-spacing'])
  if (placement === 'line') {
    if (typeof symbolSpacing === 'number' && Number.isFinite(symbolSpacing)) {
      if (symbolSpacing <= 0) {
        warnings.push(`Symbol layer "${layer.id}" — symbol-spacing ${symbolSpacing} is not positive; Mapbox spec requires > 0. Falling back to default 250 px.`)
        utils.push('label-spacing-250')
      } else {
        utils.push(`label-spacing-${symbolSpacing}`)
      }
    } else {
      utils.push('label-spacing-250')
    }
  }

  // What's STILL not converted — surface a precise warning so the
  // user knows which Batch the gap waits on.
  // text-keep-upright — Mapbox default is `true`, meaning glyphs flip
  // 180° on segments whose overall direction would render the label
  // upside-down. The runtime decides per LABEL (not per glyph) using
  // the tangent at the label's centre. Emit only `false` since the
  // runtime defaults to true; saving a utility on every basemap layer.
  const keepUpright = unwrapLiteralScalar(layout['text-keep-upright'])
  if (keepUpright === false) utils.push('label-keep-upright-false')
  else if (keepUpright === true) utils.push('label-keep-upright-true')

  // text-max-angle — max angle (degrees) between adjacent glyphs on a
  // line-placed label (Mapbox default 45). Emit only when authored: an
  // absent value leaves LabelDef.maxAngle undefined so the runtime
  // curved-label path keeps its historical no-clamp behaviour (a style
  // that doesn't set text-max-angle renders byte-identically). A finite
  // value (including the spec default 45) turns on the runtime angular
  // gate. Negative / non-finite ignored.
  const maxAngle = unwrapLiteralScalar(layout['text-max-angle'])
  if (typeof maxAngle === 'number' && Number.isFinite(maxAngle) && maxAngle >= 0) {
    utils.push(`label-max-angle-${maxAngle}`)
  }
}
