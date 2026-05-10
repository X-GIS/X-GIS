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

import type { MapboxStyle } from './types'
import { convertSource, type ConvertSourceOptions } from './sources'
import { convertLayer } from './layers'
import { colorToXgis } from './colors'

export interface ConvertMapboxStyleOptions extends ConvertSourceOptions {}

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
    lines.push(convertSource(id, src, warnings, options))
    lines.push('')
  }

  // ── Background layer (Mapbox `background` type) ────────────────────
  // X-GIS has a top-level `background { fill: <color> }` directive
  // rather than a layer with `paint.background-color`.
  const bgLayer = (style.layers ?? []).find(l => l.type === 'background')
  if (bgLayer) {
    const color = bgLayer.paint?.['background-color']
    const colorStr = colorToXgis(color, warnings)
    if (colorStr) {
      lines.push(`background { fill: ${colorStr} }`)
      lines.push('')
    }
  }

  // ── Layers ─────────────────────────────────────────────────────────
  for (const layer of style.layers ?? []) {
    if (layer.type === 'background') continue // handled above
    const block = convertLayer(layer, warnings)
    if (block) {
      lines.push(block)
      lines.push('')
    }
  }

  // ── Trailing warnings dump ─────────────────────────────────────────
  if (warnings.length > 0) {
    lines.push('/* Conversion notes (review before running):')
    for (const w of warnings) lines.push(' *   • ' + w)
    lines.push(' */')
  }

  return lines.join('\n').trimEnd() + '\n'
}

// ── Public type re-exports ──────────────────────────────────────────
// Pre-split, callers `import { MapboxStyle, MapboxLayer, MapboxSource }
// from '@xgis/compiler'` via compiler/src/index.ts. Re-export from
// here so neither callers nor `index.ts` need to know the new layout.
export type { MapboxStyle, MapboxSource, MapboxLayer } from './types'
