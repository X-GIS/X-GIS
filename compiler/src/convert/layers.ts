import type { MapboxLayer } from './types'
import { sanitizeId } from './utils'
import { filterToXgis, exprToXgis } from './expressions'
import { paintToUtilities, interpolateZoomCall } from './paint'
import { colorToXgis } from './colors'

// Mapbox v8 wraps inline arrays in `["literal", […]]`. Symbol-layer
// numeric-tuple knobs (text-offset, text-translate, icon-offset,
// text-variable-anchor-offset) all accept either the bare array OR
// the literal-wrapped form per the spec. Helper unwraps once so the
// downstream `Array.isArray + typeof number` checks work uniformly
// for both shapes — without it MapLibre-2-strict styles emitting
// `["literal", [0, -1.5]]` for text-offset get the offset silently
// dropped (outer length === 2 + offset[0] === "literal" fails the
// numeric check).
function unwrapLiteralTuple(v: unknown): unknown {
  // Loop unwrap so `["literal", ["literal", [0, 1]]]` (rare v8 strict
  // double-wrap) peels in one pass. Mirror of colorToXgis (921d5ad).
  while (Array.isArray(v) && v.length === 2 && v[0] === 'literal' && Array.isArray(v[1])) {
    v = v[1]
  }
  return v
}

// Scalar-numeric sibling — `["literal", 16]` for text-size /
// text-halo-* / text-padding / icon-size etc. Same scope: covers the
// wrap pattern without changing the bare-numeric fast path. Mirror
// of paint.ts:unwrapLiteralNumeric from 240c5fb.
function unwrapLiteralScalar(v: unknown): unknown {
  // Loop unwrap so `["literal", ["literal", 16]]` (rare v8 strict
  // double-wrap) peels in one pass. Each iteration peels one layer
  // only when the inner is a bare scalar OR null — preserves the
  // existing behaviour on tuple wrappers (those route through
  // unwrapLiteralTuple) while letting wrapped-null bubble down so
  // downstream `!== null` gates fire as Mapbox-spec intends.
  while (Array.isArray(v) && v.length === 2 && v[0] === 'literal'
      && (typeof v[1] === 'number' || typeof v[1] === 'string'
          || typeof v[1] === 'boolean' || v[1] === null)) {
    v = v[1]
  }
  // Handle the mixed case: `["literal", ["literal", 16]]` where the
  // outer's inner is itself a literal-array wrapper (which the scalar
  // gate above rejected). Peel once more if the inner is a 2-elt
  // literal whose payload is scalar. Loop bounded by structural depth.
  while (Array.isArray(v) && v.length === 2 && v[0] === 'literal'
      && Array.isArray(v[1]) && v[1].length === 2 && v[1][0] === 'literal'
      && (typeof v[1][1] === 'number' || typeof v[1][1] === 'string'
          || typeof v[1][1] === 'boolean' || v[1][1] === null)) {
    v = v[1][1]
  }
  return v
}

/** Multiply a constant text-color hex's alpha channel by a 0..1
 *  text-opacity multiplier. Returns hex with explicit alpha
 *  (`#rrggbbaa`) when the result is < 1.0, else the original hex.
 *  Pure utility for the constant-only path; non-constant opacity
 *  routes still fall back to the legacy "ignored property" warning.
 *
 *  Accepts: `#rgb`, `#rrggbb`, `#rgba`, `#rrggbbaa`. Anything else
 *  passes through verbatim — colorToXgis owns the parse, so by the
 *  time we get here the format is normalised. */
