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
  circle: 'circle layer — use a point layer with shape: circle once point converter lands',
  heatmap: 'heatmap layer — Batch 3 (accumulation MRT + Gaussian blur)',
  hillshade: 'hillshade layer — Batch 4 (raster-dem + lighting shader)',
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
  return null
}

/** Symbol layer (Mapbox text labels + icons). Batch 1b emits text
 *  intent; Batch 1c wires the renderer; Batch 2 adds icons. For now,
 *  text-field becomes `label-[<expr>]` and text-color maps to a
 *  fill utility — the IR's `label?` field captures the rest. */
function convertSymbolLayer(layer: MapboxLayer, warnings: string[]): string {
  const layout = (layer as { layout?: Record<string, unknown> }).layout ?? {}
  const paint = (layer as { paint?: Record<string, unknown> }).paint ?? {}
  const textField = layout['text-field']

  if (textField === undefined) {
    // No text-field → likely icon-only symbol. Sprite atlas (Batch 2)
    // not yet here.
    warnings.push(`Symbol layer "${layer.id}" — icon-only (no text-field) — Batch 2 (sprite atlas).`)
    return `// SKIPPED layer "${layer.id}" type="symbol" — icon-only, awaits Batch 2 (sprite atlas).`
  }

  const labelExpr = textFieldToXgisExpr(textField, warnings)
  if (labelExpr === null) {
    warnings.push(`Symbol layer "${layer.id}" — text-field "${JSON.stringify(textField).slice(0, 60)}" not convertible.`)
    return `// SKIPPED layer "${layer.id}" type="symbol" — text-field expression not convertible.`
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
      if (colorStr) utils.push(`label-color-${colorStr}`)
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
      warnings.push(`Symbol layer "${layer.id}" — text-size expression form not converted: ${JSON.stringify(textSize).slice(0, 80)}`)
      // Fall back to Mapbox default so the layer still has SOME size.
      utils.push('label-size-16')
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
    }
  }
  const haloColor = paint['text-halo-color']
  if (haloColor !== undefined) {
    const interp = interpolateZoomCall(haloColor, warnings, (val, w) => colorToXgis(val, w))
    if (interp !== null) {
      utils.push(`label-halo-color-[${interp}]`)
    } else {
      const colorStr = colorToXgis(haloColor, warnings)
      if (colorStr) utils.push(`label-halo-color-${colorStr}`)
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
  const anchor = layout['text-anchor']
  if (typeof anchor === 'string' && VALID_ANCHORS.has(anchor)) {
    utils.push(`label-anchor-${anchor}`)
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

  // Collision controls (Batch 1e). text-padding accepts both constant
  // and interpolate-by-zoom in Mapbox.
  if (layout['text-allow-overlap'] === true) utils.push('label-allow-overlap')
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
  const placement = layout['symbol-placement']
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

  // text-font: ["Noto Sans Regular", "Noto Sans CJK Regular"] →
  // one `label-font-Noto-Sans-Regular` utility per stack entry,
  // appended in declaration order. The lower pass collects all
  // `label-font-*` utilities into a stack the runtime forwards
  // to ctx.font as a comma-separated CSS font value (browser-
  // native glyph-by-glyph fallback). Spaces in Mapbox font names
  // map to `-` since utility names only accept identifier chars.
  const fontStack = layout['text-font']
  if (Array.isArray(fontStack) && fontStack.length > 0) {
    for (const f of fontStack) {
      if (typeof f !== 'string' || f.length === 0) continue
      utils.push(`label-font-${f.replace(/\s+/g, '-')}`)
    }
  }

  // symbol-placement → label-along-path / label-line-center.
  // The runtime walks line geometry and emits one label per feature,
  // anchored at a segment midpoint with rotation matching the local
  // tangent. Roads, waterway names, highway shields all rely on this.
  // (`placement` already pulled above for the text-max-width default
  // gating — Mapbox disables wrap for line placement.)
  if (placement === 'line') utils.push('label-along-path')
  else if (placement === 'line-center') utils.push('label-line-center')

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
  const ignoredText: string[] = []
  for (const k of [
    'text-keep-upright', 'text-writing-mode',
    'icon-image', 'icon-size', 'icon-color']) {
    if (layout[k] !== undefined || paint[k] !== undefined) ignoredText.push(k)
  }
  if (ignoredText.length > 0) {
    warnings.push(`Symbol layer "${layer.id}" — ignored properties (Batch 1d/1e/2): ${ignoredText.join(', ')}`)
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
    return convertSymbolLayer(layer, warnings)
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
