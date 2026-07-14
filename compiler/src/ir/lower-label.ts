// ═══ AST → IR Lowering: LABEL / ICON sub-pass ═══
// Pure module-level extraction of the `label-*` / `label-icon-*` lowering
// family from `lowerLayer` (lower.ts). Resolves every label/icon utility
// (constant, zoom-interp, data-driven, VAO) into a `LabelDef | undefined`.
// Same idiom as lower.ts' `applyStyleProperties` / `foldLabelKnobs` — a
// stateless function, explicit params in, fragment out. NOT a context class.
//
// INVARIANT (lower.ts decomposition DO-NOT-SPLIT #5): this runs a SECOND
// utility-loop pass (lowerLayer runs its own pass for paint). The split is
// byte-equivalent ONLY because label items never mutate paint accumulators
// and vice-versa (the two families are disjoint by read-site). The loop here
// visits items in the SAME order as lowerLayer's, so `label-anchor`
// first-seen-wins and `setVao` index accumulation order are preserved. If a
// FUTURE change makes a `label-*` utility also write a paint accumulator (or
// vice-versa), this split BREAKS — ir.test.ts is the guard.

import type * as AST from '../parser/ast'
import { resolveColor } from '../tokens/colors'
import {
  bindingToTextValue,
  bindingAsConstantNumber,
  extractMatchDefaultColor,
  extractInterpolateZoomStops,
  extractInterpolateZoomColorStops,
} from './lower-helpers'
import { type ZoomStop, type Diagnostic, hexToRgba, buildLabelShapes } from './render-node'

/**
 * Resolve a layer's `label-*` / `label-icon-*` utilities into a LabelDef.
 *
 * Runs its OWN loop over `expandedUtilities`, acting ONLY on label/icon
 * items — every non-label item is skipped (paint/animation arms stay in
 * lowerLayer). Returns exactly what `foldLabelKnobs(label, knobs)` produced
 * inline before the extraction.
 *
 * @param diagnostics shared sink for the X-GIS0006 label catch-all
 * @param stmtLine    diagnostic line number (the layer statement line)
 */
