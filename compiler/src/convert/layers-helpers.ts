// ═══ Mapbox layer → xgis conversion: pure helpers ═══
// Side-effect-free helpers extracted from layers.ts. Each operates purely
// on its arguments and returns a value; none close over module mutable
// state. Kept here so layers.ts stays focused on the layer-emission logic.

import type { MapboxLayer } from './types'
import { exprToXgis, filterToXgis } from './expressions'

// ═══ Fail-CLOSED filter emission ═══
// Every layer converter that honours `layer.filter` shared this body:
//   if (layer.filter !== undefined) {
//     const f = filterToXgis(layer.filter, warnings)
//     if (f) lines.push(`  filter: ${f}`)
//   }
// The bug: when `layer.filter` IS authored but UNCONVERTIBLE (an op
// filterToXgis can't lower — e.g. `["within", polygon]`, `["distance",
// …]`), filterToXgis returns null, the `if (f)` gate skips the push,
// and the layer emits NO filter line → it renders EVERY feature. That
// is fail-OPEN: the exact opposite of the spec intent that an
// unsatisfiable / unknown predicate EXCLUDES features.
//
// Fix: fail CLOSED. An authored-but-unconvertible filter emits the
// literal `filter: false`, which both filter-eval paths (compiler
// `evaluate` BoolLiteral → false; runtime applyFilter / evalFilterExpr
// `typeof result === 'boolean' → return result`) resolve to "match
// nothing" → the layer draws zero features rather than all of them.
// filterToXgis still pushes its own "not supported" warning, so the
// loss stays surfaced.
//
// CRUCIAL distinction: filterToXgis ALSO returns null for a "no filter"
// value — a bare null/undefined OR a multi-wrapped `["literal", null]`
// (Mapbox spec: a null filter ACCEPTS every feature). Those must stay
// fail-OPEN (emit no filter line), NOT fail-closed. `isOmittedValue`
// already encodes exactly that wrapped-null detection, so we gate on it
// FIRST: an omitted/no-filter value returns null here (no filter line);
// only a genuinely-authored predicate that filterToXgis can't lower
// reaches the fail-closed `filter: false`.
export function filterLineOrFailClosed(filter: unknown, warnings: string[]): string | null {
  // No filter authored (bare or wrapped null) → accept all (no line).
  if (isOmittedValue(filter)) return null
  const f = filterToXgis(filter, warnings)
  // Convertible → emit the lowered filter. Unconvertible (null, with a
  // warning already pushed by filterToXgis) → fail closed.
  return `  filter: ${f ?? 'false'}`
}