function applyAlphaMultiplier(colorStr: string, opacity: number | null): string {
  if (opacity === null || opacity >= 1) return colorStr
  if (!colorStr.startsWith('#')) return colorStr
  let r: number, g: number, b: number, a: number
  const hex = colorStr.slice(1)
  if (hex.length === 3) {
    r = parseInt(hex[0]! + hex[0]!, 16)
    g = parseInt(hex[1]! + hex[1]!, 16)
    b = parseInt(hex[2]! + hex[2]!, 16)
    a = 255
  } else if (hex.length === 4) {
    r = parseInt(hex[0]! + hex[0]!, 16)
    g = parseInt(hex[1]! + hex[1]!, 16)
    b = parseInt(hex[2]! + hex[2]!, 16)
    a = parseInt(hex[3]! + hex[3]!, 16)
  } else if (hex.length === 6) {
    r = parseInt(hex.slice(0, 2), 16)
    g = parseInt(hex.slice(2, 4), 16)
    b = parseInt(hex.slice(4, 6), 16)
    a = 255
  } else if (hex.length === 8) {
    r = parseInt(hex.slice(0, 2), 16)
    g = parseInt(hex.slice(2, 4), 16)
    b = parseInt(hex.slice(4, 6), 16)
    a = parseInt(hex.slice(6, 8), 16)
  } else {
    return colorStr
  }
  if ([r, g, b, a].some(v => !Number.isFinite(v))) return colorStr
  const aOut = Math.max(0, Math.min(255, Math.round(a * opacity)))
  const hh = (n: number): string => n.toString(16).padStart(2, '0')
  return `#${hh(r)}${hh(g)}${hh(b)}${hh(aOut)}`
}

/** True when v should be treated as "property omitted" per Mapbox
 *  spec — bare null/undefined OR any depth of `["literal", … null]`
 *  wrap. Used by the layer-level paint accessor gates that previously
 *  checked only `!== undefined && !== null` (which let multi-wrapped
 *  nulls leak through to exprToXgis as the `null` identifier binding,
 *  emitting `fill-[null]` / `label-color-[null]` instead of falling
 *  to the property's spec default). Mirror of paint.ts:isOmitted
 *  (dd06a99). */
/** Coerce a (possibly malformed) layer.layout / layer.paint value to a
 *  plain Record. Mirror of paint.ts's same guard — non-object forms
 *  (string copy-paste, array, etc.) used to let property-name index
 *  return a char of the string or undefined, leaking garbage into
 *  the emitted utility list. */
function safePropsBag(v: unknown): Record<string, unknown> {
  if (v === null || v === undefined) return {}
  if (typeof v !== 'object' || Array.isArray(v)) return {}
  return v as Record<string, unknown>
}

function isOmittedValue(v: unknown): boolean {
  if (v === undefined || v === null) return true
  let cur: unknown = v
  while (Array.isArray(cur) && cur.length === 2 && cur[0] === 'literal') {
    cur = cur[1]
  }
  return cur === null || cur === undefined
}

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

/** Mapbox font-name trailing keywords → CSS font-weight numerics.
 *  Covers the standard 100..900 axis plus common aliases (Hairline,
 *  UltraLight, Heavy, …) used by font foundries. Matched as a single
 *  trailing token first; the two-word forms ("Extra Bold", "Semi
 *  Bold") get collapsed in `parseMapboxFontName` before lookup. */