export function lowerLabelProps(
  expandedUtilities: AST.UtilityLine[],
  diagnostics: Diagnostic[],
  stmtLine: number,
): import('./render-node').LabelDef | undefined {
  // Per-feature text label. The text comes from `label-[<expr>]`;
  // visual knobs (size, color, halo, anchor, transform) come from
  // sibling `label-*` utilities that fold into the LabelDef when we
  // assemble the RenderNode below. Engine plumbing in Batch 1c.
  let label: import('./render-node').LabelDef | undefined
  let labelSize: number | undefined
  const labelSizeZoomStops: ZoomStop<number>[] = []
  // Mapbox `interpolate_exp` base for the size curve (1 = linear).
  let labelSizeZoomStopsBase: number | undefined
  let labelColor: [number, number, number, number] | undefined
  const labelColorZoomStops: ZoomStop<[number, number, number, number]>[] = []
  let labelColorZoomStopsBase: number | undefined
  let labelColorExpr: import('./render-node').DataExpr | undefined
  let labelSizeExpr: import('./render-node').DataExpr | undefined
  let labelHaloWidth: number | undefined
  const labelHaloWidthZoomStops: ZoomStop<number>[] = []
  let labelHaloWidthZoomStopsBase: number | undefined
  let labelHaloColor: [number, number, number, number] | undefined
  const labelHaloColorZoomStops: ZoomStop<[number, number, number, number]>[] = []
  let labelHaloColorZoomStopsBase: number | undefined
  let labelHaloBlur: number | undefined
  let labelSpacing: number | undefined
  let labelRotationAlignment: 'map' | 'viewport' | 'auto' | undefined
  let labelPitchAlignment: 'map' | 'viewport' | 'auto' | undefined
  let labelKeepUpright: boolean | undefined
  let labelMaxAngle: number | undefined
  let labelSymbolZOrder: 'auto' | 'viewport-y' | 'source' | undefined
  let labelAnchor: import('./render-node').LabelDef['anchor'] | undefined
  // Every label-anchor-X seen, in priority order (Mapbox text-variable-
  // anchor). Runtime tries each on collision; first non-colliding wins.
  const labelAnchorCandidates: NonNullable<import('./render-node').LabelDef['anchorCandidates']> =
    []
  let labelTransform: import('./render-node').LabelDef['transform'] | undefined
  let labelOffsetX: number | undefined
  let labelOffsetY: number | undefined
  let labelTranslateX: number | undefined
  let labelTranslateY: number | undefined
  // Mapbox `text-translate-anchor: map` — world-space (bearing-rotated)
  // text-translate. Default (undefined) = viewport/screen-space.
  let labelTranslateAnchorMap: boolean | undefined
  let labelRadialOffset: number | undefined
  // `text-variable-anchor-offset` em offsets, keyed by pair index;
  // zipped onto the ordered anchor candidates at assembly time.
  const labelVao: Array<[number, number] | undefined> = []
  const setVao = (idx: number, axis: string, n: number): void => {
    const cur = labelVao[idx] ?? [0, 0]
    if (axis === 'x') cur[0] = n
    else if (axis === 'y') cur[1] = n
    labelVao[idx] = cur
  }
  let labelAllowOverlap: boolean | undefined
  let labelIgnorePlacement: boolean | undefined
  let labelPadding: number | undefined
  let labelSortKey: number | undefined
  let labelRotate: number | undefined
  let labelLetterSpacing: number | undefined
  let labelFontStack: string[] | undefined
  let labelFontWeight: number | undefined
  let labelFontStyle: 'normal' | 'italic' | undefined
  let labelMaxWidth: number | undefined
  let labelLineHeight: number | undefined
  let labelJustify: 'auto' | 'left' | 'center' | 'right' | undefined
  let labelPlacement: 'point' | 'line' | 'line-center' | undefined
  // ── Icon (Batch 2) ──
  let labelIconImage: string | undefined
  /** Per-feature icon-image expr from `label-icon-image-[<expr>]`
   *  (Mapbox match/case); runtime picks the sprite key per feature. */
  let labelIconImageExpr: { ast: unknown } | undefined
  let labelIconSize: number | undefined
  // Mapbox `icon-size: interpolate(zoom, …)` — per-frame number, same
  // shape as labelSizeZoomStops (iter 523).
  const labelIconSizeZoomStops: ZoomStop<number>[] = []
  let labelIconSizeZoomStopsBase: number | undefined
  // Mapbox `icon-size: case/match/get` — per-feature expr (#777 I-F);
  // mirrors labelSizeExpr for text-size.
  let labelIconSizeExpr: { ast: unknown } | undefined
  let labelIconAnchor: import('./render-node').LabelDef['iconAnchor'] | undefined
  let labelIconOffset: [number, number] | undefined
  // Mapbox `paint.icon-translate` — viewport CSS-px screen offset on the
  // icon (mirror of icon-offset's accumulator; separate field so a
  // shield + caption style can offset icon vs text independently).
  let labelIconTranslateX: number | undefined
  let labelIconTranslateY: number | undefined
  // Mapbox `icon-translate: case/match/get` — per-feature expr resolving
  // to a [dx,dy] pair (#777 I-F); mirrors labelIconImageExpr's plumbing.
  let labelIconTranslateExpr: { ast: unknown } | undefined
  // Mapbox `icon-translate-anchor: map` — world-space (bearing-rotated)
  // icon-translate. Default (undefined) = viewport/screen-space.
  let labelIconTranslateAnchorMap: boolean | undefined
  let labelIconRotate: number | undefined
  let labelIconOpacity: number | undefined
  // iter 113 — text/icon-opacity PropertyShape accumulators (zoom-interp
  // + data-driven only; constant text-opacity folds into label-color).
  const labelOpacityZoomStops: ZoomStop<number>[] = []
  let labelOpacityZoomStopsBase: number | undefined
  let labelOpacityExpr: { ast: unknown } | undefined
  const labelIconOpacityZoomStops: ZoomStop<number>[] = []
  let labelIconOpacityZoomStopsBase: number | undefined
  let labelIconOpacityExpr: { ast: unknown } | undefined
  // iter 138 — icon-color (SDF sprite tint); mirrors labelColor (static
  // RGBA + optional zoom-interp stops / per-feature expr).
  let labelIconColor: [number, number, number, number] | undefined
  const labelIconColorZoomStops: ZoomStop<[number, number, number, number]>[] = []
  let labelIconColorZoomStopsBase: number | undefined
  let labelIconColorExpr: import('./render-node').DataExpr | undefined
  /** Mapbox `icon-rotation-alignment` — only "map" is carried (icon
   *  rotates with the line tangent); other values stay undefined. */
  let labelIconRotationAlignment: 'map' | undefined
  /** Mapbox `icon-overlap`:'never'/'cooperative' or `icon-allow-overlap`:
   *  false — the icon joins the IconStage collision queue and is dropped
   *  on overlap. Absent = X-GIS' always-place default (Phase S Batch 4). */
  let labelIconCollide: boolean | undefined
  /** Mapbox `icon-ignore-placement`:true — icon places and does not block
   *  others; overrides an explicit collide back to always-place. */
  let labelIconIgnorePlacement: boolean | undefined
  /** Mapbox `icon-optional`:true — a colliding icon may hide while its
   *  paired text still shows (the icon's drop never cascades to text). */
  let labelIconOptional: boolean | undefined
  /** Mapbox `icon-padding` (px) — per-icon collision-box padding (const only). */
  let labelIconPadding: number | undefined
  /** Mapbox `icon-keep-upright` (#777 I-B) — flip a line-placed icon into the
   *  upright half-plane. Explicit-authoring only; undefined = today's default. */
  let labelIconKeepUpright: boolean | undefined
  /** Mapbox `icon-text-fit` (#777 I-A) — stretch the icon quad to the paired
   *  text bbox. undefined = spec default `none` (native sprite size). */
  let labelIconTextFit: 'width' | 'height' | 'both' | undefined
  /** Mapbox `icon-text-fit-padding` [t,r,b,l] (#777 I-A) — per-side padding on
   *  the fitted quad. Accumulated from the per-side `label-icon-text-fit-padding-
   *  {t,r,b,l}-N` utilities; absent sides default 0. */
  let labelIconTextFitPadding: [number, number, number, number] | undefined

  for (const line of expandedUtilities) {
    for (const item of line.items) {
      const name = item.name

      // Modifier items never carry label values; lowerLayer owns them.
      if (item.modifier) continue

      // ── Unmodified items ──
      if (item.binding) {
        const zoomStops = extractInterpolateZoomStops(item.binding)
        if (zoomStops && name === 'label-size') {
          for (const s of zoomStops.stops) labelSizeZoomStops.push({ zoom: s.zoom, value: s.value })
          if (zoomStops.base !== 1) labelSizeZoomStopsBase = zoomStops.base
          continue
        }
        if (zoomStops && name === 'label-icon-size') {
          // Mapbox `icon-size: interpolate(zoom, …)` per-frame resolve
          // (iter 523). Clamp negatives to 0.
          for (const s of zoomStops.stops)
            labelIconSizeZoomStops.push({ zoom: s.zoom, value: Math.max(0, s.value) })
          if (zoomStops.base !== 1) labelIconSizeZoomStopsBase = zoomStops.base
          continue
        }
        if (zoomStops && name === 'label-opacity') {
          // Mapbox `text-opacity: interpolate(zoom, …)` — non-constant
          // alpha multiplier; resolved per frame (iter 113).
          for (const s of zoomStops.stops) {
            labelOpacityZoomStops.push({
              zoom: s.zoom,
              value: Math.max(0, Math.min(1, s.value)),
            })
          }
          if (zoomStops.base !== 1) labelOpacityZoomStopsBase = zoomStops.base
          continue
        }
        if (zoomStops && name === 'label-icon-opacity') {
          // Mapbox `icon-opacity: interpolate(zoom, …)` (iter 113).
          for (const s of zoomStops.stops) {
            labelIconOpacityZoomStops.push({
              zoom: s.zoom,
              value: Math.max(0, Math.min(1, s.value)),
            })
          }
          if (zoomStops.base !== 1) labelIconOpacityZoomStopsBase = zoomStops.base
          continue
        }
        if (!zoomStops && name === 'label-opacity') {
          // Data-driven text-opacity (case / match / get) — iter 113.
          labelOpacityExpr = { ast: item.binding }
          continue
        }
        if (!zoomStops && name === 'label-icon-opacity') {
          labelIconOpacityExpr = { ast: item.binding }
          continue
        }
        // Data-driven icon-size (case / match / get) → per-feature expr
        // (#777 I-F); the zoom-interp form was consumed by the label-icon
        // -size zoomStops arm above.
        if (!zoomStops && name === 'label-icon-size') {
          labelIconSizeExpr = { ast: item.binding }
          continue
        }
        // Non-constant icon-translate expr → per-feature [dx,dy] pair
        // (#777 I-F). Distinct name from the constant label-icon-translate
        // -{x,y}-N arms; captured whole for the runtime evaluate.
        if (name === 'label-icon-translate') {
          labelIconTranslateExpr = { ast: item.binding }
          continue
        }
        // Non-zoom-interp label-size binding → per-feature evaluation
        // (Mapbox `text-size: case/match/arithmetic`).
        if (name === 'label-size' && !zoomStops) {
          labelSizeExpr = { ast: item.binding }
          continue
        }
        // label-halo zoom-interpolated width; last stop seeds the
        // static `halo.width` fallback.
        if (zoomStops && name === 'label-halo') {
          for (const s of zoomStops.stops)
            labelHaloWidthZoomStops.push({ zoom: s.zoom, value: s.value })
          if (zoomStops.base !== 1) labelHaloWidthZoomStopsBase = zoomStops.base
          labelHaloWidth = zoomStops.stops[zoomStops.stops.length - 1]!.value
          continue
        }
        // label-color zoom-interpolated colour (full RGBA stops);
        // last stop seeds the static `color` fallback.
        if (name === 'label-color') {
          const interp = extractInterpolateZoomColorStops(item.binding)
          if (interp) {
            for (const s of interp.stops) {
              const hex = resolveColor(s.value)
              if (hex) labelColorZoomStops.push({ zoom: s.zoom, value: hexToRgba(hex) })
            }
            if (labelColorZoomStops.length > 0) {
              if (interp.base !== 1) labelColorZoomStopsBase = interp.base
              labelColor = labelColorZoomStops[labelColorZoomStops.length - 1]!.value
              continue
            }
          }
          // Non-zoom-interp colour binding → per-feature expression
          // (Mapbox `text-color: case/match`).
          labelColorExpr = { ast: item.binding }
          continue
        }
        // icon-color zoom-interp / per-feature binding (iter 138) —
        // mirror of the label-color arm above.
        if (name === 'label-icon-color') {
          const interp = extractInterpolateZoomColorStops(item.binding)
          if (interp) {
            for (const s of interp.stops) {
              const hex = resolveColor(s.value)
              if (hex) labelIconColorZoomStops.push({ zoom: s.zoom, value: hexToRgba(hex) })
            }
            if (labelIconColorZoomStops.length > 0) {
              if (interp.base !== 1) labelIconColorZoomStopsBase = interp.base
              labelIconColor = labelIconColorZoomStops[labelIconColorZoomStops.length - 1]!.value
              continue
            }
          }
          labelIconColorExpr = { ast: item.binding }
          continue
        }
        if (name === 'label-halo-color') {
          const interp = extractInterpolateZoomColorStops(item.binding)
          if (interp) {
            for (const s of interp.stops) {
              const hex = resolveColor(s.value)
              if (hex) labelHaloColorZoomStops.push({ zoom: s.zoom, value: hexToRgba(hex) })
            }
            if (labelHaloColorZoomStops.length > 0) {
              if (interp.base !== 1) labelHaloColorZoomStopsBase = interp.base
              labelHaloColor = labelHaloColorZoomStops[labelHaloColorZoomStops.length - 1]!.value
              continue
            }
          }
          // Per-feature `match(.field) { …, _ -> #default }` — bake the
          // default arm as the static halo-colour fallback (LabelDef has
          // no per-feature haloColorExpr field yet).
          const defaultHex = extractMatchDefaultColor(item.binding)
          if (defaultHex) {
            const rgba = hexToRgba(defaultHex)
            labelHaloColor = [rgba[0], rgba[1], rgba[2], rgba[3]]
            continue
          }
        }
        if (name === 'label') {
          // `label-[<expr>]` — per-feature text content. 12-px size seed
          // is a default; later `label-size-N` overrides it.
          label = { text: bindingToTextValue(item.binding), size: 12 }
          continue
        }
        if (name === 'label-icon-image') {
          // `label-icon-image-[<expr>]` — per-feature icon sprite key.
          labelIconImageExpr = { ast: item.binding }
          continue
        }
        // Numeric label-* utilities that allow negatives use bracket-
        // binding form (`label-offset-y-[-0.2]`); only literal-number
        // (or unary-minus literal) bindings are accepted here.
        const n = bindingAsConstantNumber(item.binding)
        if (n !== null) {
          if (name === 'label-offset-x') {
            labelOffsetX = n
            continue
          }
          if (name === 'label-offset-y') {
            labelOffsetY = n
            continue
          }
          if (name === 'label-translate-x') {
            labelTranslateX = n
            continue
          }
          if (name === 'label-translate-y') {
            labelTranslateY = n
            continue
          }
          if (name === 'label-radial-offset') {
            labelRadialOffset = n
            continue
          }
          if (name.startsWith('label-vao-')) {
            // `label-vao-<idx>-<x|y>` bracket form (negative em).
            const m = /^label-vao-(\d+)-([xy])$/.exec(name)
            if (m) {
              setVao(parseInt(m[1]!, 10), m[2]!, n)
              continue
            }
          }
          if (name === 'label-rotate') {
            labelRotate = n
            continue
          }
          if (name === 'label-letter-spacing') {
            labelLetterSpacing = n
            continue
          }
          if (name === 'label-padding') {
            labelPadding = n
            continue
          }
          if (name === 'label-sort-key') {
            labelSortKey = n
            continue
          }
          // Bracket-binding form for negative icon-offset components.
          if (name === 'label-icon-offset-x') {
            labelIconOffset = [n, labelIconOffset?.[1] ?? 0]
            continue
          }
          if (name === 'label-icon-offset-y') {
            labelIconOffset = [labelIconOffset?.[0] ?? 0, n]
            continue
          }
          // Bracket-binding form for negative icon-translate components.
          if (name === 'label-icon-translate-x') {
            labelIconTranslateX = n
            continue
          }
          if (name === 'label-icon-translate-y') {
            labelIconTranslateY = n
            continue
          }
          if (name === 'label-icon-rotate') {
            labelIconRotate = n
            continue
          }
          if (name === 'label-icon-size') {
            labelIconSize = n
            continue
          }
        }
        // Non-label binding items (fill / stroke / size / opacity /
        // fill-extrusion / fill-translate / unhandled non-label bracket
        // bindings) are owned by lowerLayer — skip them here.
        if (!name.startsWith('label-')) continue
        // A `label-*` / `label-icon-*` bracket-binding that reached here
        // had NO handler arm above (and is not a recognised negative-
        // numeric label utility). Pre-decomposition this same case fell
        // through lowerLayer's `else` block and surfaced as X-GIS0005;
        // preserve that exactly so an unhandled label binding still fails
        // CI instead of silently dropping. (lowerLayer skips every
        // `label-*` binding, so this is the sole emitter for them.)
        diagnostics.push({
          severity: 'warn',
          code: 'X-GIS0005',
          line: stmtLine,
          message:
            `Bracket-binding utility "${name}-[…]" has no handler in lower.ts — ` +
            `the expression is being dropped. Add a name==="${name}" arm in the ` +
            `binding-form handler to thread the value into the appropriate IR field.`,
        })
        continue
      }

      // ── label-* visual knob utilities (Batch 1c-8g) — stored in
      //    locals until foldLabelKnobs assembly at the bottom.
      if (name === 'label-uppercase') {
        labelTransform = 'uppercase'
        continue
      }
      if (name === 'label-lowercase') {
        labelTransform = 'lowercase'
        continue
      }
      if (name === 'label-none') {
        labelTransform = 'none'
        continue
      }
      if (name === 'label-allow-overlap') {
        labelAllowOverlap = true
        continue
      }
      if (name === 'label-ignore-placement') {
        labelIgnorePlacement = true
        continue
      }
      if (name === 'label-icon-collide') {
        labelIconCollide = true
        continue
      }
      if (name === 'label-icon-ignore-placement') {
        labelIconIgnorePlacement = true
        continue
      }
      if (name === 'label-icon-optional') {
        labelIconOptional = true
        continue
      }
      if (name === 'label-icon-keep-upright') {
        labelIconKeepUpright = true
        continue
      }
      if (name === 'label-icon-keep-upright-false') {
        labelIconKeepUpright = false
        continue
      }
      // Mapbox `symbol-placement: line | line-center` — labels follow
      // line geometry instead of anchoring at a point. Runtime walks
      // the line's segments and emits a label per feature with rotation
      // matching the local tangent.
      if (name === 'label-along-path') {
        labelPlacement = 'line'
        continue
      }
      if (name === 'label-line-center') {
        labelPlacement = 'line-center'
        continue
      }
      if (name === 'label-translate-anchor-map') {
        labelTranslateAnchorMap = true
        continue
      }
      if (name === 'label-icon-translate-anchor-map') {
        labelIconTranslateAnchorMap = true
        continue
      }
      if (name === 'label-rotation-alignment-map') {
        labelRotationAlignment = 'map'
        continue
      }
      if (name === 'label-rotation-alignment-viewport') {
        labelRotationAlignment = 'viewport'
        continue
      }
      if (name === 'label-rotation-alignment-auto') {
        labelRotationAlignment = 'auto'
        continue
      }
      if (name === 'label-pitch-alignment-map') {
        labelPitchAlignment = 'map'
        continue
      }
      if (name === 'label-pitch-alignment-viewport') {
        labelPitchAlignment = 'viewport'
        continue
      }
      if (name === 'label-pitch-alignment-auto') {
        labelPitchAlignment = 'auto'
        continue
      }
      if (name === 'label-keep-upright-true') {
        labelKeepUpright = true
        continue
      }
      if (name === 'label-keep-upright-false') {
        labelKeepUpright = false
        continue
      }
      if (name === 'label-z-order-auto') {
        labelSymbolZOrder = 'auto'
        continue
      }
      if (name === 'label-z-order-viewport-y') {
        labelSymbolZOrder = 'viewport-y'
        continue
      }
      if (name === 'label-z-order-source') {
        labelSymbolZOrder = 'source'
        continue
      }
      if (name.startsWith('label-max-angle-')) {
        const num = parseFloat(name.slice('label-max-angle-'.length))
        if (!isNaN(num)) labelMaxAngle = num
        continue
      }
      if (name === 'label-justify-auto') {
        labelJustify = 'auto'
        continue
      }
      if (name === 'label-justify-left') {
        labelJustify = 'left'
        continue
      }
      if (name === 'label-justify-center') {
        labelJustify = 'center'
        continue
      }
      if (name === 'label-justify-right') {
        labelJustify = 'right'
        continue
      }
      if (name.startsWith('label-anchor-')) {
        const a = name.slice('label-anchor-'.length)
        const valid = [
          'center',
          'top',
          'bottom',
          'left',
          'right',
          'top-left',
          'top-right',
          'bottom-left',
          'bottom-right',
        ] as const
        if ((valid as readonly string[]).includes(a)) {
          // First-seen wins for the static `anchor`; later siblings
          // become collision-fallback candidates. Avoid duplicates so
          // an accidental `label-anchor-top label-anchor-top` doesn't
          // bloat the candidate list.
          if (labelAnchor === undefined) labelAnchor = a as (typeof valid)[number]
          if (!labelAnchorCandidates.includes(a as (typeof valid)[number])) {
            labelAnchorCandidates.push(a as (typeof valid)[number])
          }
          continue
        }
      }
      if (name.startsWith('label-size-')) {
        const num = parseFloat(name.slice('label-size-'.length))
        if (!isNaN(num)) labelSize = num
        continue
      }
      if (name.startsWith('label-halo-color-')) {
        const hex = resolveColor(name.slice('label-halo-color-'.length))
        if (hex) labelHaloColor = hexToRgba(hex)
        continue
      }
      if (name.startsWith('label-halo-blur-')) {
        const num = parseFloat(name.slice('label-halo-blur-'.length))
        if (!isNaN(num)) labelHaloBlur = num
        continue
      }
      if (name.startsWith('label-halo-')) {
        const num = parseFloat(name.slice('label-halo-'.length))
        if (!isNaN(num)) labelHaloWidth = num
        continue
      }
      if (name.startsWith('label-icon-color-')) {
        const hex = resolveColor(name.slice('label-icon-color-'.length))
        if (hex) labelIconColor = hexToRgba(hex)
        continue
      }
      if (name.startsWith('label-color-')) {
        const hex = resolveColor(name.slice('label-color-'.length))
        if (hex) labelColor = hexToRgba(hex)
        continue
      }
      if (name.startsWith('label-offset-x-')) {
        const num = parseFloat(name.slice('label-offset-x-'.length))
        if (!isNaN(num)) labelOffsetX = num
        continue
      }
      if (name.startsWith('label-offset-y-')) {
        const num = parseFloat(name.slice('label-offset-y-'.length))
        if (!isNaN(num)) labelOffsetY = num
        continue
      }
      if (name.startsWith('label-translate-x-')) {
        const num = parseFloat(name.slice('label-translate-x-'.length))
        if (!isNaN(num)) labelTranslateX = num
        continue
      }
      if (name.startsWith('label-translate-y-')) {
        const num = parseFloat(name.slice('label-translate-y-'.length))
        if (!isNaN(num)) labelTranslateY = num
        continue
      }
      if (name.startsWith('label-padding-')) {
        const num = parseFloat(name.slice('label-padding-'.length))
        if (!isNaN(num)) labelPadding = num
        continue
      }
      if (name.startsWith('label-sort-key-')) {
        const num = parseFloat(name.slice('label-sort-key-'.length))
        if (!isNaN(num) && Number.isFinite(num)) labelSortKey = num
        continue
      }
      if (name.startsWith('label-radial-offset-')) {
        const num = parseFloat(name.slice('label-radial-offset-'.length))
        if (!isNaN(num)) labelRadialOffset = num
        continue
      }
      if (name.startsWith('label-vao-')) {
        // `label-vao-<idx>-<x|y>-<n>` (positive em; negatives use the
        // bracket-binding form handled above).
        const m = /^label-vao-(\d+)-([xy])-(.+)$/.exec(name)
        if (m) {
          const num = parseFloat(m[3]!)
          if (!isNaN(num)) setVao(parseInt(m[1]!, 10), m[2]!, num)
        }
        continue
      }
      if (name.startsWith('label-rotate-')) {
        const num = parseFloat(name.slice('label-rotate-'.length))
        if (!isNaN(num)) labelRotate = num
        continue
      }
      if (name.startsWith('label-letter-spacing-')) {
        const num = parseFloat(name.slice('label-letter-spacing-'.length))
        if (!isNaN(num)) labelLetterSpacing = num
        continue
      }
      if (name.startsWith('label-max-width-')) {
        const num = parseFloat(name.slice('label-max-width-'.length))
        if (!isNaN(num)) labelMaxWidth = num
        continue
      }
      if (name.startsWith('label-line-height-')) {
        const num = parseFloat(name.slice('label-line-height-'.length))
        if (!isNaN(num)) labelLineHeight = num
        continue
      }
      // ── Icon (Batch 2 — sprite atlas) ──
      // Mapbox `icon-image` constant string; raw atlas key resolved by
      // IconStage at draw.
      if (name.startsWith('label-icon-image-')) {
        labelIconImage = name.slice('label-icon-image-'.length)
        continue
      }
      if (name.startsWith('label-icon-size-')) {
        const num = parseFloat(name.slice('label-icon-size-'.length))
        if (!isNaN(num)) labelIconSize = num
        continue
      }
      if (name.startsWith('label-icon-padding-')) {
        const num = parseFloat(name.slice('label-icon-padding-'.length))
        if (!isNaN(num)) labelIconPadding = num
        continue
      }
      if (name.startsWith('label-icon-anchor-')) {
        const a = name.slice('label-icon-anchor-'.length)
        const valid = [
          'center',
          'top',
          'bottom',
          'left',
          'right',
          'top-left',
          'top-right',
          'bottom-left',
          'bottom-right',
        ] as const
        if ((valid as readonly string[]).includes(a)) {
          labelIconAnchor = a as (typeof valid)[number]
        }
        continue
      }
      if (name.startsWith('label-icon-offset-x-')) {
        const num = parseFloat(name.slice('label-icon-offset-x-'.length))
        if (!isNaN(num)) labelIconOffset = [num, labelIconOffset?.[1] ?? 0]
        continue
      }
      if (name.startsWith('label-icon-offset-y-')) {
        const num = parseFloat(name.slice('label-icon-offset-y-'.length))
        if (!isNaN(num)) labelIconOffset = [labelIconOffset?.[0] ?? 0, num]
        continue
      }
      if (name.startsWith('label-icon-translate-x-')) {
        const num = parseFloat(name.slice('label-icon-translate-x-'.length))
        if (!isNaN(num)) labelIconTranslateX = num
        continue
      }
      if (name.startsWith('label-icon-translate-y-')) {
        const num = parseFloat(name.slice('label-icon-translate-y-'.length))
        if (!isNaN(num)) labelIconTranslateY = num
        continue
      }
      if (name.startsWith('label-icon-rotate-')) {
        const num = parseFloat(name.slice('label-icon-rotate-'.length))
        if (!isNaN(num)) labelIconRotate = num
        continue
      }
      if (name.startsWith('label-icon-opacity-')) {
        const num = parseFloat(name.slice('label-icon-opacity-'.length))
        if (!isNaN(num)) labelIconOpacity = Math.max(0, Math.min(1, num))
        continue
      }
      if (name === 'label-icon-rotation-alignment-map') {
        labelIconRotationAlignment = 'map'
        continue
      }
      // #777 I-A — icon-text-fit-padding per-side accumulator. Matched BEFORE
      // the icon-text-fit enum below so `…-padding-t-3` is not mis-read as an
      // enum value. `-` splits the utility grammar (no comma tuples, the
      // icon-offset precedent), so each side is its own utility; absent sides
      // default 0. Side segment (t/r/b/l) then the numeric value.
      if (name.startsWith('label-icon-text-fit-padding-')) {
        const rest = name.slice('label-icon-text-fit-padding-'.length)
        const dash = rest.indexOf('-')
        const idx = dash > 0 ? { t: 0, r: 1, b: 2, l: 3 }[rest.slice(0, dash)] : undefined
        const num = dash > 0 ? parseFloat(rest.slice(dash + 1)) : NaN
        if (idx !== undefined && !isNaN(num)) {
          const p = labelIconTextFitPadding ?? [0, 0, 0, 0]
          p[idx] = num
          labelIconTextFitPadding = p
        }
        continue
      }
      // #777 I-A — icon-text-fit enum. Exact-match (width/height/both); `none`
      // never emits (spec default = native sprite size, byte-identical).
      if (
        name === 'label-icon-text-fit-width' ||
        name === 'label-icon-text-fit-height' ||
        name === 'label-icon-text-fit-both'
      ) {
        labelIconTextFit = name.slice('label-icon-text-fit-'.length) as 'width' | 'height' | 'both'
        continue
      }
      if (name.startsWith('label-spacing-')) {
        const num = parseFloat(name.slice('label-spacing-'.length))
        if (!isNaN(num)) labelSpacing = num
        continue
      }
      if (name.startsWith('label-font-weight-')) {
        // Numeric CSS weight (100..900); converter normalises Mapbox
        // word suffixes ("Bold" → 700, etc.).
        const num = parseFloat(name.slice('label-font-weight-'.length))
        if (!isNaN(num)) labelFontWeight = num
        continue
      }
      if (name === 'label-italic') {
        // Boolean utility — presence sets italic (CSS style prefix).
        labelFontStyle = 'italic'
        continue
      }
      if (name.startsWith('label-font-')) {
        // Each `label-font-X` utility APPENDS one font to the fallback
        // stack; spaces round-trip via `-`. The whole stack feeds
        // ctx.font for browser glyph-by-glyph fallback.
        const raw = name.slice('label-font-'.length)
        const restored = raw.replace(/-/g, ' ')
        if (restored.length > 0) {
          if (!labelFontStack) labelFontStack = []
          labelFontStack.push(restored)
        }
        continue
      }

      // Catch-all for unrecognised constant `label-*` utilities (mirror
      // of the bracket-binding X-GIS0005 guard). Anything reaching here
      // had NO arm above and would silently drop — surface as a warn so
      // a converter/lower mismatch fails CI (the text-variable-anchor
      // regression class). Malformed `label-anchor-<x>` also lands here.
      if (name.startsWith('label-')) {
        diagnostics.push({
          severity: 'warn',
          code: 'X-GIS0006',
          line: stmtLine,
          message:
            `Label utility "${name}" has no handler in lower.ts — the ` +
            `value is being dropped. Add a matching arm in the label-` +
            `utility parser so the converter's emission threads into ` +
            `LabelDef.`,
        })
        continue
      }
      // Non-label constant items (fill / stroke / opacity / size /
      // projection / animation / etc.) are handled by lowerLayer.
    }
  }

  // Mapbox `text-variable-anchor-offset`: zip the i-th emitted anchor
  // candidate with the i-th `label-vao-*` offset pair. Only built when
  // the converter actually emitted vao pairs — plain text-variable-
  // anchor / text-radial-offset leave this undefined and the runtime
  // falls back to the radial / text-offset path.
  const labelVariableAnchorOffset =
    labelVao.length > 0
      ? labelAnchorCandidates
          .slice(0, labelVao.length)
          .map((a, i) => [a, labelVao[i] ?? [0, 0]] as [typeof a, [number, number]])
      : undefined

  return foldLabelKnobs(label, {
    labelSize,
    labelColor,
    labelHaloWidth,
    labelHaloColor,
    labelHaloBlur,
    labelAnchor,
    labelTransform,
    labelOffsetX,
    labelOffsetY,
    labelTranslateX,
    labelTranslateY,
    labelTranslateAnchorMap,
    labelRadialOffset,
    labelVariableAnchorOffset,
    labelSizeZoomStops: labelSizeZoomStops.length > 0 ? labelSizeZoomStops : undefined,
    labelSizeZoomStopsBase,
    labelColorZoomStops: labelColorZoomStops.length > 0 ? labelColorZoomStops : undefined,
    labelColorZoomStopsBase,
    labelColorExpr,
    labelSizeExpr,
    labelAnchorCandidates: labelAnchorCandidates.length > 1 ? labelAnchorCandidates : undefined,
    labelHaloWidthZoomStops:
      labelHaloWidthZoomStops.length > 0 ? labelHaloWidthZoomStops : undefined,
    labelHaloWidthZoomStopsBase,
    labelHaloColorZoomStops:
      labelHaloColorZoomStops.length > 0 ? labelHaloColorZoomStops : undefined,
    labelHaloColorZoomStopsBase,
    labelAllowOverlap,
    labelIgnorePlacement,
    labelPadding,
    labelSortKey,
    labelRotate,
    labelLetterSpacing,
    labelFontStack,
    labelFontWeight,
    labelFontStyle,
    labelMaxWidth,
    labelLineHeight,
    labelJustify,
    labelPlacement,
    labelSpacing,
    labelRotationAlignment,
    labelPitchAlignment,
    labelKeepUpright,
    labelMaxAngle,
    labelSymbolZOrder,
    labelIconImage,
    labelIconImageExpr,
    labelIconSize,
    labelIconAnchor,
    labelIconOffset,
    labelIconTranslateX,
    labelIconTranslateY,
    labelIconTranslateExpr,
    labelIconTranslateAnchorMap,
    labelIconRotate,
    labelIconOpacity,
    labelIconRotationAlignment,
    labelIconCollide,
    labelIconIgnorePlacement,
    labelIconOptional,
    labelIconPadding,
    labelIconKeepUpright,
    labelIconTextFit,
    labelIconTextFitPadding,
    labelIconSizeZoomStops: labelIconSizeZoomStops.length > 0 ? labelIconSizeZoomStops : undefined,
    labelIconSizeZoomStopsBase,
    labelIconSizeExpr,
    labelOpacityZoomStops: labelOpacityZoomStops.length > 0 ? labelOpacityZoomStops : undefined,
    labelOpacityZoomStopsBase,
    labelOpacityExpr,
    labelIconOpacityZoomStops:
      labelIconOpacityZoomStops.length > 0 ? labelIconOpacityZoomStops : undefined,
    labelIconOpacityZoomStopsBase,
    labelIconOpacityExpr,
    labelIconColor,
    labelIconColorZoomStops:
      labelIconColorZoomStops.length > 0 ? labelIconColorZoomStops : undefined,
    labelIconColorZoomStopsBase,
    labelIconColorExpr,
  })
}

