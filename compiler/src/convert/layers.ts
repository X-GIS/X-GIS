import type { MapboxLayer } from './types'
import { LAYER_CONVERTERS } from './layer-converters'
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
  sky: 'sky layer — gradient/atmospheric sky rendering not yet wired (would need a dome quad + per-fragment hue interpolation)',
}

/** Mapbox `layers[i]` entry → xgis `layer <id> { … }` block, or
 *  null when the layer is the top-level `background` (handled
 *  specially by `convertMapboxStyle`).
 *
 *  Dispatch authority (A4 registry): each emitting layer type
 *  (symbol / circle / fill / line / fill-extrusion / raster / heatmap)
 *  self-registers a converter in `LAYER_CONVERTERS`; a registry hit returns
 *  its output directly. A miss (hillshade / sky / unknown / missing /
 *  non-string type) falls through to the SKIP_REASONS + type-validation
 *  path below — the same order as the former branch chain, so the emitted
 *  blocks and warnings are byte-identical.
 *
 *  Skipped layer types emit a `// SKIPPED` comment that NAMES the
 *  roadmap batch they're waiting on — so users reading the output
 *  know whether the gap is permanent or coming. */
export function convertLayer(layer: MapboxLayer, warnings: string[]): string | null {
  const converter = LAYER_CONVERTERS.get(layer.type as string)
  if (converter !== undefined) {
    return converter(layer, warnings)
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
    'fill',
    'line',
    'fill-extrusion',
    'raster',
    'symbol',
    'circle',
    'background',
    'heatmap',
    'hillshade',
  ])
  if (layer.type === undefined || layer.type === null) {
    warnings.push(
      `Layer "${(layer as { id?: unknown }).id ?? '<unknown>'}" is missing the required type field; emitted SKIPPED placeholder.`,
    )
    return `// SKIPPED layer "${(layer as { id?: unknown }).id ?? '<unknown>'}" — missing required type field.`
  }
  if (typeof layer.type !== 'string') {
    warnings.push(
      `Layer "${(layer as { id?: unknown }).id ?? '<unknown>'}" type field must be a string (got ${typeof layer.type}); emitted SKIPPED placeholder.`,
    )
    return `// SKIPPED layer "${(layer as { id?: unknown }).id ?? '<unknown>'}" — non-string type field.`
  }
  if (!knownLayerTypes.has(layer.type)) {
    warnings.push(
      `Layer "${layer.id}" has unknown type "${layer.type}"; emitted SKIPPED placeholder. Mapbox spec layer types: fill, line, fill-extrusion, raster, symbol, circle, background, heatmap, hillshade.`,
    )
    return `// SKIPPED layer "${layer.id}" type="${layer.type}" — unknown layer type.`
  }

  // A known type with no registered converter would reach here. Today
  // the only such type is `background`, which convertMapboxStyle
  // handles before calling convertLayer and therefore never arrives.
  return null
}