const FONT_WEIGHT_KEYWORDS: Record<string, number> = {
  Thin: 100, Hairline: 100,
  ExtraLight: 200, UltraLight: 200,
  Light: 300,
  // Roman = PostScript / Adobe Type 1 convention for the regular weight
  // (e.g. "Times Roman"). Without this, the parser left "Roman" as
  // part of the family name and the browser failed to match a font.
  Regular: 400, Normal: 400, Book: 400, Roman: 400,
  Medium: 500,
  SemiBold: 600, DemiBold: 600,
  Bold: 700,
  ExtraBold: 800, UltraBold: 800,
  // CSS / OpenType convention: Heavy and Black both map to weight
  // 900 (the heaviest standard tier). Pre-fix Heavy was 800, which
  // matched no real foundry's naming — fonts shipped as "Roboto
  // Heavy" rendered one tier lighter than the author intended.
  Black: 900, Heavy: 900,
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
  const family = parts.join(' ')
  // Defensive: a degenerate input where every word is a weight /
  // style keyword (e.g. "Bold Italic" with no family token) would
  // leave family empty. Mapbox spec requires a family, but a host
  // could feed malformed data; preserve the original name as
  // family + drop the parsed weight/style so downstream font
  // loaders get a non-empty key. Without this guard the empty
  // family kicked the system font fallback (browser default sans-
  // serif) for every label using the malformed name.
  if (family === '') {
    return { family: name.trim() }
  }
  return {
    family,
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
  // Numeric / boolean text-field values are stringified by the
  // runtime per Mapbox spec — emit them as the matching xgis literal
  // so the lower pass + text resolver see the same scalar form.
  // Pre-fix any non-string non-array text-field (e.g. 42) fell to
  // the null return and the whole symbol layer dropped.
  if (typeof field === 'number' || typeof field === 'boolean') {
    return String(field)
  }
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
  const fmtSigned = (n: number): string => n < 0 ? `[${n}]` : `${n}`
  // Per-element v8 literal-wrap unwrap so a double-wrap shape like
  // `["literal", [["literal", 0], ["literal", -1.5]]]` resolves to
  // [0, -1.5]. Outer unwrap above gave the inner array but each
  // scalar may still be wrapped — pre-fix the typeof === 'number'
  // gate failed and the offset silently dropped.
  const unwrapPairScalars = (t: unknown): unknown[] | null => {
    if (!Array.isArray(t) || t.length !== 2) return null
    return t.map(c => {
      while (Array.isArray(c) && c.length === 2 && c[0] === 'literal') c = c[1]
      return c
    })
  }
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
  // fragment. Constant form emits a utility the runtime threads
  // through IconStage.addIcon → vertex attribute. Default 1 leaves
  // the utility off (no-op). Zoom-interp / data-driven defer to a
  // future paint-shape extension; for now non-constant warns via
  // the ignoredText loop below.
  const iconOpacity = unwrapLiteralScalar(paint['icon-opacity'])
  if (typeof iconOpacity === 'number' && Number.isFinite(iconOpacity) && iconOpacity !== 1) {
    utils.push(`label-icon-opacity-${Math.max(0, Math.min(1, iconOpacity))}`)
  } else if (iconOpacity !== undefined && iconOpacity !== null && typeof iconOpacity !== 'number') {
    // Non-constant icon-opacity (zoom interp / data-driven) — would
    // need per-frame / per-feature alpha threading through IconStage.
    // Deferred; warn so the lossy layer count reflects reality.
    warnings.push(`Symbol layer "${layer.id}" — icon-opacity non-constant form not yet supported.`)
  }

  // icon-color: SDF icon tint — Mapbox spec multiplies the sampled
  // texel by an authored colour for SDF sprites (used by highway-
  // shield colour variations etc.). X-GIS' IconStage today emits
  // un-tinted PNG sprite texels; SDF tint needs a vertex-attribute
  // color + fragment tint multiply (Plan §4 deferred). Surface a
  // specific gap warning rather than burying icon-color in the
  // generic ignoredText blob — mirror of the iter 14-17 pattern
  // for line-gradient / fill-pattern / line-pattern.
  if (paint['icon-color'] !== undefined && paint['icon-color'] !== null) {
    warnings.push(`Symbol layer "${layer.id}" — icon-color set but X-GIS' IconStage doesn't yet tint SDF sprites (Plan §4 deferred — needs per-vertex tint attribute + fragment multiply). Icon renders with the atlas texel verbatim.`)
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
    'text-opacity',          // Per-property fade; text uses layer opacity today
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
      // text-opacity constant form is folded into label-color's alpha
      // channel above (applyAlphaMultiplier). Skip the warning for the
      // constant-numeric case; non-constant text-opacity (zoom interp
      // / data-driven) still warns because the alpha multiplier path
      // can't carry it without a dedicated paint shape.
      if (k === 'text-opacity') {
        const v = pv ?? lv
        const unwrapped = unwrapLiteralScalar(v)
        if (typeof unwrapped === 'number' && Number.isFinite(unwrapped)) continue
      }
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
  const layout = safePropsBag((layer as { layout?: unknown }).layout)
  const sp = layout['symbol-placement']
  if (!Array.isArray(sp) || sp[0] !== 'step') return null
  const input = sp[1]
  if (!Array.isArray(input) || input[0] !== 'zoom') return null
  // ["step", ["zoom"], default, z1, v1, z2, v2, …]
  // Args after the input: default + N (zoom, value) pairs.
  const rest = sp.slice(2)
  if (rest.length < 3 || rest.length % 2 !== 1) return null
  // v8 strict tooling may emit `["literal", "point"]` for each step
  // value; unwrap at the validity check so both bare and wrapped
  // shapes feed the same code path.
  const defaultVal = unwrapLiteralScalar(rest[0])
  const isValidPlacement = (v: unknown): v is 'point' | 'line' | 'line-center' =>
    v === 'point' || v === 'line' || v === 'line-center'
  if (!isValidPlacement(defaultVal)) return null
  // Build segments. Each step boundary z_i splits the zoom axis;
  // segment i has [z_i, z_{i+1}) range with placement v_i. Pre-step
  // (below z_1) uses the default.
  const breakpoints: Array<{ zoom: number; placement: 'point' | 'line' | 'line-center' }> = []
  for (let i = 1; i < rest.length; i += 2) {
    // Unwrap v8 strict `["literal", N]` on the zoom key (mirror of the
    // unwrap on the placement value below). Pre-fix a wrapped zoom key
    // failed the typeof === 'number' gate and parseSymbolPlacementStep
    // returned null, collapsing the step expansion to a single fallback
    // layer with the default placement (line-shield labels lost their
    // zoom-driven point/line-center split).
    const z = unwrapLiteralScalar(rest[i])
    const v = unwrapLiteralScalar(rest[i + 1])
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
  const paint = safePropsBag((layer as { paint?: unknown }).paint)
  const layout = safePropsBag((layer as { layout?: unknown }).layout)
  const lines: string[] = [`layer ${sanitizeId(layer.id)} {`]
  if (layer.source) lines.push(`  source: ${sanitizeId(layer.source)}`)
  if (layer['source-layer']) lines.push(`  sourceLayer: ${JSON.stringify(layer['source-layer'])}`)
  if (typeof layer.minzoom === 'number' && Number.isFinite(layer.minzoom)) lines.push(`  minzoom: ${layer.minzoom}`)
  if (typeof layer.maxzoom === 'number' && Number.isFinite(layer.maxzoom)) lines.push(`  maxzoom: ${layer.maxzoom}`)
  if (layer.filter !== undefined) {
    const f = filterToXgis(layer.filter, warnings)
    if (f) lines.push(`  filter: ${f}`)
  }
  // `layout.visibility: 'none'` applies to circle layers per spec.
  // Same gap as convertSymbolLayer — without this a hidden circle
  // layer kept rendering. Mirror the v8 literal-wrap unwrap.
  const circleVisibility = unwrapLiteralScalar(layout['visibility'])
  if (circleVisibility === 'none') {
    lines.push(`  visible: false`)
  } else if (typeof circleVisibility === 'string' && circleVisibility !== 'visible') {
    // Same enum validation as symbol layer — typo'd visibility value
    // silently treated as default 'visible'.
    warnings.push(`Circle layer "${layer.id}" — visibility "${circleVisibility.slice(0, 40)}" is not a valid enum; expected 'visible' | 'none'.`)
  }

  const utils: string[] = []

  // circle-radius → size. Constant + interpolate-by-zoom + per-feature
  // expression all supported. Default 5 px per Mapbox spec — emit
  // explicitly so the runtime doesn't fall back to its own default (8).
  const radius = unwrapLiteralScalar(paint['circle-radius'])
  if (typeof radius === 'number' && Number.isFinite(radius)) {
    // Mapbox spec: circle-radius >= 0. Clamp at convert time;
    // Number.isFinite rejects NaN / Infinity (see paint NaN fix).
    // same class as the other paint-numeric clamps. `size--5`
    // would lex as double-dash and crash the layer.
    if (radius < 0) {
      warnings.push(`Circle layer "${layer.id}" — circle-radius ${radius} is negative; Mapbox spec requires >= 0. Clamped to 0 (circles won't render).`)
    }
    utils.push(`size-${Math.max(0, radius)}`)
  } else if (radius !== undefined && radius !== null) {
    const interp = interpolateZoomCall(radius, warnings,
      (val) => typeof val === 'number' && Number.isFinite(val) ? String(Math.max(0, val)) : null)
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
  // Default Mapbox circle-color is #000. Treat `null` the same as
  // `undefined` (omit) — Mapbox spec: a null paint value falls back
  // to the property default. Pre-fix `null` flowed through the
  // emission path, lowered to a bracket-binding with the `null`
  // identifier, and the runtime resolved it to no-fill instead of
  // the spec default #000.
  const fillColor = paint['circle-color']
  if (!isOmittedValue(fillColor)) {
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
  // handled inside addOpacity helper; reuse it here. Same null-as-
  // omit treatment as the other paint properties.
  const opacity = unwrapLiteralScalar(paint['circle-opacity'])
  if (opacity !== undefined && opacity !== null) {
    // addOpacity pushes onto its `out` array; we splice into utils.
    const tmp: string[] = []
    // Lazy local re-route to addOpacity from paint.ts. We already have
    // the right helper imported indirectly through paintToUtilities;
    // but since circle isn't routed through paintToUtilities, inline
    // the same logic to keep import surface tight.
    if (typeof opacity === 'number' && Number.isFinite(opacity)) {
      // Mapbox spec: opacity ∈ [0, 1]. Clamp at convert time;
      // same class as the addOpacity clamp (dc0e32a).
      // Number.isFinite rejects NaN/Infinity (see paint NaN fix).
      const clamped = Math.max(0, Math.min(1, opacity <= 1 ? opacity : opacity / 100))
      tmp.push(`opacity-${Math.round(clamped * 100)}`)
    } else {
      const interp = interpolateZoomCall(opacity, warnings, (val) => {
        if (typeof val !== 'number') return null
        const clamped = Math.max(0, Math.min(1, val <= 1 ? val : val / 100))
        return String(Math.round(clamped * 100))
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
  // Same null-as-omit treatment as circle-color above.
  //
  // circle-stroke-opacity (Mapbox spec) folds into stroke-colour alpha
  // when both are constant. Plan §4: stops short of a dedicated paint
  // shape so non-constant opacity still warns + drops below. Constant
  // alpha multiplication keeps the common case (e.g. `0.5`-alpha
  // outline rings) correct without a per-frame uniform.
  const strokeColor = paint['circle-stroke-color']
  const strokeOpacityRaw = unwrapLiteralScalar(paint['circle-stroke-opacity'])
  const strokeOpacityConst =
    typeof strokeOpacityRaw === 'number' && Number.isFinite(strokeOpacityRaw)
      ? Math.max(0, Math.min(1, strokeOpacityRaw))
      : null
  if (!isOmittedValue(strokeColor)) {
    const interp = interpolateZoomCall(strokeColor, warnings, (val, w) => colorToXgis(val, w))
    if (interp !== null) {
      utils.push(`stroke-[${interp}]`)
    } else {
      const c = colorToXgis(strokeColor, warnings)
      if (c) {
        // Fold constant stroke-opacity into the hex alpha channel
        // when present. resolveColor already supports the 8-char
        // hex form with alpha; convert opacity to a u8 alpha and
        // append. Skip when no opacity declared (1.0 default ==
        // 6-char hex stays).
        if (strokeOpacityConst !== null && strokeOpacityConst < 0.999) {
          // c is `#rrggbb` or `#rrggbbaa`. Replace alpha byte.
          const baseAlpha = c.length === 9
            ? parseInt(c.slice(7, 9), 16) / 255
            : 1
          const a = Math.round(baseAlpha * strokeOpacityConst * 255)
          const aHex = a.toString(16).padStart(2, '0')
          const rgb = c.slice(0, 7) // `#rrggbb`
          utils.push(`stroke-${rgb}${aHex}`)
        } else {
          utils.push(`stroke-${c}`)
        }
      } else {
        const expr = exprToXgis(strokeColor, warnings)
        if (expr !== null) utils.push(`stroke-[${expr}]`)
      }
    }
  }

  // circle-stroke-width → stroke-N. Edge width in CSS px.
  // Spec: circle-stroke-width >= 0. Constant arm has a `> 0` gate
  // that already drops negatives; the interp-zoom callback clamps
  // per-stop to avoid double-dash utility names.
  const strokeWidth = unwrapLiteralScalar(paint['circle-stroke-width'])
  if (typeof strokeWidth === 'number' && Number.isFinite(strokeWidth)) {
    // Negative + zero both mean "no stroke" — skip utility emission.
    // Number.isFinite rejects NaN / Infinity.
    // Pre-fix a negative number fell through the `> 0` gate into the
    // else-if interp/expr branch and emitted `stroke-[-5]` as a
    // bracket binding.
    if (strokeWidth < 0) {
      warnings.push(`Circle layer "${layer.id}" — circle-stroke-width ${strokeWidth} is negative; Mapbox spec requires >= 0. Skipped (no stroke).`)
    }
    if (strokeWidth > 0) utils.push(`stroke-${strokeWidth}`)
  } else if (strokeWidth !== undefined && strokeWidth !== null) {
    const interp = interpolateZoomCall(strokeWidth, warnings,
      (val) => typeof val === 'number' && Number.isFinite(val) ? String(Math.max(0, val)) : null)
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
  //
  // circle-translate gets the same specific gap warning as
  // line-translate / fill-extrusion-translate — its absence is
  // because the point-renderer has no per-frame translate uniform
  // yet, NOT because the property is silently dropped. Surface
  // outside the generic ignored-properties blob.
  if (paint['circle-translate'] !== undefined && paint['circle-translate'] !== null) {
    warnings.push(`Layer "${layer.id}" — circle-translate set but the point renderer has no per-frame translate uniform yet (Plan §4 deferred — mirror of fill-translate's u.fill_translate_x/y); offset is dropped.`)
  }
  // circle-blur: soft edge for circles (CSS-px feathering). Point-
  // renderer fragment uses a smoothstep AA already but doesn't expand
  // by an authored blur width — needs a per-feature blur attr + wider
  // quad (Plan §4 deferred). Surface specific gap.
  if (paint['circle-blur'] !== undefined && paint['circle-blur'] !== null) {
    warnings.push(`Layer "${layer.id}" — circle-blur set but X-GIS' point renderer has no per-feature blur attribute yet (Plan §4 deferred — needs vertex blur attr + wider quad). Circles render with the fixed AA smoothstep.`)
  }
  const ignored: string[] = []
  for (const k of [
    // circle-blur: specific gap warning (iter 99)
    'circle-translate-anchor',
    'circle-pitch-scale', 'circle-pitch-alignment',
    // circle-stroke-opacity: only the constant form folds into stroke
    // hex alpha above. Zoom-interp / data-driven still surface as
    // ignored so the user sees the gap. Check the unwrapped value
    // shape — if it's a scalar number we handled it; otherwise warn.
    ...(typeof strokeOpacityRaw === 'object' && strokeOpacityRaw !== null
      ? ['circle-stroke-opacity']
      : []),
    'circle-sort-key',
  ]) {
    // Treat null the same as undefined — see the symbol-ignored
    // gate above for the rationale.
    const pv = paint[k]
    if (pv === undefined || pv === null) continue
    // Special-case circle-translate-anchor: when parent
    // circle-translate is ABSENT, the anchor is a no-op (anchor only
    // changes the translate's coordinate space). Skip the warning
    // in that case — mirror of the surfaceIgnoredPaint ANCHOR_PARENT
    // check for fill / line equivalents.
    if (k === 'circle-translate-anchor'
        && (paint['circle-translate'] === undefined || paint['circle-translate'] === null)) {
      continue
    }
    // circle-translate-anchor='viewport' matches X-GIS behaviour
    // (viewport-space translate); only 'map' is the real gap. Mirror
    // of the SPEC_DEFAULT_NO_WARN suppression in surfaceIgnoredPaint.
    if (k === 'circle-translate-anchor') {
      let av: unknown = pv
      while (Array.isArray(av) && av.length === 2 && av[0] === 'literal') av = av[1]
      if (av === 'viewport') continue
    }
    // circle-pitch-alignment='viewport' (Mapbox spec default) matches
    // X-GIS billboard-rendering default; 'map' (project disc onto
    // ground plane) is the real gap.
    if (k === 'circle-pitch-alignment') {
      let av: unknown = pv
      while (Array.isArray(av) && av.length === 2 && av[0] === 'literal') av = av[1]
      if (av === 'viewport' || av === 'auto') continue
    }
    // circle-pitch-scale='viewport' matches X-GIS (radius stays
    // constant on screen). 'map' (Mapbox spec default — radius
    // scales with zoom in map space) is the real gap.
    if (k === 'circle-pitch-scale') {
      let av: unknown = pv
      while (Array.isArray(av) && av.length === 2 && av[0] === 'literal') av = av[1]
      if (av === 'viewport') continue
    }
    ignored.push(k)
  }
  // Reuse the safePropsBag-guarded `layout` const from the top of
  // this function — a malformed layer with `layout: "..."` (string)
  // or `layout: [..]` (array) would otherwise let the raw read of
  // layer.layout index a char or undefined, and the ignored-prop
  // warning would garbage-output. Treat null the same as undefined
  // per Mapbox spec — null means "property omitted".
  const lsk = layout['circle-sort-key']
  if (lsk !== undefined && lsk !== null) ignored.push('circle-sort-key (layout)')
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
