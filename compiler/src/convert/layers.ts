import type { MapboxLayer } from './types'
import { sanitizeId } from './utils'
import { filterToXgis, exprToXgis } from './expressions'
import { paintToUtilities, interpolateZoomCall } from './paint'
import { colorToXgis } from './colors'

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
}

/** Mapbox font-name trailing keywords → CSS font-weight numerics.
 *  Covers the standard 100..900 axis plus common aliases (Hairline,
 *  UltraLight, Heavy, …) used by font foundries. Matched as a single
 *  trailing token first; the two-word forms ("Extra Bold", "Semi
 *  Bold") get collapsed in `parseMapboxFontName` before lookup. */
const FONT_WEIGHT_KEYWORDS: Record<string, number> = {
  Thin: 100, Hairline: 100,
  ExtraLight: 200, UltraLight: 200,
  Light: 300,
  Regular: 400, Normal: 400, Book: 400,
  Medium: 500,
  SemiBold: 600, DemiBold: 600,
  Bold: 700,
  ExtraBold: 800, UltraBold: 800, Heavy: 800,
  Black: 900,
}
const FONT_STYLE_KEYWORDS = new Set(['Italic', 'Oblique'])

/** Split a Mapbox font name like "Noto Sans Bold Italic" into family +
 *  weight + style. The trailing keywords are stripped from the family
 *  name so the runtime can drive ctx.font with a proper CSS shorthand
 *  ("italic 700 24px \"Noto Sans\"") instead of pushing weight info
 *  into the family name itself.
 *
 *  Algorithm: peel italic/oblique and weight words from the END of
 *  the name in either order ("Bold Italic" or "Italic Bold"), and
 *  collapse two-word weight forms ("Extra Bold", "Semi Bold") into
 *  their single-keyword equivalents. The remaining tokens are the
 *  family. Unknown trailing tokens are left as part of the family.
 *
 *  Exported only for the unit test — it lives outside the converter
 *  caller surface. */
export function parseMapboxFontName(name: string): {
  family: string
  weight?: number
  style?: 'italic'
} {
  const parts = name.trim().split(/\s+/)
  let weight: number | undefined
  let style: 'italic' | undefined
  // Case-insensitive lookup tables: font foundries inconsistently
  // capitalise weight / style keywords ("Semibold" vs "SemiBold"
  // vs "semibold"). OFM Bright + MapLibre demotiles ship the
  // "Semibold" form, which previously fell through the lookup,
  // dropped the weight, and rendered every label at regular
  // weight — making demotiles labels look thin vs the MapLibre
  // reference. Normalise input to lowercase before matching.
  const weightKeysByLower: Record<string, number> = {}
  for (const k of Object.keys(FONT_WEIGHT_KEYWORDS)) {
    weightKeysByLower[k.toLowerCase()] = FONT_WEIGHT_KEYWORDS[k]!
  }
  const styleKeysLower = new Set([...FONT_STYLE_KEYWORDS].map(s => s.toLowerCase()))
  // Loop until neither end matches — handles "Bold Italic" and
  // "Italic Bold" without ordering assumptions. Two-word weight
  // forms ("Semi Bold", "Extra Bold") are checked BEFORE the
  // single-word lookup so the larger match wins; otherwise "Bold"
  // gets peeled first and "Semi" is left stranded on the family.
  let progressed = true
  while (progressed && parts.length > 0) {
    progressed = false
    const last = parts[parts.length - 1]!
    const lastLower = last.toLowerCase()
    if (style === undefined && styleKeysLower.has(lastLower)) {
      style = 'italic'
      parts.pop()
      progressed = true
      continue
    }
    if (weight === undefined) {
      if (parts.length >= 2) {
        const twoWord = (parts[parts.length - 2]! + last).toLowerCase()
        if (twoWord in weightKeysByLower) {
          weight = weightKeysByLower[twoWord]
          parts.length -= 2
          progressed = true
          continue
        }
      }
      if (lastLower in weightKeysByLower) {
        weight = weightKeysByLower[lastLower]
        parts.pop()
        progressed = true
        continue
      }
    }
  }
  return {
    family: parts.join(' '),
    ...(weight !== undefined ? { weight } : {}),
    ...(style !== undefined ? { style } : {}),
  }
}

/** Convert Mapbox `text-field` value → xgis expression string.
 *  Forms handled:
 *    - String literal `"Hello"` → quoted xgis string `"Hello"`
 *    - Single token `"{name}"` → field access `.name`
 *    - Multi-token `"{name} ({ref})"` → quoted xgis template literal.
 *      lower.ts:bindingToTextValue routes string-literal bindings
 *      through parseTextTemplate so each `{field}` interpolates per
 *      feature and the literals between them stay as-is. Without
 *      this path German autobahn labels, US highway shields, transit
 *      line names — anything composing two fields — render missing
 *      or just the first token. The existing converter already does
 *      `JSON.stringify(field)` here; this comment documents WHY
 *      that's the right behaviour so it doesn't get "simplified" away.
 *    - `["coalesce", ["get", "k1"], ["get", "k2"], …]` and `["concat",
 *      …]` etc. → exprToXgis, which emits the xgis `??` operator
 *      (parser+evaluator both support it: parser.ts:913,
 *      evaluator.ts:89). Locale-variant keys like `["get", "name:ko"]`
 *      are dropped with a warning because xgis FieldAccess can't
 *      lex colons; the coalesce fallback (next operand) takes over.
 *  Returns null if the value can't be converted (caller skips the
 *  whole label utility in that case). */
