// ═══ Mapbox Style → xgis Source Converter ═══
//
// Top-level entry. The conversion is split into siblings so this
// file stays a single page — each sibling owns one well-scoped
// concern that the others import:
//
//   types.ts       — Mapbox style spec subset (MapboxStyle / Source /
//                    Layer interfaces)
//   sources.ts     — convertSource: vector → pmtiles / tilejson,
//                    raster, geojson
//   layers.ts      — convertLayer: skips symbol / circle / heatmap,
//                    emits fill / line / fill-extrusion bodies
//   paint.ts       — paintToUtilities + per-property emitters +
//                    interpolate-by-zoom helper
//   colors.ts      — colorToXgis: hex / CSS function / Mapbox tuple
//   expressions.ts — exprToXgis (Mapbox v1 expression form),
//                    matchToBooleanFilter, matchToTernary,
//                    filterToXgis (legacy + expression form)
//   utils.ts       — sanitizeId / maybeBracket / parenthesize
//
// Public API (re-exports below) is intentionally narrow:
// `convertMapboxStyle` plus the three Mapbox type names.
//
// Coverage summary:
//   • Sources: vector (PMTiles auto, TileJSON otherwise), raster,
//     geojson (URL only).
//   • Layer types: background, fill, line, fill-extrusion.
//   • Common paint properties: fill-color/-opacity, line-color/
//     -width/-dasharray/-opacity, fill-extrusion-color/-opacity/
//     -height/-base.
//   • Filters: legacy + expression form (==, !=, <, <=, >, >=,
//     all, any, in, !in, has, !has, geometry-type / id stripped).
//   • Expressions: literal, get, coalesce, case, match, arithmetic,
//     min, max, to-number, interpolate-by-zoom.
//
// Not yet covered (warnings emitted in the trailing notes block):
//   • Symbol layers (text + icon) — the engine doesn't render text.
//   • Circle / heatmap / hillshade layers.
//   • Sprite atlas, fill-pattern, line-pattern (bitmap atlases).
//   • interpolate curve type (exponential, cubic-bezier) — folded
//     to linear.
//   • Top-level light / fog / terrain.

import type { MapboxStyle, MapboxLayer } from './types'
import { convertSource, type ConvertSourceOptions } from './sources'
import { convertLayer } from './layers'
import { colorToXgis } from './colors'
import { expandPerFeatureColorMatch } from './expand-color-match'

/** Per-source record emitted into the optional `coverage` collector.
 *  `reasons` holds warnings pushed during that source's conversion
 *  (sliced from the shared `warnings` array). `action` is derived from
 *  the converter's output, not from a separate signal — so the record
 *  reflects what actually happened. */
export interface SourceCoverage {
  id: string
  type: string
  action: 'converted' | 'skipped' | 'lossy'
  reasons: string[]
}

/** Per-layer record emitted into the optional `coverage` collector.
 *  Action derivation:
 *   - `'skipped'`: layer body is a `// SKIPPED` comment (heatmap,
 *     hillshade — types in SKIP_REASONS, or future unsupported types)
 *   - `'lossy'`: layer converted but the run pushed at least one
 *     warning attributing to this layer (e.g. ignored paint props,
 *     symbol with non-convertible text-field, circle with extra props)
 *   - `'converted'`: layer body emitted with zero new warnings */
export interface LayerCoverage {
  layerId: string
  type: string
  action: 'converted' | 'skipped' | 'lossy'
  reasons: string[]
}

/** Full per-style coverage record. Pass an empty `StyleCoverage` in
 *  via `ConvertMapboxStyleOptions.coverage`; the converter populates
 *  it in place. The returned xgis string is byte-identical to the
 *  no-collector call — coverage is observation, not transformation. */
export interface StyleCoverage {
  sources: SourceCoverage[]
  layers: LayerCoverage[]
  warnings: string[]
}

export interface ConvertMapboxStyleOptions extends ConvertSourceOptions {
  /** When provided, the converter populates this collector with
   *  per-source / per-layer coverage records derived from the
   *  conversion run. Backwards-compatible — omit for the existing
   *  string-only return contract. */
  coverage?: StyleCoverage
}

