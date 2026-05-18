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
import { sanitizeId } from './utils'

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
  //   projection — runtime supports multiple projections via the
  //                `?proj=` URL flag, but the style-spec field isn't
  //                read. A style declaring `projection: { type:
  //                "globe" }` renders flat-Mercator.
  //   fog / light / terrain / transition / imports — Mapbox v3
  //                additions, none implemented.
  //
  // Centre / zoom / pitch / bearing / glyphs / sprite are deliberately
  // omitted — they're host-integration concerns (the playground's
  // demo-runner + compare-runner read them and call the matching
  // XGISMap setters), not converter ones.
  const styleAny = style as unknown as Record<string, unknown>
  // Mapbox spec: top-level `version` must be 8 — the entire schema
  // (sources / layers / paint / layout / expressions) is version-
  // tagged. Older v7 styles use a different paint/layout shape; a
  // v7 style passed through the v8 converter produced garbage output
  // (drop-in colour properties were renamed between versions). Warn
  // explicitly so the user sees the version mismatch instead of
  // chasing rendering bugs.
  // Missing version → warn (spec requires it); v8 → silent; anything
  // else → loud warning.
  const styleVer = styleAny.version
  if (styleVer === undefined || styleVer === null) {
    warnings.push(`Style is missing top-level "version" field — Mapbox spec requires version: 8; converter assumed v8 schema.`)
  } else if (styleVer !== 8) {
    warnings.push(`Style declares version: ${JSON.stringify(styleVer).slice(0, 40)} — only Mapbox style v8 is supported; conversion output may be partial / wrong.`)
  }

  const topLevelGaps: string[] = []
  if (styleAny.projection !== undefined && styleAny.projection !== null) {
    topLevelGaps.push('projection')
  }
  // sky (v2+ atmospheric haze / horizon gradient), lights (v3
  // standard-style ambient + directional rig), models (v3 standard-
  // style glTF 3D placements) — none implemented. Pre-fix the
  // converter silently dropped them and the conversion-notes block
  // gave no hint that an authored sky / lights setup wasn't carrying
  // through. Same surfacing pattern as fog / light / terrain.
  for (const k of ['fog', 'light', 'lights', 'terrain', 'sky', 'transition', 'imports', 'models']) {
    const v = styleAny[k]
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
  const sourcesObj = stylesSources !== null && typeof stylesSources === 'object'
    && !Array.isArray(stylesSources)
    ? stylesSources
    : {}
  // Pre-walk: source minzoom > maxzoom inversion. Mirror of the
  // per-layer zoom-inversion check below. A source declaring
  // `{ minzoom: 10, maxzoom: 4 }` has an empty servable-zoom range;
  // every tile request to it produces a 404 / empty payload and the
  // dependent layers stay blank. Common typo when copying source
  // definitions between styles.
  for (const [sid, src] of Object.entries(sourcesObj)) {
    if (src === null || typeof src !== 'object' || Array.isArray(src)) continue
    const mn = (src as { minzoom?: unknown }).minzoom
    const mx = (src as { maxzoom?: unknown }).maxzoom
    if (typeof mn === 'number' && typeof mx === 'number' && mn > mx) {
      warnings.push(`Source "${sid.slice(0, 60)}" has minzoom=${mn} > maxzoom=${mx} — empty servable-zoom range; every dependent layer will render blank.`)
    }
    // Out-of-range source zoom mirrors the per-layer check below. A
    // typo'd `maxzoom: 30` here would make the tile selector clamp
    // silently; surface so the author sees the gap.
    if (typeof mn === 'number' && (mn < 0 || mn > 24)) {
      warnings.push(`Source "${sid.slice(0, 60)}" minzoom=${mn} is outside Mapbox spec range [0, 24]; tile selector clamps so the source serves as if minzoom=${Math.max(0, Math.min(24, mn))}.`)
    }
    if (typeof mx === 'number' && (mx < 0 || mx > 24)) {
      warnings.push(`Source "${sid.slice(0, 60)}" maxzoom=${mx} is outside Mapbox spec range [0, 24]; tile selector clamps so the source serves as if maxzoom=${Math.max(0, Math.min(24, mx))}.`)
    }
  }

  // Pre-walk for source-id sanitization collisions. Raw-id duplicates
  // are impossible (Object.entries dedups by key), but `sanitizeId`
  // can collapse distinct raw ids (`world-tiles` / `world_tiles` both
  // become `world_tiles`); the emitted xgis carries two `source
  // world_tiles { … }` blocks and runtime registers only the last —
  // every layer referencing the FIRST raw id falls back to the
  // overriding second source's tiles silently. Mirror of the layer-id
  // collision pre-walk above.
  const seenSourceSanitized = new Map<string, string>()
  for (const id of Object.keys(sourcesObj)) {
    const sanitized = sanitizeId(id)
    const collidedWith = seenSourceSanitized.get(sanitized)
    if (collidedWith !== undefined && collidedWith !== id) {
      warnings.push(`Source id "${id.slice(0, 60)}" sanitizes to "${sanitized}" — collides with another source "${collidedWith.slice(0, 60)}"; emitted blocks will share an identifier and later wins.`)
    } else {
      seenSourceSanitized.set(sanitized, id)
    }
  }

  for (const [id, src] of Object.entries(sourcesObj)) {
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
      const safeMsg = (e as Error).message.replace(/\*\//g, '* /').slice(0, 80)
      block = `source ${sanitizeId(id)} {\n  // SKIPPED — converter threw: ${safeMsg}\n}`
    }
    lines.push(block)
    lines.push('')
    if (options?.coverage) {
      const reasons = warnings.slice(before)
      const srcType = src !== null && typeof src === 'object' && !Array.isArray(src)
        ? (src as { type?: string }).type
        : undefined
      options.coverage.sources.push({
        id,
        type: srcType as never,
        action: block.includes('// SKIPPED') ? 'skipped'
          : reasons.length > 0 ? 'lossy' : 'converted',
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
    l => l !== null && typeof l === 'object' && (l as { type?: unknown }).type === 'background',
  )
  if (bgLayer) {
    const before = warnings.length
    // Respect `layout.visibility: 'none'` on background layers per
    // Mapbox spec — without this gate a hidden background emitted a
    // fill anyway and over-painted whatever canvas-clear / underlying
    // colour the host expected to show through. Same v8 literal-wrap
    // unwrap as the visibility gate on other layer types.
    // Loop peel for multi-level wraps mirror of unwrapLiteralScalar
    // (0532bc3). Pre-fix only single-level ['literal', 'none'] was
    // recognised; ['literal', ['literal', 'none']] from preprocessor
    // chains left the layer rendering despite the author's hide.
    let bgVisibility: unknown = bgLayer.layout?.visibility
    while (Array.isArray(bgVisibility) && bgVisibility.length === 2
        && bgVisibility[0] === 'literal') {
      bgVisibility = bgVisibility[1]
    }
    const bgVisibilityNone = bgVisibility === 'none'
    const color = bgLayer.paint?.['background-color']
    const colorStr = bgVisibilityNone ? null : colorToXgis(color, warnings)
    if (colorStr) {
      lines.push(`background { fill: ${colorStr} }`)
      lines.push('')
    }
    // Surface dropped background paint props. xgis's `background {
    // fill: # }` directive doesn't carry opacity / pattern. Mapbox
    // background-opacity defaults to 1 so a missing value is fine;
    // explicit < 1 silently downgrades to fully opaque and the user
    // never knows. background-pattern is the bitmap-atlas equivalent
    // (Batch 2 follow-up).
    // Defensive: coerce non-object bgLayer.paint to {} (mirror of the
    // layers.ts safePropsBag guard). A string paint value previously
    // let bgPaint['background-opacity'] index a char and the warning
    // list leaked garbage property names.
    const rawBgPaint = bgLayer.paint
    const bgPaint = (rawBgPaint !== null && rawBgPaint !== undefined
      && typeof rawBgPaint === 'object' && !Array.isArray(rawBgPaint))
      ? rawBgPaint as Record<string, unknown>
      : {}
    const bgIgnored: string[] = []
    // Treat null the same as undefined per Mapbox spec.
    const bgOpacity = bgPaint['background-opacity']
    const bgPattern = bgPaint['background-pattern']
    if (bgOpacity !== undefined && bgOpacity !== null) bgIgnored.push('background-opacity')
    if (bgPattern !== undefined && bgPattern !== null) bgIgnored.push('background-pattern (Batch 2)')
    if (bgIgnored.length > 0) {
      warnings.push(`Background layer "${bgLayer.id}" — ignored properties: ${bgIgnored.join(', ')}`)
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

  // ── Pre-walk: detect minzoom > maxzoom inversions ──────────────────
  // Mapbox spec doesn't explicitly forbid `minzoom > maxzoom` but
  // the runtime tile-selector treats the range as `[min, max]` so an
  // inverted range produces an empty visible-zoom set — the layer
  // NEVER renders. Common typo source (swapped min/max, off-by-one
  // when copying between zoom-band-segmented styles). Pre-fix the
  // layer dropped silently with no diagnostic.
  for (const l of layersArr) {
    if (l === null || typeof l !== 'object' || Array.isArray(l)) continue
    const mn = (l as { minzoom?: unknown }).minzoom
    const mx = (l as { maxzoom?: unknown }).maxzoom
    const lid = (l as { id?: unknown }).id ?? '<unknown>'
    if (typeof mn === 'number' && typeof mx === 'number' && mn > mx) {
      warnings.push(`Layer "${String(lid).slice(0, 60)}" has minzoom=${mn} > maxzoom=${mx} — the layer never renders. Swap the values or remove one.`)
    }
    // Mapbox spec: zoom values ∈ [0, 24]. Out-of-range usually
    // indicates a typo. The tile selector silently clamps, so the
    // layer renders the same as if the bound were the nearest valid
    // value — no visual difference but the authored intent is lost.
    if (typeof mn === 'number' && (mn < 0 || mn > 24)) {
      warnings.push(`Layer "${String(lid).slice(0, 60)}" minzoom=${mn} is outside Mapbox spec range [0, 24]; tile selector clamps so the layer renders as if minzoom=${Math.max(0, Math.min(24, mn))}.`)
    }
    if (typeof mx === 'number' && (mx < 0 || mx > 24)) {
      warnings.push(`Layer "${String(lid).slice(0, 60)}" maxzoom=${mx} is outside Mapbox spec range [0, 24]; tile selector clamps so the layer renders as if maxzoom=${Math.max(0, Math.min(24, mx))}.`)
    }
  }

  // ── Pre-walk: vector-source layers require source-layer ────────────
  // Mapbox spec: every layer reading from a vector source (vector /
  // pmtiles / tilejson backends) MUST declare `source-layer`. Without
  // it the runtime tile decoder has no MVT layer to read from and
  // emits zero features → blank layer with no diagnostic. The omission
  // is one of the top-3 "my layer doesn't render" support cases for
  // hand-edited styles.
  // Background / raster / raster-dem / image / video / geojson don't
  // need source-layer (the source itself is the data).
  const vectorSourceIds = new Set<string>()
  for (const [sid, src] of Object.entries(sourcesObj)) {
    if (src === null || typeof src !== 'object' || Array.isArray(src)) continue
    const t = (src as { type?: unknown }).type
    if (t === 'vector' || t === 'pmtiles' || t === 'tilejson') {
      vectorSourceIds.add(sid)
    }
  }
  for (const l of layersArr) {
    if (l === null || typeof l !== 'object' || Array.isArray(l)) continue
    const ltype = (l as { type?: unknown }).type
    if (ltype === 'background' || ltype === 'raster' || ltype === 'hillshade') continue
    const lsrc = (l as { source?: unknown }).source
    if (typeof lsrc !== 'string' || lsrc.length === 0) continue
    if (!vectorSourceIds.has(lsrc)) continue
    const slayer = (l as { 'source-layer'?: unknown })['source-layer']
    if (typeof slayer !== 'string' || slayer.length === 0) {
      const lid = (l as { id?: unknown }).id ?? '<unknown>'
      warnings.push(`Layer "${String(lid).slice(0, 60)}" reads from vector source "${lsrc.slice(0, 60)}" but has no source-layer; the runtime decoder will return zero features and the layer renders blank.`)
    }
  }

  // ── Pre-walk: detect layers referencing undeclared sources ─────────
  // Mapbox spec: every non-background layer's `source` field MUST
  // reference a declared source in `style.sources`. Real-world failure
  // mode: a layer copied between styles drags a `source: "osm"`
  // reference but the destination style has no `osm` source; the
  // runtime falls back to an empty source / no tiles and the layer
  // renders blank with no diagnostic.
  const declaredSourceIds = new Set(Object.keys(sourcesObj))
  for (const l of layersArr) {
    if (l === null || typeof l !== 'object' || Array.isArray(l)) continue
    const layerType = (l as { type?: unknown }).type
    if (layerType === 'background') continue
    const layerSource = (l as { source?: unknown }).source
    if (typeof layerSource !== 'string' || layerSource.length === 0) continue
    if (!declaredSourceIds.has(layerSource)) {
      const lid = (l as { id?: unknown }).id ?? '<unknown>'
      warnings.push(`Layer "${String(lid).slice(0, 60)}" references undeclared source "${layerSource.slice(0, 60)}"; runtime will see no tiles and the layer renders blank.`)
    }
  }

  // ── Pre-walk: detect id collisions ─────────────────────────────────
  // Two failure modes Mapbox styles trip on in the wild:
  //   1. Duplicate raw id — Mapbox spec requires unique layer ids
  //      but partial / hand-edited JSON breaks this. The second
  //      layer's emitted block silently overrides the first in the
  //      runtime's id-keyed registry.
  //   2. Sanitization collision — distinct raw ids that collapse to
  //      the same sanitized identifier (`a-b` and `a_b` both become
  //      `a_b`; `1km` and `_1km` collide once digit-leading prefix
  //      runs). The emitted xgis has two identical `layer foo { … }`
  //      blocks; downstream lower / IR keys by sanitized id so the
  //      later block wins silently.
  // Warn at convert time so the user sees the problem instead of a
  // mystery missing layer.
  const seenRaw = new Set<unknown>()
  const seenSanitized = new Map<string, unknown>()
  for (const l of layersArr) {
    if (l === null || typeof l !== 'object' || Array.isArray(l)) continue
    if ((l as { type?: unknown }).type === 'background') continue
    const rawId = (l as { id?: unknown }).id
    if (rawId === undefined || rawId === null) continue
    if (seenRaw.has(rawId)) {
      warnings.push(`Duplicate layer id "${String(rawId).slice(0, 60)}" — Mapbox spec requires unique layer ids; later block overrides earlier in the runtime registry.`)
    } else {
      seenRaw.add(rawId)
      const sanitized = sanitizeId(typeof rawId === 'string' ? rawId : String(rawId))
      const collidedWith = seenSanitized.get(sanitized)
      if (collidedWith !== undefined && collidedWith !== rawId) {
        warnings.push(`Layer id "${String(rawId).slice(0, 60)}" sanitizes to "${sanitized}" — collides with another layer "${String(collidedWith).slice(0, 60)}"; emitted blocks will share an identifier and later wins.`)
      } else {
        seenSanitized.set(sanitized, rawId)
      }
    }
  }

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
        : expandPerFeatureColorMatch(layer as MapboxLayer)
    } catch (e) {
      warnings.push(`Layer "${(layer as { id?: unknown }).id ?? '<unknown>'}" expand-color-match threw: ${(e as Error).message}`)
    }
    const sublayers = expanded ?? [layer as MapboxLayer]
    let anyEmitted = false
    let anyLossy = false
    for (const sub of sublayers) {
      let block: string | null = null
      try {
        block = convertLayer(sub, warnings)
      } catch (e) {
        warnings.push(`Layer "${(sub as { id?: unknown }).id ?? '<unknown>'}" conversion threw: ${(e as Error).message}`)
        block = `// SKIPPED layer "${(sub as { id?: unknown }).id ?? '<unknown>'}" — converter threw: ${(e as Error).message.slice(0, 80)}`
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
        action: isSkipped || anyLossy ? 'skipped'
          : reasons.length > 0 ? 'lossy' : 'converted',
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