function textFieldToXgisExpr(field: unknown, warnings: string[]): string | null {
  if (typeof field === 'string') {
    const tokenMatch = field.match(/^\{([^}]+)\}$/)
    if (tokenMatch) {
      const name = tokenMatch[1]!
      // Same identifier-shape constraint as exprToXgis['get']: xgis
      // FieldAccess can't carry colons or other special chars.
      // Mapbox locale variants like `{name:latin}` map to a JSON-
      // string key — leave as a quoted template that the resolver
      // turns into a raw `.name` lookup at runtime (template parser
      // accepts the raw key form).
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
        warnings.push(`text-field token "{${name}}" — colon-bearing locale variants fall back to "name". Use a base "{name}" for cross-style portability.`)
        return '.name'
      }
      return `.${name}`
    }
    // Multi-token / mixed-literal string. Preserved as a quoted
    // xgis string; lower.ts walks the template at parse time.
    return JSON.stringify(field)
  }
  if (Array.isArray(field)) {
    return exprToXgis(field, warnings)
  }
  // Legacy Mapbox v0/v1 zoom-stops shape: `{"stops": [[z, value], …]}`.
  // The MapLibre demo basemap uses this on `text-field` to switch
  // between abbreviated and full country names with zoom:
  //   { "stops": [[2, "{ABBREV}"], [4, "{NAME}"]] }
  // Lift to xgis `step(zoom, v0, k1, v1, k2, v2, …)` so the runtime
  // evaluator picks the right value per frame. Each stop's value
  // recurses through textFieldToXgisExpr so token forms (`"{NAME}"`)
  // become real FieldAccess returns that the step() resolves to the
  // actual property value at evaluation time.
  if (
    field !== null && typeof field === 'object'
    && Array.isArray((field as { stops?: unknown }).stops)
  ) {
    const stops = (field as { stops: unknown[] }).stops
    if (stops.length < 1) return null
    // First stop's value is the default (returned for zoom < k1).
    const first = stops[0]
    if (!Array.isArray(first) || first.length < 2) return null
    const defaultVal = textFieldToXgisExpr(first[1], warnings)
    if (defaultVal === null) return null
    if (stops.length === 1) return defaultVal
    const parts: string[] = [defaultVal]
    for (let i = 1; i < stops.length; i++) {
      const s = stops[i]
      if (!Array.isArray(s) || s.length < 2 || typeof s[0] !== 'number') return null
      const v = textFieldToXgisExpr(s[1], warnings)
      if (v === null) return null
      parts.push(String(s[0]), v)
    }
    return `step(zoom, ${parts.join(', ')})`
  }
  return null
}

/** Symbol layer (Mapbox text labels + icons). Batch 1b emits text
 *  intent; Batch 1c wires the renderer; Batch 2 adds icons. For now,
 *  text-field becomes `label-[<expr>]` and text-color maps to a
 *  fill utility — the IR's `label?` field captures the rest. */
interface SymbolLayerOverrides {
  /** Override the layer id (used when splitting one Mapbox layer
   *  into multiple xgis blocks for zoom-step symbol-placement). */
  idSuffix?: string
  /** Constant `symbol-placement` value to use, bypassing the value
   *  read from `layout`. Used by the step expansion. */
  placement?: 'point' | 'line' | 'line-center'
  /** Override `minzoom` / `maxzoom` on the emitted block (the layer's
   *  own minzoom/maxzoom is overlaid by the step segment range). */
  minzoom?: number
  maxzoom?: number
}

