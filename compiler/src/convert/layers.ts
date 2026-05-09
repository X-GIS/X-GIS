import type { MapboxLayer } from './types'
import { sanitizeId } from './utils'
import { filterToXgis, exprToXgis } from './expressions'
import { paintToUtilities } from './paint'
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
 *  Three forms:
 *    - String literal `"Hello"` → quoted xgis string `"Hello"`
 *    - Token form `"{name}"` → field access `.name`
 *    - Expression form `["concat", ["get", "name"], …]` → exprToXgis
 *  Returns null if the value can't be converted (caller skips the
 *  whole label utility in that case). */
function textFieldToXgisExpr(field: unknown, warnings: string[]): string | null {
  if (typeof field === 'string') {
    const tokenMatch = field.match(/^\{([^}]+)\}$/)
    if (tokenMatch) return `.${tokenMatch[1]}`
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
  // text-color → fill (the layer's fill colour is reused as the
  // text colour by the renderer when no explicit text colour is
  // recorded on LabelDef — Batch 1c finalises the fallback rule).
  const textColor = paint['text-color']
  if (textColor !== undefined) {
    const colorStr = colorToXgis(textColor, warnings)
    if (colorStr) utils.push(`fill-${colorStr}`)
  }

  // Surface the rest as a warning so the user knows what's still
  // missing (text-size needs label-size-N, halo needs Batch 1c, etc.)
  const ignoredText: string[] = []
  for (const k of ['text-size', 'text-font', 'text-anchor', 'text-offset',
    'text-halo-color', 'text-halo-width', 'symbol-placement',
    'icon-image', 'icon-size', 'icon-color']) {
    if (layout[k] !== undefined || paint[k] !== undefined) ignoredText.push(k)
  }
  if (ignoredText.length > 0) {
    warnings.push(`Symbol layer "${layer.id}" — ignored properties (Batch 1c/1d/2): ${ignoredText.join(', ')}`)
  }

  warnings.push(`Symbol layer "${layer.id}" — text-field emitted as label utility; rendering arrives in Batch 1c.`)
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
