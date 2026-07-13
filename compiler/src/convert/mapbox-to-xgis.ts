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
import { expandPerFeatureColorMatch } from './expand-color-match'
import { sanitizeId } from './utils'
import { validateSourceZoom, validateSourceIdCollisions } from './validate-sources'
import {
  validateLayerZoom,
  validateLayerSourceLayer,
  validateLayerSourceRefs,
  validateLayerIdCollisions,
} from './validate-layers'
import { convertBackgroundLayer } from './convert-background-layer'

/** Per-source record emitted into the optional `coverage` collector.
 *  `reasons` holds warnings pushed during that source's conversion
 *  (sliced from the shared `warnings` array). `action` is derived from
 *  the converter's output, not from a separate signal — so the record
 *  reflects what actually happened. */
export interface SourceCoverage {
  id: string
  /** `undefined` when the source entry is malformed (non-object) or
   *  omits `type` — coverage reads sources defensively. */
  type: string | undefined
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
  /** Skip the `expandPerFeatureColorMatch` preprocessor that splits
   *  Mapbox `fill-color: ["match", …]` layers into one sublayer per
   *  unique colour. Default (false) keeps the existing draw-call
   *  fanout pattern; flip to true when the runtime compute path is
   *  available end-to-end (plan P4) — match() then survives lower()
   *  as a single data-driven shape, the compute kernel evaluates
   *  every arm GPU-side, and the draw count drops back to one per
   *  source layer instead of one per colour.
   *
   *  Today this is forward-looking: the MapRenderer (GeoJSON) path
   *  fully consumes data-driven match() compute (commit 215bbe1),
   *  but Mapbox styles route through VectorTileRenderer which still
   *  needs its own compute integration. Enabling the bypass without
   *  VTR compute results in match() collapsing to its default arm
   *  at lower.ts → visible regression. Diagnostic / measurement use
   *  only until VTR compute lands. */
  bypassExpandColorMatch?: boolean
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
  let parsed: unknown
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input)
    } catch (e) {
      // Malformed JSON — emit a comment + empty style instead of
      // letting the SyntaxError propagate up through every caller.
      return `/* Mapbox style conversion failed: invalid JSON — ${(e as Error).message.replace(/\*\//g, '* /')} */`
    }
  } else {
    parsed = input
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    // Null / non-object style body — pre-fix the function then accessed
    // `style.name` on null and crashed.
    return `/* Mapbox style conversion failed: expected an object, got ${parsed === null ? 'null' : typeof parsed} */`
  }
  const style: MapboxStyle = parsed as MapboxStyle
  const lines: string[] = []
  const warnings: string[] = []

  if (style.name) {
    // Strip C-style comment terminators from the name to avoid
    // prematurely closing the surrounding /* … */ block. A style
    // authored with `name: "foo */ malicious */"` would otherwise let
    // arbitrary content slip past the comment boundary.
    const safeName = String(style.name).replace(/\*\//g, '* /')
    lines.push(`/* Converted from Mapbox style: "${safeName}" */`)
    lines.push('')
  }

  // ── Top-level style fields without an X-GIS equivalent ─────────────
  // The Mapbox style spec defines several top-level fields beyond
  // `sources` / `layers` / `name`. The CONVERTER doesn't encode any
  // of them in the xgis source; the ones the host integration HANDLES
  // out-of-band (glyphs / sprite via setGlyphsUrl + setSpriteUrl, plus
  // camera state via the hash) deliberately stay off the warning list.
  // Only fields that meaningfully change rendering AND have no host
  // hook today get warned:
  //
  //   fog / light / terrain / transition / imports — Mapbox v3
  //                additions, none implemented.
  //
  // Centre / zoom / pitch / bearing / glyphs / sprite / projection are
  // deliberately omitted — they're host-integration concerns (the
  // playground's demo-runner + compare-runner read them off the raw
  // style JSON and call the matching XGISMap setters: setProjection for
  // the top-level `projection` field, mapped from the Mapbox type name),
  // not converter ones. The xgis DSL carries no top-level camera /
  // projection state.
  // Mapbox spec: top-level `version` must be 8 — the entire schema
  // (sources / layers / paint / layout / expressions) is version-
  // tagged. Older v7 styles use a different paint/layout shape; a
  // v7 style passed through the v8 converter produced garbage output
  // (drop-in colour properties were renamed between versions). Warn
  // explicitly so the user sees the version mismatch instead of
  // chasing rendering bugs.
  // Missing version → warn (spec requires it); v8 → silent; anything
  // else → loud warning.
  const styleVer = style.version
  if (styleVer === undefined || styleVer === null) {
    warnings.push(
      `Style is missing top-level "version" field — Mapbox spec requires version: 8; converter assumed v8 schema.`,
    )
  } else if (styleVer !== 8) {
    warnings.push(
      `Style declares version: ${JSON.stringify(styleVer).slice(0, 40)} — only Mapbox style v8 is supported; conversion output may be partial / wrong.`,
    )
  }

  const topLevelGaps: string[] = []
  // sky (v2+ atmospheric haze / horizon gradient), lights (v3
  // standard-style ambient + directional rig), models (v3 standard-
  // style glTF 3D placements) — none implemented. Pre-fix the
  // converter silently dropped them and the conversion-notes block
  // gave no hint that an authored sky / lights setup wasn't carrying
  // through. Same surfacing pattern as fog / light / terrain.
  // `light` (v8 single directional light) is host-applied via
  // XGISMap.setLight() — same pattern as projection/camera — so it is NOT
  // listed here. `lights` (v3 standard-style ambient+directional rig) is a
  // different, unimplemented feature and stays warned.
  const gapFields = [
    'fog',
    'lights',
    'terrain',
    'sky',
    'transition',
    'imports',
    'models',
  ] as const satisfies readonly (keyof MapboxStyle)[]
  for (const k of gapFields) {
    const v = style[k]
    if (v !== undefined && v !== null) topLevelGaps.push(k)
  }
  if (topLevelGaps.length > 0) {
    warnings.push(`Top-level style fields ignored: ${topLevelGaps.join(', ')}`)
  }

  // ── Sources ────────────────────────────────────────────────────────
  // Defensive: style.sources should be a plain object per spec. A
  // string / array / null would otherwise either crash (null) or
  // produce garbage entries (string iterates chars, array iterates
  // indices). Coerce to {} when malformed.
  const stylesSources = style.sources
  const sourcesObj =
    stylesSources !== null && typeof stylesSources === 'object' && !Array.isArray(stylesSources)
      ? stylesSources
      : {}
  // Pre-walk: source minzoom > maxzoom inversion + out-of-range bounds.
  validateSourceZoom(sourcesObj as Record<string, unknown>, warnings)

  // Pre-walk for source-id sanitization collisions.
  validateSourceIdCollisions(sourcesObj as Record<string, unknown>, warnings)

  // iter-198 — dead-source drop. Build the set of source ids actually
  // referenced by layers; sources declared but unused get warned + skipped
  // from emit. Bright fixture has `ne2_shaded` declared but never bound
  // to a layer — pre-fix the converter emitted the source block which
  // then sat in IR cost forever (parse, source-instance, prewarm probe
  // round-trip). LLVM-style early DCE: shrink the input surface before
  // any subsequent pass (merge-layers / CSE / codegen) runs.
  //
  // Background and the various non-source layer types don't carry a
  // `source` field; everything else with a `source: <id>` reference
  // marks that id as live. Mirror of the layer-source schema check
  // above (declaredSourceIds) but inverted: layer→source rather than
  // source→layer.
  const referencedSourceIds = new Set<string>()
  const rawLayersForSourceUse = Array.isArray(style.layers) ? style.layers : []
  for (const l of rawLayersForSourceUse) {
    if (l === null || typeof l !== 'object' || Array.isArray(l)) continue
    const layerSource = (l as { source?: unknown }).source
    if (typeof layerSource === 'string' && layerSource.length > 0) {
      referencedSourceIds.add(layerSource)
    }
  }
  // Only run the dead-source drop on styles that DECLARE layers. A
  // sources-only style (unit-test fixture / partial author authoring
  // sources first then layers later) would otherwise see every source
  // dropped — surprising behaviour for the in-flight author and the
  // existing source-emit test suite that pre-dates this pass. Real
  // Mapbox styles always carry layers; the elided case is the tooling
  // fixture, which doesn't need the optimisation anyway.
  const dropUnusedSources = rawLayersForSourceUse.length > 0
  for (const [id, src] of Object.entries(sourcesObj)) {
    if (dropUnusedSources && !referencedSourceIds.has(id)) {
      // Drop + warn. Type guard mirrors convertSource's null-tolerant
      // contract — a string `type` aids the diagnostic but isn't required.
      const t =
        src !== null && typeof src === 'object' && !Array.isArray(src)
          ? (src as { type?: unknown }).type
          : undefined
      const tStr = typeof t === 'string' ? ` (type=${t})` : ''
      warnings.push(
        `Source "${id.slice(0, 60)}"${tStr} is declared but never referenced by any layer; dropped from emit (saves a tile fetch + IR slot). Layers may have been removed in the style but the source declaration was left behind.`,
      )
      continue
    }
    const before = warnings.length
    // Mirror of the per-layer try/catch isolation (0c81006): a throw
    // inside convertSource (unexpected runtime conditions) would
    // otherwise propagate up and every subsequent source drop. Also
    // safely read src.type for coverage even when src is null/non-object
    // — convertSource itself returns a placeholder block in that case.
    let block: string
    try {
      block = convertSource(id, src, warnings, options)
    } catch (e) {
      warnings.push(`Source "${id}" conversion threw: ${(e as Error).message}`)
      // Use sanitizeId on the placeholder block — pre-fix a raw id
      // with kebab-case / unicode / digit-leading shape produced an
      // emitted `source road-major {` that the xgis lexer rejected,
      // so the whole emitted style failed to load after one isolated
      // source throw. Mirror of convertSource's normal-path
      // sanitization.
      // Also strip `*/` from the error message: comment lines are //
      // single-line so `*/` is harmless in practice, BUT the emitted
      // .map() output is itself wrapped in a top-of-file /* … */
      // comments block when the converter has any warnings — letting
      // a raw `*/` through the catch message closes the wrapper
      // early and the rest of the file parses as code.
      // Also strip newlines so a message like "foo\nbar" doesn't
      // terminate the `//` line comment mid-message and let the
      // rest parse as raw xgis code. Mirror of the layer catch-path
      // newline sanitize.
      const safeMsg = (e as Error).message
        .replace(/[\r\n]/g, ' ')
        .replace(/\*\//g, '* /')
        .slice(0, 80)
      block = `source ${sanitizeId(id)} {\n  // SKIPPED — converter threw: ${safeMsg}\n}`
    }
    lines.push(block)
    lines.push('')
    if (options?.coverage) {
      const reasons = warnings.slice(before)
      const srcType =
        src !== null && typeof src === 'object' && !Array.isArray(src)
          ? (src as { type?: string }).type
          : undefined
      options.coverage.sources.push({
        id,
        type: srcType,
        action: block.includes('// SKIPPED')
          ? 'skipped'
          : reasons.length > 0
            ? 'lossy'
            : 'converted',
        reasons,
      })
    }
  }

  // ── Background layer (Mapbox `background` type) ────────────────────
  // X-GIS has a top-level `background { fill: <color> }` directive
  // rather than a layer with `paint.background-color`.
  // Defensive null/object guard: malformed styles can have null entries
  // in the layers array. `l.type` would crash; emit nothing for null
  // entries and warn so the rest still converts.
  // Defensive: style.layers should be an array per spec. Non-array
  // forms (object / string / null) would otherwise crash .find /
  // for...of. Coerce to [] when malformed.
  const layersArr = Array.isArray(style.layers) ? style.layers : []
  const bgLayer = layersArr.find(
    (l) => l !== null && typeof l === 'object' && (l as { type?: unknown }).type === 'background',
  )
  if (bgLayer) {
    convertBackgroundLayer(bgLayer, lines, warnings, options?.coverage)
  }

  // ── Pre-walk: detect layer minzoom > maxzoom inversions + range ────
  validateLayerZoom(layersArr, warnings)

  // ── Pre-walk: vector-source layers require source-layer ────────────
  validateLayerSourceLayer(layersArr, sourcesObj as Record<string, unknown>, warnings)

  // ── Pre-walk: detect layers referencing undeclared sources ─────────
  validateLayerSourceRefs(layersArr, sourcesObj as Record<string, unknown>, warnings)

  // ── Pre-walk: detect layer id collisions ───────────────────────────
  validateLayerIdCollisions(layersArr, warnings)

  // ── Layers ─────────────────────────────────────────────────────────
  for (const layer of layersArr) {
    // Defensive guard: null / non-object layer entry (malformed style).
    // Pre-fix `layer.type` crashed at runtime and the entire style
    // failed to convert past the bad entry.
    if (layer === null || typeof layer !== 'object' || Array.isArray(layer)) {
      warnings.push(`Layers array contains a non-object entry (${typeof layer}); skipped.`)
      continue
    }
    if (layer.type === 'background') continue // handled above
    const before = warnings.length
    // Preprocess: a `fill-color: ["match", ["get", field], …]` with
    // many distinct constant colours (typical "one colour per country"
    // basemap pattern — MapLibre demotiles is the canonical case)
    // would otherwise collapse to a single default colour at lower.ts.
    // Split the layer into one sublayer per unique colour with a
    // value-set filter, so each colour renders correctly without any
    // runtime per-feature support.
    // Wrap the per-layer conversion in try/catch so one corrupt
    // layer (unexpected AST shape, malformed expression, etc.) does
    // NOT kill conversion of the rest of the style. Pre-fix any throw
    // inside expandPerFeatureColorMatch / convertLayer propagated all
    // the way up and every subsequent layer in the array dropped.
    let expanded: MapboxLayer[] | null = null
    try {
      expanded = options?.bypassExpandColorMatch
        ? null
        : expandPerFeatureColorMatch(layer as MapboxLayer, warnings)
    } catch (e) {
      warnings.push(
        `Layer "${(layer as { id?: unknown }).id ?? '<unknown>'}" expand-color-match threw: ${(e as Error).message}`,
      )
    }
    const sublayers = expanded ?? [layer as MapboxLayer]
    let anyEmitted = false
    let anyLossy = false
    for (const sub of sublayers) {
      let block: string | null = null
      try {
        block = convertLayer(sub, warnings)
      } catch (e) {
        warnings.push(
          `Layer "${(sub as { id?: unknown }).id ?? '<unknown>'}" conversion threw: ${(e as Error).message}`,
        )
        // Sanitize newlines + carriage returns in the placeholder
        // comment — a `//` line comment terminates at newline, so an
        // id or throw-message containing `\n` would close the
        // comment mid-line and the rest of the message would parse
        // as raw xgis code, cascading lex errors through the file.
        const rawId = (sub as { id?: unknown }).id ?? '<unknown>'
        const safeId = String(rawId).replace(/[\r\n]/g, ' ')
        const safeMsg = (e as Error).message.replace(/[\r\n]/g, ' ').slice(0, 80)
        block = `// SKIPPED layer "${safeId}" — converter threw: ${safeMsg}`
      }
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
        action: isSkipped || anyLossy ? 'skipped' : reasons.length > 0 ? 'lossy' : 'converted',
        reasons,
      })
    }
  }

  // ── Trailing warnings dump ─────────────────────────────────────────
  if (warnings.length > 0) {
    lines.push('/* Conversion notes (review before running):')
    // Neutralise `*/` inside any warning so the wrapping block-
    // comment doesn't close early. Pre-fix a thrown-error message or
    // a malformed input value that contained `*/` (rare but
    // observed in styles with embedded data URLs / regex patterns)
    // closed the `/* … */` wrapper at the first occurrence; the
    // rest of the warnings rendered as RAW xgis source and the
    // subsequent parse exploded with cascade lex errors.
    for (const w of warnings) {
      lines.push(' *   • ' + w.replace(/\*\//g, '* /'))
    }
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