/** Convert a Mapbox Style JSON (already parsed or raw string) into
 *  an xgis source string. The result is meant to be human-readable
 *  and immediately runnable against the X-GIS playground.
 *
 *  Pass `options.inlineGeoJSON` (a `Map`) to capture any inline
 *  `source.data` objects — the runtime importer uses this to
 *  auto-push the data via `setSourceData` after `run()` so the host
 *  never has to. Without the collector the inline data is dropped
 *  (with a warning) — backwards-compatible with pre-collector callers. */
export function convertMapboxStyle(
  input: string | MapboxStyle,
  options?: ConvertMapboxStyleOptions,
): string {
  const style: MapboxStyle = typeof input === 'string' ? JSON.parse(input) : input
  const lines: string[] = []
  const warnings: string[] = []

  if (style.name) {
    lines.push(`/* Converted from Mapbox style: "${style.name}" */`)
    lines.push('')
  }

  // ── Sources ────────────────────────────────────────────────────────
  for (const [id, src] of Object.entries(style.sources ?? {})) {
    const before = warnings.length
    const block = convertSource(id, src, warnings, options)
    lines.push(block)
    lines.push('')
    if (options?.coverage) {
      const reasons = warnings.slice(before)
      options.coverage.sources.push({
        id,
        type: src.type,
        action: block.includes('// SKIPPED') ? 'skipped'
          : reasons.length > 0 ? 'lossy' : 'converted',
        reasons,
      })
    }
  }

  // ── Background layer (Mapbox `background` type) ────────────────────
  // X-GIS has a top-level `background { fill: <color> }` directive
  // rather than a layer with `paint.background-color`.
  const bgLayer = (style.layers ?? []).find(l => l.type === 'background')
  if (bgLayer) {
    const before = warnings.length
    const color = bgLayer.paint?.['background-color']
    const colorStr = colorToXgis(color, warnings)
    if (colorStr) {
      lines.push(`background { fill: ${colorStr} }`)
      lines.push('')
    }
    if (options?.coverage) {
      const reasons = warnings.slice(before)
      options.coverage.layers.push({
        layerId: bgLayer.id,
        type: 'background',
        action: colorStr ? (reasons.length > 0 ? 'lossy' : 'converted') : 'skipped',
        reasons,
      })
    }
  }

  // ── Layers ─────────────────────────────────────────────────────────
  for (const layer of style.layers ?? []) {
    if (layer.type === 'background') continue // handled above
    const before = warnings.length
    // Preprocess: a `fill-color: ["match", ["get", field], …]` with
    // many distinct constant colours (typical "one colour per country"
    // basemap pattern — MapLibre demotiles is the canonical case)
    // would otherwise collapse to a single default colour at lower.ts.
    // Split the layer into one sublayer per unique colour with a
    // value-set filter, so each colour renders correctly without any
    // runtime per-feature support.
    const expanded = expandPerFeatureColorMatch(layer as MapboxLayer)
    const sublayers = expanded ?? [layer as MapboxLayer]
    let anyEmitted = false
    let anyLossy = false
    for (const sub of sublayers) {
      const block = convertLayer(sub, warnings)
      if (block) {
        lines.push(block)
        lines.push('')
        anyEmitted = true
        if (/^\s*\/\/ SKIPPED/.test(block)) anyLossy = true
      }
    }
    if (options?.coverage) {
      const reasons = warnings.slice(before)
      const isSkipped = !anyEmitted
      options.coverage.layers.push({
        layerId: layer.id,
        type: layer.type,
        action: isSkipped || anyLossy ? 'skipped'
          : reasons.length > 0 ? 'lossy' : 'converted',
        reasons,
      })
    }
  }

  // ── Trailing warnings dump ─────────────────────────────────────────
  if (warnings.length > 0) {
    lines.push('/* Conversion notes (review before running):')
    for (const w of warnings) lines.push(' *   • ' + w)
    lines.push(' */')
  }

  if (options?.coverage) {
    options.coverage.warnings.push(...warnings)
  }

  return lines.join('\n').trimEnd() + '\n'
}

// ── Public type re-exports ──────────────────────────────────────────
// Pre-split, callers `import { MapboxStyle, MapboxLayer, MapboxSource }
// from '@xgis/compiler'` via compiler/src/index.ts. Re-export from
// here so neither callers nor `index.ts` need to know the new layout.
export type { MapboxStyle, MapboxSource, MapboxLayer } from './types'
