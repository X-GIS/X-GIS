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

  // text-color → label-color-X (Batch 1c-8g). The runtime falls
  // back to the layer's `fill` colour when label-color is unset, so
  // emitting label-color explicitly guarantees the user-intended
  // text colour even on layers that share fill/stroke with the
  // underlying point/polygon.
  const textColor = paint['text-color']
  if (textColor !== undefined) {
    const colorStr = colorToXgis(textColor, warnings)
    if (colorStr) utils.push(`label-color-${colorStr}`)
  }

  // text-size (constant only — interpolate stops + zoom-driven
  // sizing fold in once 1c-8h adds zoom-interpolated label sizes).
  const textSize = layout['text-size']
  if (typeof textSize === 'number') {
    utils.push(`label-size-${textSize}`)
  } else if (textSize !== undefined) {
    warnings.push(`Symbol layer "${layer.id}" — text-size expression form not yet converted (Batch 1c-8h).`)
  }

  // text-halo-width / text-halo-color → label-halo-N + label-halo-color-X.
  const haloWidth = paint['text-halo-width']
  if (typeof haloWidth === 'number' && haloWidth > 0) {
    utils.push(`label-halo-${haloWidth}`)
  }
  const haloColor = paint['text-halo-color']
  if (haloColor !== undefined) {
    const colorStr = colorToXgis(haloColor, warnings)
    if (colorStr) utils.push(`label-halo-color-${colorStr}`)
  }

  // text-anchor → label-anchor-X. Mapbox's 9-way anchor (top-left,
  // bottom-right, etc.) collapses to the 5-way set the IR currently
  // exposes (1d expands to the full set when anchor matters for
  // along-path placement); diagonal anchors map to the dominant axis.
  const anchorMap: Record<string, string> = {
    'center': 'center',
    'top': 'top', 'bottom': 'bottom',
    'left': 'left', 'right': 'right',
    'top-left': 'top', 'top-right': 'top',
    'bottom-left': 'bottom', 'bottom-right': 'bottom',
  }
  const anchor = layout['text-anchor']
  if (typeof anchor === 'string' && anchorMap[anchor]) {
    utils.push(`label-anchor-${anchorMap[anchor]}`)
  }

  // text-transform → label-uppercase / lowercase / none.
  const transform = layout['text-transform']
  if (transform === 'uppercase' || transform === 'lowercase' || transform === 'none') {
    utils.push(`label-${transform}`)
  }

  // text-offset → label-offset-x-N + label-offset-y-N (em-units).
  // Mapbox shape: [number, number]. Constant only — interpolate /
  // expression forms wait until the binding-bracket utility lands.
  const offset = layout['text-offset']
  if (Array.isArray(offset) && offset.length === 2
      && typeof offset[0] === 'number' && typeof offset[1] === 'number') {
    if (offset[0] !== 0) utils.push(`label-offset-x-${offset[0]}`)
    if (offset[1] !== 0) utils.push(`label-offset-y-${offset[1]}`)
  }

  // What's STILL not converted — surface a precise warning so the
  // user knows which Batch the gap waits on.
  const ignoredText: string[] = []
  for (const k of ['text-font', 'text-rotate',
    'text-letter-spacing', 'text-line-height', 'text-max-width',
    'text-justify', 'text-padding', 'text-allow-overlap',
    'text-ignore-placement', 'text-keep-upright', 'text-writing-mode',
    'symbol-placement', 'symbol-spacing',
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
