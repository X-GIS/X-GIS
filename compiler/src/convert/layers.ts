import type { MapboxLayer } from './types'
import { sanitizeId } from './utils'
import { filterToXgis, exprToXgis } from './expressions'
import { paintToUtilities, interpolateZoomCall } from './paint'
import type { SymbolLayerOverrides } from './layers-types'
import { convertCircleLayer } from './layers-circle'
import {
  convertTextPaintProperties,
  convertIconProperties,
  convertGapWarnings,
} from './layers-symbol'
import {
  unwrapLiteralTuple,
  unwrapLiteralScalar,
  safePropsBag,
  isOmittedValue,
  parseMapboxFontName,
  textFieldToXgisExpr,
  parseSymbolPlacementStep,
  VALID_ANCHORS,
  fmtSigned,
  unwrapPairScalars,
} from './layers-helpers'
// Re-export the one public helper so importers of './layers' keep their
// surface (font-name-parse + font-weight-end-to-end tests import it here).
export { parseMapboxFontName } from './layers-helpers'

// Layer types whose engine support is on the roadmap but not yet
// landed. Each type gets a more informative SKIPPED comment that
// names the engine work it's waiting on, so users reading the
// converter output know whether the gap is "won't ever support" or
// "coming in batch N".
//
// `symbol` is handled separately below (Batch 1b) — text-field
// emits a `label-[<expr>]` utility so the IR carries the text
// intent through compilation. Rendering arrives in Batch 1c.
const SKIP_REASONS: Record<string, string> = {
  heatmap: 'heatmap layer — Batch 3 (accumulation MRT + Gaussian blur)',
  hillshade: 'hillshade layer — Batch 4 (raster-dem + lighting shader)',
  sky: 'sky layer — gradient/atmospheric sky rendering not yet wired (would need a dome quad + per-fragment hue interpolation)',
}