function convertSymbolLayer(
  layer: MapboxLayer,
  warnings: string[],
  overrides?: SymbolLayerOverrides,
): string {
  const layout = (layer as { layout?: Record<string, unknown> }).layout ?? {}
  const paint = (layer as { paint?: Record<string, unknown> }).paint ?? {}
  const textField = layout['text-field']
  const iconImage = layout['icon-image']
  const iconOnly = textField === undefined && typeof iconImage === 'string'

  if (textField === undefined && !iconOnly) {
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
  if (layer['source-layer']) lines.push(`  sourceLayer: "${layer['source-layer']}"`)
  const effectiveMin = overrides?.minzoom !== undefined ? overrides.minzoom : layer.minzoom
  const effectiveMax = overrides?.maxzoom !== undefined ? overrides.maxzoom : layer.maxzoom
  if (typeof effectiveMin === 'number') lines.push(`  minzoom: ${effectiveMin}`)
  if (typeof effectiveMax === 'number') lines.push(`  maxzoom: ${effectiveMax}`)
  if (layer.filter !== undefined) {
    const f = filterToXgis(layer.filter, warnings)
    if (f) lines.push(`  filter: ${f}`)
  }

  const utils: string[] = [`label-[${labelExpr}]`]

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
  const textColor = paint['text-color']
  if (textColor !== undefined) {
    const interp = interpolateZoomCall(textColor, warnings, (val, w) => colorToXgis(val, w))
    if (interp !== null) {
      utils.push(`label-color-[${interp}]`)
    } else {
      const colorStr = colorToXgis(textColor, warnings)
      if (colorStr) {
        utils.push(`label-color-${colorStr}`)
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
          utils.push('label-color-#000')
        }
      }
    }
  } else {
    // Mapbox text-color default = "#000000".
    utils.push('label-color-#000')
  }

  // text-size — constant or interpolate-by-zoom. The bracket binding
  // form `label-size-[interpolate(zoom, …)]` is recognised by the
  // lower pass (lower.ts:499) and produces `LabelDef.sizeZoomStops`
  // for per-frame interpolation.
  const textSize = layout['text-size']
  if (typeof textSize === 'number') {
    utils.push(`label-size-${textSize}`)
  } else if (textSize !== undefined) {
    const interp = interpolateZoomCall(textSize, warnings,
      (val) => typeof val === 'number' ? String(val) : null)
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
  const haloWidth = paint['text-halo-width']
  if (typeof haloWidth === 'number' && haloWidth > 0) {
    utils.push(`label-halo-${haloWidth}`)
  } else if (haloWidth !== undefined) {
    const interp = interpolateZoomCall(haloWidth, warnings,
      (val) => typeof val === 'number' ? String(val) : null)
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
  if (haloColor !== undefined) {
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
  const haloBlur = paint['text-halo-blur']
  if (typeof haloBlur === 'number' && haloBlur > 0) {
    utils.push(`label-halo-blur-${haloBlur}`)
  }

  // text-anchor → label-anchor-X. Mapbox's 9-way anchor maps 1:1
  // to the IR's 9-way LabelDef.anchor (render-node.ts:244-246).
  // Earlier versions collapsed corners to the dominant axis because
  // the lower pass only recognised 5 anchors; that shed half the
  // alignment information for any style that anchored labels to a
  // POI's corner (e.g. icons-with-labels where the label sits to
  // the bottom-right of the icon).
  const VALID_ANCHORS = new Set([
    'center', 'top', 'bottom', 'left', 'right',
    'top-left', 'top-right', 'bottom-left', 'bottom-right',
  ])
  // Precedence (Mapbox spec): `text-variable-anchor-offset` is the
  // modern combined form and supersedes everything else; it is emitted
  // in the offset block below (anchors + per-anchor `label-vao-*`).
  // Otherwise `text-variable-anchor` (the real layout property — NOT
  // an array stuffed into `text-anchor`) lists the candidates; falling
  // back to the static 9-way `text-anchor`. The legacy "array in
  // text-anchor" shape is kept for callers that pre-fold it that way.
  const variableAnchorOffset = layout['text-variable-anchor-offset']
  const hasVAO = Array.isArray(variableAnchorOffset) && variableAnchorOffset.length >= 2
  const variableAnchor = layout['text-variable-anchor']
  const anchor = layout['text-anchor']
  if (hasVAO) {
    // handled in the offset block (needs fmtSigned in scope)
  } else if (Array.isArray(variableAnchor) && variableAnchor.length > 0) {
    // Mapbox `text-variable-anchor`: ["top","bottom",…] — emit one
    // `label-anchor-X` per valid candidate, in priority order. lower.ts
    // accumulates these into `LabelDef.anchor` (the first) +
    // `anchorCandidates`; the runtime tries each during collision and
    // picks the first that doesn't overlap an already-placed label.
    for (const a of variableAnchor) {
      if (typeof a === 'string' && VALID_ANCHORS.has(a)) {
        utils.push(`label-anchor-${a}`)
      }
    }
  } else if (typeof anchor === 'string' && VALID_ANCHORS.has(anchor)) {
    utils.push(`label-anchor-${anchor}`)
  } else if (Array.isArray(anchor) && anchor.length > 0) {
    for (const a of anchor) {
      if (typeof a === 'string' && VALID_ANCHORS.has(a)) {
        utils.push(`label-anchor-${a}`)
      }
    }
  }

  // text-transform → label-uppercase / lowercase / none.
  const transform = layout['text-transform']
  if (transform === 'uppercase' || transform === 'lowercase' || transform === 'none') {
    utils.push(`label-${transform}`)
  }

  // text-offset → label-offset-x-N + label-offset-y-N (em-units).
  // Mapbox shape: [number, number]. Constant only — interpolate /
  // expression forms wait until the binding-bracket utility lands.
  // Negative values use the bracket binding form `[<n>]` because the
  // utility-name grammar treats `-` as a segment separator — emitting
  // `label-offset-y--0.2` would lex as a malformed double-dash name.
  const fmtSigned = (n: number): string => n < 0 ? `[${n}]` : `${n}`
  const offset = layout['text-offset']
  if (Array.isArray(offset) && offset.length === 2
      && typeof offset[0] === 'number' && typeof offset[1] === 'number') {
    if (offset[0] !== 0) utils.push(`label-offset-x-${fmtSigned(offset[0])}`)
    if (offset[1] !== 0) utils.push(`label-offset-y-${fmtSigned(offset[1])}`)
  }
  // text-translate (paint) → label-translate-{x,y}-N. Pixel-space
  // offset on top of em-unit text-offset; commonly used to nudge
  // labels off the road centreline (`text-translate: [0, -8]` for
  // an 8-px upward shift). Negatives ride the bracket form like
  // text-offset.
  const translate = paint['text-translate']
  if (Array.isArray(translate) && translate.length === 2
      && typeof translate[0] === 'number' && typeof translate[1] === 'number') {
    if (translate[0] !== 0) utils.push(`label-translate-x-${fmtSigned(translate[0])}`)
    if (translate[1] !== 0) utils.push(`label-translate-y-${fmtSigned(translate[1])}`)
  }
  // text-radial-offset (em) → label-radial-offset-N. Only meaningful
  // alongside text-variable-anchor: the runtime pushes the label away
  // from the anchor point by this radius in each candidate anchor's
  // direction (MapLibre fromRadialOffset). Negatives ride the bracket
  // form, though Mapbox clamps a negative radial offset to 0 anyway.
  const radialOffset = layout['text-radial-offset']
  if (typeof radialOffset === 'number' && radialOffset !== 0) {
    utils.push(`label-radial-offset-${fmtSigned(radialOffset)}`)
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
      const off = variableAnchorOffset![i + 1]
      if (typeof a === 'string' && VALID_ANCHORS.has(a)
          && Array.isArray(off) && off.length === 2
          && typeof off[0] === 'number' && typeof off[1] === 'number') {
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
  const textOverlap = layout['text-overlap']
  if (textOverlap === 'always') {
    utils.push('label-allow-overlap')
  } else if (textOverlap === 'cooperative') {
    utils.push('label-allow-overlap')
    warnings.push(`Symbol layer "${layer.id}" — text-overlap: "cooperative" approximated as "always" (priority-aware collision pending).`)
  } else if (textOverlap === 'never') {
    // Default — no utility needed.
  } else if (textOverlap !== undefined) {
    warnings.push(`Symbol layer "${layer.id}" — unrecognised text-overlap value ${JSON.stringify(textOverlap)}; ignored.`)
  } else if (layout['text-allow-overlap'] === true) {
    // Legacy fallback only when the new property is absent.
    utils.push('label-allow-overlap')
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
  const iconOverlap = layout['icon-overlap']
  if (iconOverlap !== undefined && iconOverlap !== 'always' && iconOverlap !== 'never' && iconOverlap !== 'cooperative') {
    warnings.push(`Symbol layer "${layer.id}" — unrecognised icon-overlap value ${JSON.stringify(iconOverlap)}; ignored.`)
  }
  if (layout['text-ignore-placement'] === true) utils.push('label-ignore-placement')
  const padding = layout['text-padding']
  if (typeof padding === 'number') {
    utils.push(`label-padding-${padding}`)
  } else if (padding !== undefined) {
    const interp = interpolateZoomCall(padding, warnings,
      (val) => typeof val === 'number' ? String(val) : null)
    if (interp !== null) utils.push(`label-padding-[${interp}]`)
  }

  // text-rotate (degrees clockwise) + text-letter-spacing (em-units).
  // Both can be negative (counter-clockwise rotation, condensed
  // tracking) → bracket form for negatives. Mapbox text-letter-spacing
  // is zoom-interpolatable; large basemap styles fade tracking out at
  // low zoom for legibility.
  const rotate = layout['text-rotate']
  if (typeof rotate === 'number' && rotate !== 0) {
    utils.push(`label-rotate-${fmtSigned(rotate)}`)
  }
  const letterSpacing = layout['text-letter-spacing']
  if (typeof letterSpacing === 'number' && letterSpacing !== 0) {
    utils.push(`label-letter-spacing-${fmtSigned(letterSpacing)}`)
  } else if (letterSpacing !== undefined && typeof letterSpacing !== 'number') {
    const interp = interpolateZoomCall(letterSpacing, warnings,
      (val) => typeof val === 'number' ? String(val) : null)
    if (interp !== null) utils.push(`label-letter-spacing-[${interp}]`)
  }

  // text-max-width / text-line-height (em-units) + text-justify
  // for multiline labels. Mapbox's text-max-width default = 10 (ems)
  // is "disabled by symbol-placement: line" per the spec — for line
  // labels we mirror that by NOT emitting the default, which leaves
  // the runtime's "undefined ⇒ no wrap" behaviour for road names etc.
  const maxWidth = layout['text-max-width']
  // When an override is supplied (zoom-step layer split), it WINS
  // over the layout value. The outer dispatcher computes one segment
  // per step range and re-runs convertSymbolLayer with the segment's
  // resolved placement string.
  const placement: unknown = overrides?.placement !== undefined
    ? overrides.placement
    : layout['symbol-placement']
  if (typeof maxWidth === 'number') {
    utils.push(`label-max-width-${maxWidth}`)
  } else if (placement !== 'line' && placement !== 'line-center') {
    utils.push('label-max-width-10')
  }
  const lineHeight = layout['text-line-height']
  if (typeof lineHeight === 'number') utils.push(`label-line-height-${lineHeight}`)
  const justify = layout['text-justify']
  if (justify === 'auto' || justify === 'left' || justify === 'center' || justify === 'right') {
    utils.push(`label-justify-${justify}`)
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
  const fontStack = layout['text-font']
  if (Array.isArray(fontStack) && fontStack.length > 0) {
    let emittedWeight: number | undefined
    let emittedStyle: 'italic' | undefined
    for (const f of fontStack) {
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

  // text-rotation-alignment / text-pitch-alignment — Mapbox knobs
  // controlling how labels orient relative to map vs viewport. Default
  // 'auto' resolves to viewport for point placement, map for line.
  // Plumb through verbatim so the runtime can pick the right behavior;
  // pitch-alignment: map (text projected onto the ground plane with
  // perspective) is a future runtime task — emit anyway so the IR
  // carries user intent.
  const rotAlign = layout['text-rotation-alignment']
  if (rotAlign === 'map' || rotAlign === 'viewport' || rotAlign === 'auto') {
    utils.push(`label-rotation-alignment-${rotAlign}`)
  }
  const pitchAlign = layout['text-pitch-alignment']
  if (pitchAlign === 'map' || pitchAlign === 'viewport' || pitchAlign === 'auto') {
    utils.push(`label-pitch-alignment-${pitchAlign}`)
  }

  // symbol-spacing — distance between repeated labels along a line
  // in pixels. Only meaningful for placement: line. Default 250 in
  // Mapbox; emit explicitly when missing so road-name layers don't
  // collapse to a single label per feature.
  const symbolSpacing = layout['symbol-spacing']
  if (placement === 'line') {
    if (typeof symbolSpacing === 'number' && symbolSpacing > 0) {
      utils.push(`label-spacing-${symbolSpacing}`)
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
  const keepUpright = layout['text-keep-upright']
  if (keepUpright === false) utils.push('label-keep-upright-false')
  else if (keepUpright === true) utils.push('label-keep-upright-true')

  // ── Icon (Batch 2 — sprite atlas) ──
  // `icon-image` is a sprite-atlas key. Constant string form only;
  // data-driven (`["get", "marker"]`) silently drops to no-icon for
  // now and surfaces a warning. icon-size / icon-anchor / icon-offset
  // / icon-rotate take their Mapbox defaults when absent.
  if (typeof iconImage === 'string') {
    utils.push(`label-icon-image-${iconImage}`)
  } else if (iconImage !== undefined) {
    warnings.push(`Symbol layer "${layer.id}" — data-driven icon-image not yet supported (Phase B+).`)
  }
  const iconSize = layout['icon-size']
  if (typeof iconSize === 'number' && iconSize !== 1) {
    utils.push(`label-icon-size-${fmtSigned(iconSize)}`)
  }
  const iconAnchor = layout['icon-anchor']
  if (typeof iconAnchor === 'string' && iconAnchor !== 'center') {
    utils.push(`label-icon-anchor-${iconAnchor}`)
  }
  const iconOffset = layout['icon-offset']
  if (Array.isArray(iconOffset) && iconOffset.length === 2
      && typeof iconOffset[0] === 'number' && typeof iconOffset[1] === 'number') {
    // Two utilities so the xgis-utility-name grammar (`-` is the
    // segment separator) can carry signed numbers without a custom
    // string-comma syntax. Mirrors the `label-offset-x-N` /
    // `label-offset-y-M` split for text-offset.
    if (iconOffset[0] !== 0) utils.push(`label-icon-offset-x-${fmtSigned(iconOffset[0])}`)
    if (iconOffset[1] !== 0) utils.push(`label-icon-offset-y-${fmtSigned(iconOffset[1])}`)
  }
  const iconRotate = layout['icon-rotate']
  if (typeof iconRotate === 'number' && iconRotate !== 0) {
    utils.push(`label-icon-rotate-${fmtSigned(iconRotate)}`)
  }

  const ignoredText: string[] = []
  // Unsupported symbol properties — surface ONE consolidated note per
  // layer so style authors know which knobs landed without effect.
  // Excludes properties whose absence is invisible (text-optional,
  // text-padding when icon-padding isn't used) and the per-Batch
  // already-warned set (data-driven icon-image is its own warning).
  for (const k of [
    'text-writing-mode',     // CJK vertical text — per-glyph rotation pipeline pending
    'text-max-angle',        // along-path glyph orientation clamp
    'text-opacity',          // Per-property fade; text uses layer opacity today
    'icon-color',
    'icon-opacity',
    'icon-halo-color',
    'icon-halo-width',
    'icon-halo-blur',
    'icon-rotation-alignment',
    'icon-text-fit',
    // Symbol placement controls — `symbol-z-order` and `symbol-sort-key`
    // change draw ordering at the layer level (Mapbox `symbol-sort-key`
    // = per-feature priority), `symbol-avoid-edges` skips labels at
    // tile boundaries to avoid clipped glyphs. Our placement passes
    // use style-order + greedy collision; none of these knobs is
    // honoured today.
    'symbol-z-order',
    'symbol-sort-key',
    'symbol-avoid-edges',
  ]) {
    if (layout[k] !== undefined || paint[k] !== undefined) ignoredText.push(k)
  }
  if (ignoredText.length > 0) {
    warnings.push(`Symbol layer "${layer.id}" — ignored properties (Batch 1d/1e+): ${ignoredText.join(', ')}`)
  }

  lines.push('  | ' + utils.join(' '))
  lines.push('}')
  return lines.join('\n')
}

/** Detect Mapbox `["step", ["zoom"], v0, z1, v1, z2, v2, …]` shape on
 *  the layer's `symbol-placement` layout property. Returns the parsed
 *  segments (one per zoom range, each with the resolved placement
 *  value) or null when the shape doesn't match — caller falls through
 *  to single-layer emission with the literal-string handling already
 *  in convertSymbolLayer.
 *
 *  OFM Bright's three highway-shield layers use this form:
 *      ["step", ["zoom"], "point", 11, "line"]
 *  which we expand to TWO xgis layers:
 *      layer X_lo { maxzoom: 11, ... }  // point placement (default)
 *      layer X_hi { minzoom: 11, ... }  // along-path placement
 *  Without the split, the literal-string-only path picks "point" and
 *  the high-zoom road shields render anchored to one segment instead
 *  of following the road. */
function parseSymbolPlacementStep(
  layer: MapboxLayer,
): Array<{ minzoom?: number; maxzoom?: number; placement: 'point' | 'line' | 'line-center' }> | null {
  const layout = (layer as { layout?: Record<string, unknown> }).layout ?? {}
  const sp = layout['symbol-placement']
  if (!Array.isArray(sp) || sp[0] !== 'step') return null
  const input = sp[1]
  if (!Array.isArray(input) || input[0] !== 'zoom') return null
  // ["step", ["zoom"], default, z1, v1, z2, v2, …]
  // Args after the input: default + N (zoom, value) pairs.
  const rest = sp.slice(2)
  if (rest.length < 3 || rest.length % 2 !== 1) return null
  const defaultVal = rest[0]
  const isValidPlacement = (v: unknown): v is 'point' | 'line' | 'line-center' =>
    v === 'point' || v === 'line' || v === 'line-center'
  if (!isValidPlacement(defaultVal)) return null
  // Build segments. Each step boundary z_i splits the zoom axis;
  // segment i has [z_i, z_{i+1}) range with placement v_i. Pre-step
  // (below z_1) uses the default.
  const breakpoints: Array<{ zoom: number; placement: 'point' | 'line' | 'line-center' }> = []
  for (let i = 1; i < rest.length; i += 2) {
    const z = rest[i]
    const v = rest[i + 1]
    if (typeof z !== 'number' || !isValidPlacement(v)) return null
    breakpoints.push({ zoom: z, placement: v })
  }
  const segments: Array<{ minzoom?: number; maxzoom?: number; placement: 'point' | 'line' | 'line-center' }> = []
  // Pre-step segment.
  segments.push({ maxzoom: breakpoints[0]!.zoom, placement: defaultVal })
  for (let i = 0; i < breakpoints.length; i++) {
    const start = breakpoints[i]!
    const end = breakpoints[i + 1]
    segments.push({
      minzoom: start.zoom,
      ...(end ? { maxzoom: end.zoom } : {}),
      placement: start.placement,
    })
  }
  // Collapse adjacent segments with identical placement (e.g. the
  // OFM `["step", ["zoom"], "point", 7, "line", 8, "line"]` case).
  const collapsed: typeof segments = []
  for (const seg of segments) {
    const prev = collapsed[collapsed.length - 1]
    if (prev && prev.placement === seg.placement && prev.maxzoom === seg.minzoom) {
      prev.maxzoom = seg.maxzoom
    } else {
      collapsed.push({ ...seg })
    }
  }
  return collapsed
}

/** Mapbox `circle` layer (Point/MultiPoint features rendered as
 *  SDF disks). The X-GIS runtime's PointRenderer is the natural
 *  destination — its default shape IS a circle, and it supports
 *  fill, stroke, opacity, and per-feature data-driven sizing.
 *
 *  Property mapping (paint):
 *    circle-radius        → `size-N`        (both interpret as RADIUS in CSS px;
 *                                            PointRenderer's `radius_px` reads
 *                                            the size attribute directly. Default 5
 *                                            per Mapbox spec, emitted when absent.)
 *    circle-color         → `fill-<color>`
 *    circle-opacity       → `opacity-N`     (Mapbox 0..1 → xgis 0..100, same
 *                                            scale-conversion `addOpacity` does)
 *    circle-stroke-color  → `stroke-<color>`
 *    circle-stroke-width  → `stroke-N`      (CSS px, single edge width)
 *
 *  Not yet honoured (warnings emitted): circle-blur, circle-translate
 *  + circle-translate-anchor, circle-pitch-scale, circle-pitch-alignment,
 *  circle-stroke-opacity (would need fold-into-stroke-alpha).
 */
function convertCircleLayer(layer: MapboxLayer, warnings: string[]): string {
  const paint = (layer as { paint?: Record<string, unknown> }).paint ?? {}
  const lines: string[] = [`layer ${sanitizeId(layer.id)} {`]
  if (layer.source) lines.push(`  source: ${sanitizeId(layer.source)}`)
  if (layer['source-layer']) lines.push(`  sourceLayer: "${layer['source-layer']}"`)
  if (typeof layer.minzoom === 'number') lines.push(`  minzoom: ${layer.minzoom}`)
  if (typeof layer.maxzoom === 'number') lines.push(`  maxzoom: ${layer.maxzoom}`)
  if (layer.filter !== undefined) {
    const f = filterToXgis(layer.filter, warnings)
    if (f) lines.push(`  filter: ${f}`)
  }

  const utils: string[] = []

  // circle-radius → size. Constant + interpolate-by-zoom + per-feature
  // expression all supported. Default 5 px per Mapbox spec — emit
  // explicitly so the runtime doesn't fall back to its own default (8).
  const radius = paint['circle-radius']
  if (typeof radius === 'number') {
    utils.push(`size-${radius}`)
  } else if (radius !== undefined) {
    const interp = interpolateZoomCall(radius, warnings,
      (val) => typeof val === 'number' ? String(val) : null)
    if (interp !== null) {
      utils.push(`size-[${interp}]`)
    } else {
      const expr = exprToXgis(radius, warnings)
      if (expr !== null) utils.push(`size-[${expr}]`)
      else utils.push('size-5')
    }
  } else {
    utils.push('size-5')
  }

  // circle-color → fill. Routes through the shared color emitters
  // (constant + interpolate-by-zoom + data-driven case/match).
  // Default Mapbox circle-color is #000.
  const fillColor = paint['circle-color']
  if (fillColor !== undefined) {
    const interp = interpolateZoomCall(fillColor, warnings, (val, w) => colorToXgis(val, w))
    if (interp !== null) {
      utils.push(`fill-[${interp}]`)
    } else {
      const c = colorToXgis(fillColor, warnings)
      if (c) utils.push(`fill-${c}`)
      else {
        const expr = exprToXgis(fillColor, warnings)
        if (expr !== null) utils.push(`fill-[${expr}]`)
        else utils.push('fill-#000')
      }
    }
  } else {
    utils.push('fill-#000')
  }

  // circle-opacity → opacity. Mapbox 0..1 → xgis 0..100 conversion
  // handled inside addOpacity helper; reuse it here.
  const opacity = paint['circle-opacity']
  if (opacity !== undefined) {
    // addOpacity pushes onto its `out` array; we splice into utils.
    const tmp: string[] = []
    // Lazy local re-route to addOpacity from paint.ts. We already have
    // the right helper imported indirectly through paintToUtilities;
    // but since circle isn't routed through paintToUtilities, inline
    // the same logic to keep import surface tight.
    if (typeof opacity === 'number') {
      tmp.push(`opacity-${opacity <= 1 ? Math.round(opacity * 100) : opacity}`)
    } else {
      const interp = interpolateZoomCall(opacity, warnings, (val) => {
        if (typeof val !== 'number') return null
        return String(val <= 1 ? Math.round(val * 100) : val)
      })
      if (interp !== null) {
        tmp.push(`opacity-[${interp}]`)
      } else {
        // Per-feature case/match opacity. Mirror the line-opacity path
        // in paint.ts:addOpacity — drop the binding into the bracket
        // form so the runtime PropertyShape resolver gets the full AST.
        const expr = exprToXgis(opacity, warnings)
        if (expr !== null) tmp.push(`opacity-[${expr}]`)
      }
    }
    utils.push(...tmp)
  }

  // circle-stroke-color → stroke. Constant + zoom-interp + per-feature
  // case/match — full set, mirroring circle-color above and the line
  // layer's line-color path. Without the data-driven fallback a
  // standalone `["match", ["get","class"], …]` stroke colour silently
  // dropped (same regression class as the line-color fix).
  const strokeColor = paint['circle-stroke-color']
  if (strokeColor !== undefined) {
    const interp = interpolateZoomCall(strokeColor, warnings, (val, w) => colorToXgis(val, w))
    if (interp !== null) {
      utils.push(`stroke-[${interp}]`)
    } else {
      const c = colorToXgis(strokeColor, warnings)
      if (c) {
        utils.push(`stroke-${c}`)
      } else {
        const expr = exprToXgis(strokeColor, warnings)
        if (expr !== null) utils.push(`stroke-[${expr}]`)
      }
    }
  }

  // circle-stroke-width → stroke-N. Edge width in CSS px.
  const strokeWidth = paint['circle-stroke-width']
  if (typeof strokeWidth === 'number' && strokeWidth > 0) {
    utils.push(`stroke-${strokeWidth}`)
  } else if (strokeWidth !== undefined) {
    const interp = interpolateZoomCall(strokeWidth, warnings,
      (val) => typeof val === 'number' ? String(val) : null)
    if (interp !== null) {
      utils.push(`stroke-[${interp}]`)
    } else {
      // Per-feature numeric expression (`case` / `match` / etc.) —
      // route through the bracket form the same way circle-radius does.
      // Without this branch a per-feature stroke-width silently dropped
      // and the circle's edge collapsed to zero.
      const expr = exprToXgis(strokeWidth, warnings)
      if (expr !== null) utils.push(`stroke-[${expr}]`)
    }
  }

  // Surface dropped properties so the user knows the gap. Includes
  // the layout/paint subset that the circle helper doesn't honour;
  // `circle-sort-key` (per-feature draw order) and
  // `visibility:none` (caller-route via the layer-level visible
  // property) belong here too.
  const ignored: string[] = []
  for (const k of [
    'circle-blur', 'circle-translate', 'circle-translate-anchor',
    'circle-pitch-scale', 'circle-pitch-alignment', 'circle-stroke-opacity',
    'circle-sort-key',
  ]) {
    if (paint[k] !== undefined) ignored.push(k)
  }
  const layoutForCircle = (layer as { layout?: Record<string, unknown> }).layout ?? {}
  if (layoutForCircle['circle-sort-key'] !== undefined) ignored.push('circle-sort-key (layout)')
  if (ignored.length > 0) {
    warnings.push(`Circle layer "${layer.id}" — ignored properties: ${ignored.join(', ')}`)
  }

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
          ? (typeof layer.minzoom === 'number' ? Math.max(layer.minzoom, seg.minzoom) : seg.minzoom)
          : layer.minzoom
        const maxzoom = seg.maxzoom !== undefined
          ? (typeof layer.maxzoom === 'number' ? Math.min(layer.maxzoom, seg.maxzoom) : seg.maxzoom)
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

  const lines: string[] = [`layer ${sanitizeId(layer.id)} {`]
  if (layer.source) lines.push(`  source: ${sanitizeId(layer.source)}`)
  if (layer['source-layer']) lines.push(`  sourceLayer: "${layer['source-layer']}"`)
  if (typeof layer.minzoom === 'number') lines.push(`  minzoom: ${layer.minzoom}`)
  if (typeof layer.maxzoom === 'number') lines.push(`  maxzoom: ${layer.maxzoom}`)
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
  const layout = (layer as { layout?: Record<string, unknown> }).layout ?? {}
  if (layout['visibility'] === 'none') {
    lines.push(`  visible: false`)
  }

  // Cap / join / miter-limit are emitted as UTILITIES (after the `|`)
  // since the xgis parser doesn't accept hyphenated names in the
  // CSS-style property position. Engine handles them via the utility
  // resolver (lower.ts:402-422).
  const layoutUtils: string[] = []
  if (layer.type === 'line') {
    const cap = layout['line-cap']
    if (cap === 'butt') layoutUtils.push('stroke-butt-cap')
    else if (cap === 'round') layoutUtils.push('stroke-round-cap')
    else if (cap === 'square') layoutUtils.push('stroke-square-cap')
    const join = layout['line-join']
    if (join === 'miter') layoutUtils.push('stroke-miter-join')
    else if (join === 'round') layoutUtils.push('stroke-round-join')
    else if (join === 'bevel') layoutUtils.push('stroke-bevel-join')
    const miter = layout['line-miter-limit']
    if (typeof miter === 'number') layoutUtils.push(`stroke-miterlimit-${miter}`)
  }

  const utils = [...layoutUtils, ...paintToUtilities(layer, warnings)]
  if (utils.length > 0) {
    lines.push('  | ' + utils.join(' '))
  }
  lines.push('}')
  return lines.join('\n')
}