/** Merge sibling `label-*` utility values into the LabelDef built
 *  from `label-[<expr>]`. Returns the input unchanged when no knobs
 *  are present (covers the common one-utility-only case). When knobs
 *  exist but the layer has no `label-[<expr>]`, returns undefined —
 *  visual knobs without a text source produce no rendering and the
 *  warning is the user's responsibility (the converter surfaces it). */
function foldLabelKnobs(
  base: import('./render-node').LabelDef | undefined,
  knobs: {
    labelSize?: number
    labelColor?: [number, number, number, number]
    labelHaloWidth?: number
    labelHaloColor?: [number, number, number, number]
    labelHaloBlur?: number
    labelAnchor?: import('./render-node').LabelDef['anchor']
    labelAnchorCandidates?: import('./render-node').LabelDef['anchorCandidates']
    labelTransform?: import('./render-node').LabelDef['transform']
    labelOffsetX?: number
    labelOffsetY?: number
    labelTranslateX?: number
    labelTranslateY?: number
    labelTranslateAnchorMap?: boolean
    labelRadialOffset?: number
    labelVariableAnchorOffset?: import('./render-node').LabelDef['variableAnchorOffset']
    labelSizeZoomStops?: ZoomStop<number>[]
    /** Mapbox `["exponential", N]` curve base for the size stops.
     *  Undefined / 1 → linear; >1 → faster growth at higher zooms. */
    labelSizeZoomStopsBase?: number
    labelColorZoomStops?: ZoomStop<[number, number, number, number]>[]
    labelColorZoomStopsBase?: number
    labelColorExpr?: import('./render-node').DataExpr
    labelSizeExpr?: import('./render-node').DataExpr
    labelHaloWidthZoomStops?: ZoomStop<number>[]
    labelHaloWidthZoomStopsBase?: number
    labelHaloColorZoomStops?: ZoomStop<[number, number, number, number]>[]
    labelHaloColorZoomStopsBase?: number
    labelAllowOverlap?: boolean
    labelIgnorePlacement?: boolean
    labelPadding?: number
    labelSortKey?: number
    labelRotate?: number
    labelLetterSpacing?: number
    labelFontStack?: string[]
    labelFontWeight?: number
    labelFontStyle?: 'normal' | 'italic'
    labelMaxWidth?: number
    labelLineHeight?: number
    labelJustify?: 'auto' | 'left' | 'center' | 'right'
    labelPlacement?: 'point' | 'line' | 'line-center'
    labelSpacing?: number
    labelRotationAlignment?: 'map' | 'viewport' | 'auto'
    labelPitchAlignment?: 'map' | 'viewport' | 'auto'
    labelKeepUpright?: boolean
    labelMaxAngle?: number
    labelSymbolZOrder?: 'auto' | 'viewport-y' | 'source'
    labelIconImage?: string
    labelIconImageExpr?: { ast: unknown }
    labelIconSize?: number
    labelIconSizeZoomStops?: ZoomStop<number>[]
    labelIconSizeZoomStopsBase?: number
    labelIconSizeExpr?: { ast: unknown }
    labelIconAnchor?: import('./render-node').LabelDef['iconAnchor']
    labelIconOffset?: [number, number]
    labelIconTranslateX?: number
    labelIconTranslateY?: number
    labelIconTranslateExpr?: { ast: unknown }
    labelIconTranslateAnchorMap?: boolean
    labelIconRotate?: number
    labelIconOpacity?: number
    labelIconRotationAlignment?: 'map'
    labelIconCollide?: boolean
    labelIconIgnorePlacement?: boolean
    labelIconOptional?: boolean
    labelIconPadding?: number
    labelIconKeepUpright?: boolean
    labelIconTextFit?: 'width' | 'height' | 'both'
    labelIconTextFitPadding?: [number, number, number, number]
    // iter 113 — opacity PropertyShape inputs (zoom-interp + expr).
    labelOpacityZoomStops?: ZoomStop<number>[]
    labelOpacityZoomStopsBase?: number
    labelOpacityExpr?: { ast: unknown }
    labelIconOpacityZoomStops?: ZoomStop<number>[]
    labelIconOpacityZoomStopsBase?: number
    labelIconOpacityExpr?: { ast: unknown }
    // iter 138 — icon-color (SDF tint) PropertyShape inputs.
    labelIconColor?: [number, number, number, number]
    labelIconColorZoomStops?: ZoomStop<[number, number, number, number]>[]
    labelIconColorZoomStopsBase?: number
    labelIconColorExpr?: import('./render-node').DataExpr
  },
): import('./render-node').LabelDef | undefined {
  if (!base) return undefined
  let halo = base.halo
  if (
    knobs.labelHaloWidth !== undefined ||
    knobs.labelHaloColor !== undefined ||
    knobs.labelHaloBlur !== undefined
  ) {
    const resolvedBlur = knobs.labelHaloBlur ?? base.halo?.blur
    halo = {
      // Mapbox `text-halo-color` default is transparent black (no visible
      // halo); `text-halo-width` default is 0 (shader gates on > 0).
      color: knobs.labelHaloColor ?? base.halo?.color ?? [0, 0, 0, 0],
      width: knobs.labelHaloWidth ?? base.halo?.width ?? 0,
      ...(resolvedBlur !== undefined ? { blur: resolvedBlur } : {}),
    }
  }
  let offset = base.offset
  if (knobs.labelOffsetX !== undefined || knobs.labelOffsetY !== undefined) {
    offset = [
      knobs.labelOffsetX ?? base.offset?.[0] ?? 0,
      knobs.labelOffsetY ?? base.offset?.[1] ?? 0,
    ]
  }
  let translate = base.translate
  if (knobs.labelTranslateX !== undefined || knobs.labelTranslateY !== undefined) {
    translate = [
      knobs.labelTranslateX ?? base.translate?.[0] ?? 0,
      knobs.labelTranslateY ?? base.translate?.[1] ?? 0,
    ]
  }
  const merged: import('./render-node').LabelDef = {
    ...base,
    ...(knobs.labelSize !== undefined ? { size: knobs.labelSize } : {}),
    ...(knobs.labelColor !== undefined ? { color: knobs.labelColor } : {}),
    ...(halo !== undefined ? { halo } : {}),
    ...(knobs.labelAnchor !== undefined ? { anchor: knobs.labelAnchor } : {}),
    ...(knobs.labelAnchorCandidates !== undefined
      ? { anchorCandidates: knobs.labelAnchorCandidates }
      : {}),
    ...(knobs.labelTransform !== undefined ? { transform: knobs.labelTransform } : {}),
    ...(offset !== undefined ? { offset } : {}),
    ...(translate !== undefined ? { translate } : {}),
    ...(knobs.labelTranslateAnchorMap !== undefined
      ? { translateAnchorMap: knobs.labelTranslateAnchorMap }
      : {}),
    ...(knobs.labelRadialOffset !== undefined ? { radialOffset: knobs.labelRadialOffset } : {}),
    ...(knobs.labelVariableAnchorOffset !== undefined && knobs.labelVariableAnchorOffset.length > 0
      ? { variableAnchorOffset: knobs.labelVariableAnchorOffset }
      : {}),
    ...(knobs.labelAllowOverlap !== undefined ? { allowOverlap: knobs.labelAllowOverlap } : {}),
    ...(knobs.labelIgnorePlacement !== undefined
      ? { ignorePlacement: knobs.labelIgnorePlacement }
      : {}),
    ...(knobs.labelPadding !== undefined ? { padding: knobs.labelPadding } : {}),
    ...(knobs.labelSortKey !== undefined ? { sortKey: knobs.labelSortKey } : {}),
    ...(knobs.labelRotate !== undefined ? { rotate: knobs.labelRotate } : {}),
    ...(knobs.labelLetterSpacing !== undefined ? { letterSpacing: knobs.labelLetterSpacing } : {}),
    ...(knobs.labelFontStack !== undefined && knobs.labelFontStack.length > 0
      ? { font: knobs.labelFontStack }
      : {}),
    ...(knobs.labelFontWeight !== undefined ? { fontWeight: knobs.labelFontWeight } : {}),
    ...(knobs.labelFontStyle !== undefined ? { fontStyle: knobs.labelFontStyle } : {}),
    ...(knobs.labelMaxWidth !== undefined ? { maxWidth: knobs.labelMaxWidth } : {}),
    ...(knobs.labelLineHeight !== undefined ? { lineHeight: knobs.labelLineHeight } : {}),
    ...(knobs.labelJustify !== undefined ? { justify: knobs.labelJustify } : {}),
    ...(knobs.labelPlacement !== undefined ? { placement: knobs.labelPlacement } : {}),
    ...(knobs.labelSpacing !== undefined ? { spacing: knobs.labelSpacing } : {}),
    ...(knobs.labelRotationAlignment !== undefined
      ? { rotationAlignment: knobs.labelRotationAlignment }
      : {}),
    ...(knobs.labelPitchAlignment !== undefined
      ? { pitchAlignment: knobs.labelPitchAlignment }
      : {}),
    ...(knobs.labelKeepUpright !== undefined ? { keepUpright: knobs.labelKeepUpright } : {}),
    ...(knobs.labelMaxAngle !== undefined ? { maxAngle: knobs.labelMaxAngle } : {}),
    ...(knobs.labelSymbolZOrder !== undefined ? { symbolZOrder: knobs.labelSymbolZOrder } : {}),
    // Batch 2 — sprite icon fields
    ...(knobs.labelIconImage !== undefined ? { iconImage: knobs.labelIconImage } : {}),
    ...(knobs.labelIconImageExpr !== undefined ? { iconImageExpr: knobs.labelIconImageExpr } : {}),
    ...(knobs.labelIconSize !== undefined ? { iconSize: knobs.labelIconSize } : {}),
    ...(knobs.labelIconAnchor !== undefined ? { iconAnchor: knobs.labelIconAnchor } : {}),
    ...(knobs.labelIconOffset !== undefined ? { iconOffset: knobs.labelIconOffset } : {}),
    ...(knobs.labelIconTranslateX !== undefined
      ? { iconTranslateX: knobs.labelIconTranslateX }
      : {}),
    ...(knobs.labelIconTranslateY !== undefined
      ? { iconTranslateY: knobs.labelIconTranslateY }
      : {}),
    ...(knobs.labelIconTranslateExpr !== undefined
      ? { iconTranslateExpr: knobs.labelIconTranslateExpr }
      : {}),
    ...(knobs.labelIconTranslateAnchorMap !== undefined
      ? { iconTranslateAnchorMap: knobs.labelIconTranslateAnchorMap }
      : {}),
    ...(knobs.labelIconRotate !== undefined ? { iconRotate: knobs.labelIconRotate } : {}),
    ...(knobs.labelIconOpacity !== undefined ? { iconOpacity: knobs.labelIconOpacity } : {}),
    ...(knobs.labelIconColor !== undefined ? { iconColor: knobs.labelIconColor } : {}),
    ...(knobs.labelIconRotationAlignment !== undefined
      ? { iconRotationAlignment: knobs.labelIconRotationAlignment }
      : {}),
    ...(knobs.labelIconCollide !== undefined ? { iconCollide: knobs.labelIconCollide } : {}),
    ...(knobs.labelIconIgnorePlacement !== undefined
      ? { iconIgnorePlacement: knobs.labelIconIgnorePlacement }
      : {}),
    ...(knobs.labelIconOptional !== undefined ? { iconOptional: knobs.labelIconOptional } : {}),
    ...(knobs.labelIconPadding !== undefined ? { iconPadding: knobs.labelIconPadding } : {}),
    ...(knobs.labelIconKeepUpright !== undefined
      ? { iconKeepUpright: knobs.labelIconKeepUpright }
      : {}),
    ...(knobs.labelIconTextFit !== undefined ? { iconTextFit: knobs.labelIconTextFit } : {}),
    ...(knobs.labelIconTextFitPadding !== undefined
      ? { iconTextFitPadding: knobs.labelIconTextFitPadding }
      : {}),
  }
  // Plan Label L3: build the unified shapes bundle from the knob inputs
  // + the merged label's static fallbacks.
  merged.shapes = buildLabelShapes({
    size: merged.size,
    sizeZoomStops:
      knobs.labelSizeZoomStops && knobs.labelSizeZoomStops.length > 0
        ? knobs.labelSizeZoomStops
        : undefined,
    sizeZoomStopsBase: knobs.labelSizeZoomStopsBase,
    sizeExpr: knobs.labelSizeExpr,
    color: merged.color,
    colorZoomStops:
      knobs.labelColorZoomStops && knobs.labelColorZoomStops.length > 0
        ? knobs.labelColorZoomStops
        : undefined,
    colorZoomStopsBase: knobs.labelColorZoomStopsBase,
    colorExpr: knobs.labelColorExpr,
    halo: merged.halo,
    haloWidthZoomStops:
      knobs.labelHaloWidthZoomStops && knobs.labelHaloWidthZoomStops.length > 0
        ? knobs.labelHaloWidthZoomStops
        : undefined,
    haloWidthZoomStopsBase: knobs.labelHaloWidthZoomStopsBase,
    haloColorZoomStops:
      knobs.labelHaloColorZoomStops && knobs.labelHaloColorZoomStops.length > 0
        ? knobs.labelHaloColorZoomStops
        : undefined,
    haloColorZoomStopsBase: knobs.labelHaloColorZoomStopsBase,
    fontStack: merged.font,
    fontWeight: merged.fontWeight,
    fontStyle: merged.fontStyle,
    iconSize: merged.iconSize,
    iconSizeZoomStops:
      knobs.labelIconSizeZoomStops && knobs.labelIconSizeZoomStops.length > 0
        ? knobs.labelIconSizeZoomStops
        : undefined,
    iconSizeZoomStopsBase: knobs.labelIconSizeZoomStopsBase,
    iconSizeExpr: knobs.labelIconSizeExpr as import('./render-node').DataExpr | undefined,
    opacityZoomStops:
      knobs.labelOpacityZoomStops && knobs.labelOpacityZoomStops.length > 0
        ? knobs.labelOpacityZoomStops
        : undefined,
    opacityZoomStopsBase: knobs.labelOpacityZoomStopsBase,
    opacityExpr: knobs.labelOpacityExpr as import('./render-node').DataExpr | undefined,
    iconOpacity: merged.iconOpacity,
    iconOpacityZoomStops:
      knobs.labelIconOpacityZoomStops && knobs.labelIconOpacityZoomStops.length > 0
        ? knobs.labelIconOpacityZoomStops
        : undefined,
    iconOpacityZoomStopsBase: knobs.labelIconOpacityZoomStopsBase,
    iconOpacityExpr: knobs.labelIconOpacityExpr as import('./render-node').DataExpr | undefined,
    iconColor: merged.iconColor,
    iconColorZoomStops:
      knobs.labelIconColorZoomStops && knobs.labelIconColorZoomStops.length > 0
        ? knobs.labelIconColorZoomStops
        : undefined,
    iconColorZoomStopsBase: knobs.labelIconColorZoomStopsBase,
    iconColorExpr: knobs.labelIconColorExpr,
  })
  return merged
}