function convertSymbolLayer(
  layer: MapboxLayer,
  warnings: string[],
  overrides?: SymbolLayerOverrides,
): string {
  const layout = safePropsBag((layer as { layout?: unknown }).layout)
  const paint = safePropsBag((layer as { paint?: unknown }).paint)
  const textField = layout['text-field']
  const iconImage = unwrapLiteralScalar(layout['icon-image'])
  // Mapbox spec: text-field === null means "no text" (same as
  // undefined). Pre-fix only undefined fell to the icon-only path;
  // an explicit `text-field: null` (uncommon but spec-valid)
  // dropped the layer entirely even when icon-image was set.
  // Multi-wrap null detection — `["literal", null]` / deeper means
  // "no text" per Mapbox spec (null falls back to property default,
  // which for text-field is no rendering). Without this peel hasText
  // stayed true (the wrapper is non-null), iconOnly stayed false, and
  // the layer emitted `label-[null]` instead of going through the
  // icon-only branch.
  const hasText = !isOmittedValue(textField)
  const iconOnly = !hasText && typeof iconImage === 'string'

  if (!hasText && !iconOnly) {
    // No text-field AND no icon-image — nothing renderable.
    warnings.push(`Symbol layer "${layer.id}" — neither text-field nor icon-image; dropping.`)
    return `// SKIPPED layer "${layer.id}" type="symbol" — no text-field or icon-image.`
  }

  // Icon-only symbols emit a label with empty text — runtime renders
  // just the sprite. Both-text-and-icon layers proceed via the
  // existing text path with the icon utilities layered on top.
  const labelExpr = iconOnly
    ? '""'
    : textFieldToXgisExpr(textField, warnings)
  if (labelExpr === null) {
    warnings.push(`Symbol layer "${layer.id}" — text-field "${JSON.stringify(textField).slice(0, 60)}" not convertible.`)
    return `// SKIPPED layer "${layer.id}" type="symbol" — text-field expression not convertible.`
  }

  const layerId = overrides?.idSuffix
    ? `${sanitizeId(layer.id)}_${overrides.idSuffix}`
    : sanitizeId(layer.id)
  const lines: string[] = [`layer ${layerId} {`]
  if (layer.source) lines.push(`  source: ${sanitizeId(layer.source)}`)
  if (layer['source-layer']) lines.push(`  sourceLayer: ${JSON.stringify(layer['source-layer'])}`)
  const effectiveMin = overrides?.minzoom !== undefined ? overrides.minzoom : layer.minzoom
  const effectiveMax = overrides?.maxzoom !== undefined ? overrides.maxzoom : layer.maxzoom
  if (typeof effectiveMin === 'number' && Number.isFinite(effectiveMin)) lines.push(`  minzoom: ${effectiveMin}`)
  if (typeof effectiveMax === 'number' && Number.isFinite(effectiveMax)) lines.push(`  maxzoom: ${effectiveMax}`)
  if (layer.filter !== undefined) {
    const f = filterToXgis(layer.filter, warnings)
    if (f) lines.push(`  filter: ${f}`)
  }
  // `layout.visibility: 'none'` applies to every Mapbox layer type per
  // spec — not just the generic convertLayer path. Without this gate
  // a hidden symbol layer (label / icon) rendered anyway because the
  // converter never emitted `visible: false`. Mirror the unwrap so v8
  // strict `["literal", "none"]` works the same as bare "none".
  const symbolVisibility = unwrapLiteralScalar(layout['visibility'])
  if (symbolVisibility === 'none') {
    lines.push(`  visible: false`)
  } else if (typeof symbolVisibility === 'string' && symbolVisibility !== 'visible') {
    // Mapbox spec: visibility must be 'visible' | 'none'. Anything
    // else was silently treated as 'visible' (default), so a typo
    // like 'hidden' silently left the layer visible.
    warnings.push(`Symbol layer "${layer.id}" — visibility "${symbolVisibility.slice(0, 40)}" is not a valid enum; expected 'visible' | 'none'.`)
  }

  const utils: string[] = [`label-[${labelExpr}]`]

  convertTextPaintProperties(layer, layout, paint, utils, warnings)

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
  // icon-translate (paint) — symmetric with text-translate but
  // separate offset that applies only to icons (e.g. shift a POI
  // icon up by 4px while keeping the label centred). X-GIS symbol
  // path uses the SAME label-translate-{x,y}-N utilities for both
  // text and icon today; a dedicated label-icon-translate-{x,y}
  // pair would thread through IconStage at dispatch time. Surface
  // the gap explicitly so authors who depend on independent icon
  // vs text offset (shield + caption styles) see it.
  if (paint['icon-translate'] !== undefined && paint['icon-translate'] !== null) {
    warnings.push(`Symbol layer "${layer.id}" — icon-translate set but X-GIS shares the text-translate offset for both icon and text (Plan §4 deferred — needs dedicated label-icon-translate plumbing through IconStage). Icon uses text-translate value if any, else 0.`)
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

  convertIconProperties(layer, layout, paint, iconImage, utils, warnings)
  convertGapWarnings(layer, layout, paint, warnings)

  lines.push('  | ' + utils.join(' '))
  lines.push('}')
  return lines.join('\n')
}

/** Mapbox `layers[i]` entry → xgis `layer <id> { … }` block, or
 *  null when the layer is the top-level `background` (handled
 *  specially by `convertMapboxStyle`).
 *
 *  Skipped layer types emit a `// SKIPPED` comment that NAMES the
 *  roadmap batch they're waiting on — so users reading the output
 *  know whether the gap is permanent or coming. */
export function convertLayer(layer: MapboxLayer, warnings: string[]): string | null {
  if (layer.type === 'symbol') {
    // `symbol-placement: ["step", ["zoom"], …]` (OFM Bright highway
    // shields) splits into one xgis layer per zoom-step segment so
    // each segment can carry its own minzoom/maxzoom + resolved
    // placement utility. Literal-string placement falls through to
    // the single-layer path below.
    const segments = parseSymbolPlacementStep(layer)
    if (segments && segments.length > 1) {
      const blocks: string[] = []
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i]!
        // Intersect the segment's range with the layer's declared
        // minzoom/maxzoom so a layer that's already gated outside
        // the step's full domain stays gated.
        const minzoom = seg.minzoom !== undefined
          ? (typeof layer.minzoom === 'number' && Number.isFinite(layer.minzoom) ? Math.max(layer.minzoom, seg.minzoom) : seg.minzoom)
          : layer.minzoom
        const maxzoom = seg.maxzoom !== undefined
          ? (typeof layer.maxzoom === 'number' && Number.isFinite(layer.maxzoom) ? Math.min(layer.maxzoom, seg.maxzoom) : seg.maxzoom)
          : layer.maxzoom
        blocks.push(convertSymbolLayer(layer, warnings, {
          idSuffix: String(i),
          placement: seg.placement,
          minzoom,
          maxzoom,
        }))
      }
      return blocks.join('\n\n')
    }
    return convertSymbolLayer(layer, warnings)
  }
  if (layer.type === 'circle') {
    return convertCircleLayer(layer, warnings)
  }
  const skipReason = SKIP_REASONS[layer.type]
  if (skipReason !== undefined) {
    warnings.push(`Layer "${layer.id}" type="${layer.type}" — ${skipReason}.`)
    return `// SKIPPED layer "${layer.id}" type="${layer.type}" — ${skipReason}.`
  }
  // Distinct failure modes for layer.type — mirror of the source-type
  // validation. Pre-fix missing / non-string layer.type fell through
  // to the main body, paintToUtilities returned [] (no `type === …`
  // matched), the emitted block had no paint utilities, dead-layer-
  // elim killed it silently. The user saw "my layer doesn't render"
  // with no diagnostic.
  const knownLayerTypes = new Set([
    'fill', 'line', 'fill-extrusion', 'raster', 'symbol', 'circle',
    'background', 'heatmap', 'hillshade',
  ])
  if (layer.type === undefined || layer.type === null) {
    warnings.push(`Layer "${(layer as { id?: unknown }).id ?? '<unknown>'}" is missing the required type field; emitted SKIPPED placeholder.`)
    return `// SKIPPED layer "${(layer as { id?: unknown }).id ?? '<unknown>'}" — missing required type field.`
  }
  if (typeof layer.type !== 'string') {
    warnings.push(`Layer "${(layer as { id?: unknown }).id ?? '<unknown>'}" type field must be a string (got ${typeof layer.type}); emitted SKIPPED placeholder.`)
    return `// SKIPPED layer "${(layer as { id?: unknown }).id ?? '<unknown>'}" — non-string type field.`
  }
  if (!knownLayerTypes.has(layer.type)) {
    warnings.push(`Layer "${layer.id}" has unknown type "${layer.type}"; emitted SKIPPED placeholder. Mapbox spec layer types: fill, line, fill-extrusion, raster, symbol, circle, background, heatmap, hillshade.`)
    return `// SKIPPED layer "${layer.id}" type="${layer.type}" — unknown layer type.`
  }

  const lines: string[] = [`layer ${sanitizeId(layer.id)} {`]
  if (layer.source) lines.push(`  source: ${sanitizeId(layer.source)}`)
  if (layer['source-layer']) lines.push(`  sourceLayer: ${JSON.stringify(layer['source-layer'])}`)
  if (typeof layer.minzoom === 'number' && Number.isFinite(layer.minzoom)) lines.push(`  minzoom: ${layer.minzoom}`)
  if (typeof layer.maxzoom === 'number' && Number.isFinite(layer.maxzoom)) lines.push(`  maxzoom: ${layer.maxzoom}`)
  if (layer.filter !== undefined) {
    const f = filterToXgis(layer.filter, warnings)
    if (f) lines.push(`  filter: ${f}`)
  }

  // Mapbox layout properties → xgis equivalents.
  //
  // `visibility: 'none'` is a CSS-style block property (the parser
  // accepts unhyphenated identifiers as property names — `visible`
  // qualifies; `stroke-linecap` does not, hence the utility route
  // for cap/join). Engine support: `compiler/src/ir/lower.ts:903`
  // for `visible:` block prop, lines 402-417 for cap/join utilities.
  const layout = safePropsBag((layer as { layout?: unknown }).layout)
  const generalVisibility = unwrapLiteralScalar(layout['visibility'])
  if (generalVisibility === 'none') {
    lines.push(`  visible: false`)
  } else if (typeof generalVisibility === 'string' && generalVisibility !== 'visible') {
    warnings.push(`Layer "${layer.id}" — visibility "${generalVisibility.slice(0, 40)}" is not a valid enum; expected 'visible' | 'none'.`)
  }

  // Cap / join / miter-limit are emitted as UTILITIES (after the `|`)
  // since the xgis parser doesn't accept hyphenated names in the
  // CSS-style property position. Engine handles them via the utility
  // resolver (lower.ts:402-422).
  const layoutUtils: string[] = []
  if (layer.type === 'line') {
    const cap = unwrapLiteralScalar(layout['line-cap'])
    if (cap === 'butt') layoutUtils.push('stroke-butt-cap')
    else if (cap === 'round') layoutUtils.push('stroke-round-cap')
    else if (cap === 'square') layoutUtils.push('stroke-square-cap')
    else if (typeof cap === 'string') {
      // Mapbox spec: line-cap must be 'butt' | 'round' | 'square'.
      // Only flag STRING values not in the enum — expression-shaped
      // (zoom-step) values pass through to downstream handling.
      warnings.push(`Layer "${layer.id}" — line-cap "${cap.slice(0, 40)}" is not a valid enum; expected 'butt' | 'round' | 'square'.`)
    }
    const join = unwrapLiteralScalar(layout['line-join'])
    if (join === 'miter') layoutUtils.push('stroke-miter-join')
    else if (join === 'round') layoutUtils.push('stroke-round-join')
    else if (join === 'bevel') layoutUtils.push('stroke-bevel-join')
    else if (typeof join === 'string') {
      warnings.push(`Layer "${layer.id}" — line-join "${join.slice(0, 40)}" is not a valid enum; expected 'miter' | 'round' | 'bevel'.`)
    }
    const miter = unwrapLiteralScalar(layout['line-miter-limit'])
    if (typeof miter === 'number' && Number.isFinite(miter)) {
      if (miter < 0) {
        warnings.push(`Layer "${layer.id}" — line-miter-limit ${miter} is negative; Mapbox spec default is 2 and values < 1 collapse to bevel joins. Negative emits a malformed utility — clamped to 0.`)
      }
      layoutUtils.push(`stroke-miterlimit-${Math.max(0, miter)}`)
    }
  }

  const utils = [...layoutUtils, ...paintToUtilities(layer, warnings)]
  if (utils.length > 0) {
    lines.push('  | ' + utils.join(' '))
  }
  lines.push('}')
  return lines.join('\n')
}