// Mapbox v8 wraps inline arrays in `["literal", […]]`. Symbol-layer
// numeric-tuple knobs (text-offset, text-translate, icon-offset,
// text-variable-anchor-offset) all accept either the bare array OR
// the literal-wrapped form per the spec. Helper unwraps once so the
// downstream `Array.isArray + typeof number` checks work uniformly
// for both shapes — without it MapLibre-2-strict styles emitting
// `["literal", [0, -1.5]]` for text-offset get the offset silently
// dropped (outer length === 2 + offset[0] === "literal" fails the
// numeric check).
export function unwrapLiteralTuple(v: unknown): unknown {
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
export function unwrapLiteralScalar(v: unknown): unknown {
  // Loop unwrap so `["literal", ["literal", 16]]` (rare v8 strict
  // double-wrap) peels in one pass. Each iteration peels one layer
  // only when the inner is a bare scalar OR null — preserves the
  // existing behaviour on tuple wrappers (those route through
  // unwrapLiteralTuple) while letting wrapped-null bubble down so
  // downstream `!== null` gates fire as Mapbox-spec intends.
  while (
    Array.isArray(v) &&
    v.length === 2 &&
    v[0] === 'literal' &&
    (typeof v[1] === 'number' ||
      typeof v[1] === 'string' ||
      typeof v[1] === 'boolean' ||
      v[1] === null)
  ) {
    v = v[1]
  }
  // Handle the mixed case: `["literal", ["literal", 16]]` where the
  // outer's inner is itself a literal-array wrapper (which the scalar
  // gate above rejected). Peel once more if the inner is a 2-elt
  // literal whose payload is scalar. Loop bounded by structural depth.
  while (
    Array.isArray(v) &&
    v.length === 2 &&
    v[0] === 'literal' &&
    Array.isArray(v[1]) &&
    v[1].length === 2 &&
    v[1][0] === 'literal' &&
    (typeof v[1][1] === 'number' ||
      typeof v[1][1] === 'string' ||
      typeof v[1][1] === 'boolean' ||
      v[1][1] === null)
  ) {
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
export function applyAlphaMultiplier(colorStr: string, opacity: number | null): string {
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
  if ([r, g, b, a].some((v) => !Number.isFinite(v))) return colorStr
  const aOut = Math.max(0, Math.min(255, Math.round(a * opacity)))
  const hh = (n: number): string => n.toString(16).padStart(2, '0')
  return `#${hh(r)}${hh(g)}${hh(b)}${hh(aOut)}`
}

// text-anchor → label-anchor-X. Mapbox's 9-way anchor maps 1:1
// to the IR's 9-way LabelDef.anchor (render-node.ts:244-246).
// Shared between the static text-anchor / text-variable-anchor blocks
// and the text-variable-anchor-offset offset block in convertSymbolLayer.
export const VALID_ANCHORS = new Set([
  'center',
  'top',
  'bottom',
  'left',
  'right',
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
])

/** Format a signed number for a utility-name segment. Negative values
 *  use the bracket binding form `[<n>]` because the utility-name grammar
 *  treats `-` as a segment separator — emitting `label-offset-y--0.2`
 *  would lex as a malformed double-dash name. */
export const fmtSigned = (n: number): string => (n < 0 ? `[${n}]` : `${n}`)

// Per-element v8 literal-wrap unwrap so a double-wrap shape like
// `["literal", [["literal", 0], ["literal", -1.5]]]` resolves to
// [0, -1.5]. Outer unwrap above gave the inner array but each
// scalar may still be wrapped — pre-fix the typeof === 'number'
// gate failed and the offset silently dropped.
export const unwrapPairScalars = (t: unknown): unknown[] | null => {
  if (!Array.isArray(t) || t.length !== 2) return null
  return t.map((c) => {
    while (Array.isArray(c) && c.length === 2 && c[0] === 'literal') c = c[1]
    return c
  })
}

/** Coerce a (possibly malformed) layer.layout / layer.paint value to a
 *  plain Record. Mirror of paint.ts's same guard — non-object forms
 *  (string copy-paste, array, etc.) used to let property-name index
 *  return a char of the string or undefined, leaking garbage into
 *  the emitted utility list. */
export function safePropsBag(v: unknown): Record<string, unknown> {
  if (v === null || v === undefined) return {}
  if (typeof v !== 'object' || Array.isArray(v)) return {}
  return v as Record<string, unknown>
}

/** True when v should be treated as "property omitted" per Mapbox
 *  spec — bare null/undefined OR any depth of `["literal", … null]`
 *  wrap. Used by the layer-level paint accessor gates that previously
 *  checked only `!== undefined && !== null` (which let multi-wrapped
 *  nulls leak through to exprToXgis as the `null` identifier binding,
 *  emitting `fill-[null]` / `label-color-[null]` instead of falling
 *  to the property's spec default). Mirror of paint.ts:isOmitted
 *  (dd06a99). */
export function isOmittedValue(v: unknown): boolean {
  if (v === undefined || v === null) return true
  let cur: unknown = v
  while (Array.isArray(cur) && cur.length === 2 && cur[0] === 'literal') {
    cur = cur[1]
  }
  return cur === null || cur === undefined
}

/** Strip the Mapbox `["image", <name-expr>]` wrapper from an icon-image
 *  value. `image` produces a ResolvedImage from a sprite name; in the
 *  icon-image property context X-GIS resolves the name directly, so the
 *  wrapper is a compile-time identity — return the inner name expression
 *  (constant string or a data-driven expression). `image`'s runtime
 *  availability check (null when the sprite is absent) maps to X-GIS'
 *  missing-sprite = no-icon, so nothing is lost for icon-image.
 *
 *  Recurses so a nested `["image", …]` inside the coalesce / match / case
 *  arms of a data-driven icon-image — the common Mapbox POI shape
 *  `["coalesce", ["image", ["concat", …]], ["image", "marker_11"]]` — is
 *  stripped too. `["literal", …]` payloads are DATA, not an expression
 *  tree, so they are returned untouched. Applied ONLY to icon-image;
 *  text-inline `["format", …, ["image", …]]` spans keep the deferred
 *  format-partial-drop path (issue #777 I2 follow-up). */
export function unwrapImageExpr(v: unknown): unknown {
  if (!Array.isArray(v)) return v
  if (v.length === 2 && v[0] === 'image') return unwrapImageExpr(v[1])
  if (v[0] === 'literal') return v
  return v.map((el) => unwrapImageExpr(el))
}

/** Mapbox font-name trailing keywords → CSS font-weight numerics.
 *  Covers the standard 100..900 axis plus common aliases (Hairline,
 *  UltraLight, Heavy, …) used by font foundries. Matched as a single
 *  trailing token first; the two-word forms ("Extra Bold", "Semi
 *  Bold") get collapsed in `parseMapboxFontName` before lookup. */
const FONT_WEIGHT_KEYWORDS: Record<string, number> = {
  Thin: 100,
  Hairline: 100,
  ExtraLight: 200,
  UltraLight: 200,
  Light: 300,
  // Roman = PostScript / Adobe Type 1 convention for the regular weight
  // (e.g. "Times Roman"). Without this, the parser left "Roman" as
  // part of the family name and the browser failed to match a font.
  Regular: 400,
  Normal: 400,
  Book: 400,
  Roman: 400,
  Medium: 500,
  SemiBold: 600,
  DemiBold: 600,
  Bold: 700,
  ExtraBold: 800,
  UltraBold: 800,
  // CSS / OpenType convention: Heavy and Black both map to weight
  // 900 (the heaviest standard tier). Pre-fix Heavy was 800, which
  // matched no real foundry's naming — fonts shipped as "Roboto
  // Heavy" rendered one tier lighter than the author intended.
  Black: 900,
  Heavy: 900,
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
  const styleKeysLower = new Set([...FONT_STYLE_KEYWORDS].map((s) => s.toLowerCase()))
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
export function textFieldToXgisExpr(field: unknown, warnings: string[]): string | null {
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
        warnings.push(
          `text-field token "{${name}}" — colon-bearing locale variants fall back to "name". Use a base "{name}" for cross-style portability.`,
        )
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
    field !== null &&
    typeof field === 'object' &&
    Array.isArray((field as { stops?: unknown }).stops)
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
export function parseSymbolPlacementStep(layer: MapboxLayer): Array<{
  minzoom?: number
  maxzoom?: number
  placement: 'point' | 'line' | 'line-center'
}> | null {
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
  const segments: Array<{
    minzoom?: number
    maxzoom?: number
    placement: 'point' | 'line' | 'line-center'
  }> = []
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
