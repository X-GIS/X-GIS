import { resolveColor } from '../tokens/colors'

// ═══ Mapbox Style → xgis Source Converter ═══
//
// Takes a Mapbox Style Specification JSON document and emits an
// equivalent xgis source string. Maps the subset of style features
// the engine actually renders today; bails with a comment for
// anything outside that subset so the user sees what got dropped
// (instead of silent partial output).
//
// What this v1 covers:
//   • Sources of type `vector` (rewritten as `pmtiles` when the
//     URL already points at a .pmtiles archive — the most common
//     case — otherwise emits a TODO so the user can pick the right
//     X-GIS source kind).
//   • Layer types `background`, `fill`, `line`, `fill-extrusion`.
//   • Common paint properties:
//       fill-color / fill-opacity
//       line-color / line-width / line-dasharray
//       fill-extrusion-height / fill-extrusion-base
//   • Filter expressions in the legacy + expression-syntax forms:
//       ==, !=, <, <=, >, >=, all, any, in, !in, has, !has
//   • Expression cases: literal, ["get",…], ["coalesce",…],
//     ["case",…], ["match",…], simple arithmetic, ["to-number"].
//
// Not yet covered (emitted as `// TODO: <reason>` comments):
//   • Symbol layers (text + icon) — the engine doesn't render text
//     yet; converting paint geometry-less is meaningless.
//   • Circle layers — addressable but needs separate point work.
//   • Raster layers (other than direct URL passthrough).
//   • Complex interpolate expressions with non-numeric stops.
//   • Sprite atlas / pattern paint properties.

export interface MapboxStyle {
  version?: number
  name?: string
  sources?: Record<string, MapboxSource>
  layers?: MapboxLayer[]
  // Other top-level fields (sprite, glyphs, metadata) ignored for now.
}

export interface MapboxSource {
  type: string
  url?: string
  tiles?: string[]
  minzoom?: number
  maxzoom?: number
  scheme?: string
  bounds?: number[]
}

export interface MapboxLayer {
  id: string
  type: string
  source?: string
  'source-layer'?: string
  minzoom?: number
  maxzoom?: number
  paint?: Record<string, unknown>
  layout?: Record<string, unknown>
  filter?: unknown
}

/** Convert a Mapbox Style JSON (already parsed or raw string) into
 *  an xgis source string. The result is meant to be human-readable
 *  and immediately runnable against the X-GIS playground. */
export function convertMapboxStyle(input: string | MapboxStyle): string {
  const style: MapboxStyle = typeof input === 'string' ? JSON.parse(input) : input
  const lines: string[] = []
  const warnings: string[] = []

  if (style.name) {
    lines.push(`/* Converted from Mapbox style: "${style.name}" */`)
    lines.push('')
  }

  // ── Sources ────────────────────────────────────────────────────────
  const sourceById = style.sources ?? {}
  for (const [id, src] of Object.entries(sourceById)) {
    const block = convertSource(id, src, warnings)
    lines.push(block)
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

// ═══ Source conversion ═══════════════════════════════════════════════

function convertSource(id: string, src: MapboxSource, warnings: string[]): string {
  const lines: string[] = [`source ${sanitizeId(id)} {`]
  if (src.type === 'vector') {
    // Prefer URL when present (Mapbox tilejson / mb-style URL); fall
    // back to first tile pattern.
    //   .pmtiles archive       → type: pmtiles
    //   anything else (most    → type: tilejson  (runtime fetches
    //   commonly a TileJSON      the manifest, then drives the same
    //   manifest URL like        attachPMTilesSource backend)
    //   tiles.example.com/x)
    const url = src.url ?? src.tiles?.[0]
    if (url && /\.pmtiles(\?|$)/.test(url)) {
      lines.push('  type: pmtiles')
      lines.push(`  url: "${url}"`)
    } else if (url) {
      lines.push('  type: tilejson')
      lines.push(`  url: "${url}"`)
    } else {
      lines.push('  // TODO: vector source without url/tiles — fill in PMTiles archive URL')
      warnings.push(`Source "${id}" has neither url nor tiles[]; emitted placeholder.`)
    }
  } else if (src.type === 'raster') {
    const url = src.tiles?.[0] ?? src.url
    if (url) {
      lines.push('  type: raster')
      lines.push(`  url: "${url}"`)
    } else {
      lines.push('  // TODO: raster source missing url/tiles')
      warnings.push(`Raster source "${id}" has no URL.`)
    }
  } else if (src.type === 'geojson') {
    const url = (src as { data?: string | unknown }).data
    if (typeof url === 'string') {
      lines.push('  type: geojson')
      lines.push(`  url: "${url}"`)
    } else {
      lines.push('  // TODO: GeoJSON inline data not yet supported by converter')
      warnings.push(`GeoJSON source "${id}" has inline data; converter only handles external URLs.`)
    }
  } else {
    lines.push(`  // TODO: unsupported source type "${src.type}"`)
    warnings.push(`Source "${id}" has unsupported type "${src.type}".`)
  }
  lines.push('}')
  return lines.join('\n')
}

// ═══ Layer conversion ════════════════════════════════════════════════

function convertLayer(layer: MapboxLayer, warnings: string[]): string | null {
  // Symbol / circle / heatmap / hillshade — emit a stub the user can
  // see and remove or implement later, instead of silently dropping
  // them.
  if (layer.type === 'symbol' || layer.type === 'circle' ||
      layer.type === 'heatmap' || layer.type === 'hillshade') {
    warnings.push(`Layer "${layer.id}" type="${layer.type}" not yet supported by converter — skipped.`)
    return `// SKIPPED layer "${layer.id}" type="${layer.type}" — unsupported by current X-GIS engine.`
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
  const utils = paintToUtilities(layer, warnings)
  if (utils.length > 0) {
    lines.push('  | ' + utils.join(' '))
  }
  lines.push('}')
  return lines.join('\n')
}

function paintToUtilities(layer: MapboxLayer, warnings: string[]): string[] {
  const out: string[] = []
  const p = layer.paint ?? {}

  if (layer.type === 'fill') {
    addFill(out, p['fill-color'], warnings)
    addOpacity(out, p['fill-opacity'], warnings)
  } else if (layer.type === 'line') {
    addStroke(out, p['line-color'], warnings)
    addStrokeWidth(out, p['line-width'], warnings)
    addStrokeDash(out, p['line-dasharray'], warnings)
    addOpacity(out, p['line-opacity'], warnings)
  } else if (layer.type === 'fill-extrusion') {
    addFill(out, p['fill-extrusion-color'], warnings)
    addOpacity(out, p['fill-extrusion-opacity'], warnings)
    const h = exprToXgis(p['fill-extrusion-height'], warnings)
    if (h !== null) out.push(`fill-extrusion-height-${maybeBracket(h)}`)
    const b = exprToXgis(p['fill-extrusion-base'], warnings)
    if (b !== null) out.push(`fill-extrusion-base-${maybeBracket(b)}`)
  }

  return out
}

function addFill(out: string[], v: unknown, warnings: string[]): void {
  if (v === undefined) return
  const s = colorToXgis(v, warnings)
  if (s) out.push(`fill-${s}`)
}

function addStroke(out: string[], v: unknown, warnings: string[]): void {
  if (v === undefined) return
  const s = colorToXgis(v, warnings)
  if (s) out.push(`stroke-${s}`)
}

function addStrokeWidth(out: string[], v: unknown, warnings: string[]): void {
  if (v === undefined) return
  const x = exprToXgis(v, warnings)
  if (x === null) return
  // Tailwind-style suffix: number → `stroke-1.5`, expression → bracket form.
  out.push(`stroke-${maybeBracket(x)}`)
}

function addStrokeDash(out: string[], v: unknown, _warnings: string[]): void {
  if (!Array.isArray(v)) return
  const nums = v.filter(n => typeof n === 'number')
  if (nums.length < 2) return
  out.push('stroke-dasharray-' + nums.join('-'))
}

function addOpacity(out: string[], v: unknown, warnings: string[]): void {
  if (v === undefined) return
  if (typeof v === 'number') {
    // Mapbox 0..1, X-GIS opacity-N where N can be 0..100 or 0..1.
    out.push(`opacity-${v <= 1 ? Math.round(v * 100) : v}`)
    return
  }
  const x = exprToXgis(v, warnings)
  if (x !== null) out.push(`opacity-${maybeBracket(x)}`)
}

// ═══ Color conversion ════════════════════════════════════════════════

function colorToXgis(v: unknown, warnings: string[]): string | null {
  if (v == null) return null
  if (typeof v === 'string') {
    if (v.startsWith('#')) return v
    // CSS function colours (rgb / rgba / hsl / hsla) — resolve to hex
    // so the result is usable in utility-class position. The xgis
    // lexer can't parse `fill-hsla(0,60%,87%,0.23)` — parens aren't
    // valid in a utility-name token — but `fill-#abcdef33` is fine.
    const hex = resolveColor(v.trim())
    if (hex) return hex
    return v
  }
  // Expression form (`["interpolate", ...]` returning colors,
  // `["match", …]` mapping to colors, etc.)
  if (Array.isArray(v) && v[0] === 'rgba' && v.length === 5) {
    const [, r, g, b, a] = v
    const A = typeof a === 'number' ? a : 1
    const hex = resolveColor(`rgba(${r}, ${g}, ${b}, ${A})`)
    if (hex) return hex
  }
  if (Array.isArray(v) && v[0] === 'rgb' && v.length === 4) {
    const [, r, g, b] = v
    const hex = resolveColor(`rgb(${r}, ${g}, ${b})`)
    if (hex) return hex
  }
  // Fall back: emit a comment-bracketed expr so the user sees what
  // came in. Avoids producing unparseable utility names for complex
  // colour expressions we haven't taught the converter yet.
  warnings.push(`Color expression not converted: ${JSON.stringify(v).slice(0, 120)}`)
  return null
}

// ═══ Expression conversion (Mapbox v1 expressions) ═══════════════════

function exprToXgis(v: unknown, warnings: string[]): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (typeof v === 'string') return JSON.stringify(v) // quoted string literal
  if (!Array.isArray(v)) return null
  const op = v[0]
  switch (op) {
    case 'literal':
      return exprToXgis(v[1], warnings)
    case 'get': {
      const field = v[1]
      const obj = v[2]
      if (typeof field !== 'string') return null
      if (obj !== undefined) {
        warnings.push(`["get", "${field}", <obj>] with explicit object — converted as plain field access; verify scope.`)
      }
      return `.${field}`
    }
    case 'has': {
      const field = v[1]
      if (typeof field !== 'string') return null
      return `.${field} != null`
    }
    case '!has': {
      const field = v[1]
      if (typeof field !== 'string') return null
      return `.${field} == null`
    }
    case 'coalesce': {
      const args = v.slice(1).map(a => exprToXgis(a, warnings))
      const valid = args.filter((a): a is string => a !== null)
      if (valid.length === 0) return null
      return valid.join(' ?? ')
    }
    case 'case': {
      // ["case", cond1, val1, cond2, val2, …, default]
      // → cond1 ? val1 : cond2 ? val2 : … : default
      // X-GIS supports `cond ? a : b` ternary.
      const args = v.slice(1)
      if (args.length < 3 || args.length % 2 === 0) {
        warnings.push(`Malformed ["case"] expression: ${JSON.stringify(v).slice(0, 120)}`)
        return null
      }
      const def = exprToXgis(args[args.length - 1], warnings)
      let result = def ?? '0'
      for (let i = args.length - 3; i >= 0; i -= 2) {
        const cond = exprToXgis(args[i], warnings)
        const val = exprToXgis(args[i + 1], warnings)
        if (cond === null || val === null) continue
        result = `${cond} ? ${val} : ${result}`
      }
      return result
    }
    case 'match': {
      // ["match", input, key1, val1, key2, val2, …, default]
      // X-GIS has `match(.field) { key -> value, _ -> default }`
      const input = v[1]
      const args = v.slice(2)
      if (args.length < 1 || args.length % 2 !== 1) {
        warnings.push(`Malformed ["match"] expression: ${JSON.stringify(v).slice(0, 120)}`)
        return null
      }
      const inputXgis = exprToXgis(input, warnings)
      if (inputXgis === null || !inputXgis.startsWith('.')) {
        // X-GIS match() takes a field access; complex inputs not
        // supported. Rewrite to chained ?: as a fallback.
        return matchToTernary(input, args, warnings)
      }
      const arms: string[] = []
      const def = args[args.length - 1]
      for (let i = 0; i < args.length - 1; i += 2) {
        const key = args[i]
        const val = exprToXgis(args[i + 1], warnings)
        if (val === null) continue
        const keyStrs = Array.isArray(key) ? key : [key]
        for (const k of keyStrs) {
          arms.push(`    ${typeof k === 'string' ? JSON.stringify(k) : k} -> ${val}`)
        }
      }
      const defXgis = exprToXgis(def, warnings)
      if (defXgis !== null) arms.push(`    _ -> ${defXgis}`)
      return `match(${inputXgis}) {\n${arms.join(',\n')}\n  }`
    }
    case 'all': {
      const parts = v.slice(1).map(a => filterToXgis(a, warnings)).filter((s): s is string => !!s)
      if (parts.length === 0) return 'true'
      return parts.map(parenthesize).join(' && ')
    }
    case 'any': {
      const parts = v.slice(1).map(a => filterToXgis(a, warnings)).filter((s): s is string => !!s)
      if (parts.length === 0) return 'false'
      return parts.map(parenthesize).join(' || ')
    }
    case '!': {
      const inner = filterToXgis(v[1], warnings)
      return inner ? `!(${inner})` : null
    }
    // Comparison / arithmetic operators map identically.
    case '==': case '!=': case '<': case '<=': case '>': case '>=':
    case '+': case '-': case '*': case '/': case '%': {
      if (v.length !== 3) return null
      const a = exprToXgis(v[1], warnings)
      const b = exprToXgis(v[2], warnings)
      if (a === null || b === null) return null
      return `${a} ${op} ${b}`
    }
    case 'min': case 'max': {
      const args = v.slice(1).map(x => exprToXgis(x, warnings)).filter((s): s is string => s !== null)
      return args.length > 0 ? `${op}(${args.join(', ')})` : null
    }
    case 'to-number': case 'number': {
      // X-GIS evaluator coerces in arithmetic; pass through the inner.
      return exprToXgis(v[1], warnings)
    }
    case 'geometry-type':
    case 'id': {
      // Expression-form pseudo-accessors (used inside ["==", ["geometry-type"], …]).
      // Same rationale as the $type / $id legacy filter case above —
      // dropped sub-expression bubbles `null` through the parent ==/!=.
      warnings.push(`["${op}"] dropped — no xgis feature-meta accessor.`)
      return null
    }
    case 'in': {
      // ["in", value, ["literal", [...]]]  OR  legacy  ["in", "field", v1, v2, …]
      const field = v[1]
      const list = v[2]
      if (Array.isArray(list) && list[0] === 'literal' && Array.isArray(list[1])) {
        const fxg = typeof field === 'string'
          ? `.${field}`
          : exprToXgis(field, warnings)
        if (fxg === null) return null
        const eqs = list[1].map((k: unknown) => `${fxg} == ${typeof k === 'string' ? JSON.stringify(k) : k}`)
        return eqs.join(' || ')
      }
      // Legacy: ["in", field, v1, v2, …]
      if (typeof field === 'string') {
        const eqs = v.slice(2).map(k => `.${field} == ${typeof k === 'string' ? JSON.stringify(k) : k}`)
        return eqs.join(' || ')
      }
      warnings.push(`["in"] form not converted: ${JSON.stringify(v).slice(0, 120)}`)
      return null
    }
  }
  warnings.push(`Expression not converted: ${JSON.stringify(v).slice(0, 120)}`)
  return null
}

/** Lower `["match", input, k1, val1, …, default]` to a boolean
 *  expression when every val (and the default) is a boolean literal.
 *  Returns null when the match is value-typed (caller should keep it
 *  as match()). */
function matchToBooleanFilter(v: unknown[], warnings: string[]): string | null {
  if (v[0] !== 'match' || v.length < 4) return null
  const input = v[1]
  const args = v.slice(2)
  if (args.length % 2 !== 1) return null
  const def = args[args.length - 1]

  // All values + default must be boolean literals for the lowering
  // to make sense — otherwise it's a value-mapping match() and we
  // shouldn't touch it.
  const allBool = (() => {
    if (typeof def !== 'boolean') return false
    for (let i = 1; i < args.length - 1; i += 2) {
      if (typeof args[i] !== 'boolean') return false
    }
    return true
  })()
  if (!allBool) return null

  const inputXgis = exprToXgis(input, warnings)
  if (inputXgis === null) return null

  // Polarity: if default is `false`, emit OR of equality for keys
  // whose value is `true`. If default is `true`, emit AND of
  // inequality for keys whose value is `false` (the "not in <keys>"
  // form).
  const polarity = def === false
  const eqOp = polarity ? '==' : '!='
  const join = polarity ? ' || ' : ' && '
  const targetVal = polarity   // when polarity=true (default false), pick `true` arms

  const parts: string[] = []
  for (let i = 0; i < args.length - 1; i += 2) {
    const key = args[i]
    const val = args[i + 1]
    if (val !== targetVal) continue
    const keys = Array.isArray(key) ? key : [key]
    for (const k of keys) {
      parts.push(`${inputXgis} ${eqOp} ${typeof k === 'string' ? JSON.stringify(k) : k}`)
    }
  }
  if (parts.length === 0) {
    // No matching arms — match collapses to the default literal.
    return String(def)
  }
  return parts.join(join)
}

function matchToTernary(input: unknown, args: unknown[], warnings: string[]): string | null {
  // Used when ["match", <complex>, …] can't go through xgis match()
  // because match() requires a field-access input. Falls back to a
  // chain of `input == key ? value : …`. Less efficient but always
  // expressible.
  const inputXgis = exprToXgis(input, warnings)
  if (inputXgis === null) return null
  const def = exprToXgis(args[args.length - 1], warnings) ?? '0'
  let result = def
  for (let i = args.length - 3; i >= 0; i -= 2) {
    const key = args[i]
    const val = exprToXgis(args[i + 1], warnings)
    if (val === null) continue
    const keyStrs = Array.isArray(key) ? key : [key]
    const cond = keyStrs.map(k => `${inputXgis} == ${typeof k === 'string' ? JSON.stringify(k) : k}`).join(' || ')
    result = `(${cond}) ? ${val} : ${result}`
  }
  return result
}

// ═══ Filter conversion ═══════════════════════════════════════════════
//
// Mapbox accepts both LEGACY ([op, field, value, …]) and EXPRESSION
// (["==", ["get","field"], value]) styles. exprToXgis already handles
// the expression form; this wrapper also accepts the legacy form.

function filterToXgis(v: unknown, warnings: string[]): string | null {
  if (v === null || v === undefined) return null
  if (!Array.isArray(v)) return exprToXgis(v, warnings)
  const op = v[0]

  // Mapbox pseudo-fields ($type, $id) have no xgis equivalent. $type
  // is redundant — layer geometry type is already encoded by which
  // utility class (fill- / stroke- / shape-) the layer uses — so we
  // drop the sub-predicate. $id has no accessor; user has to swap in
  // a real `.field` check after the fact.
  if ((op === '==' || op === '!=' || op === 'in' || op === '!in') &&
      (v[1] === '$type' || v[1] === '$id')) {
    warnings.push(`Filter on "${v[1]}" dropped — no xgis equivalent (geometry type is implied by the layer's utility class).`)
    return null
  }

  // Boolean-returning ["match", input, k1, true, k2, true, …, false]
  // is the standard Mapbox idiom for "input is one of these keys".
  // xgis filter context wants a plain boolean expression, not match()
  // (which is a value-mapping form), so lower to an OR/AND chain.
  if (op === 'match') {
    const lowered = matchToBooleanFilter(v, warnings)
    if (lowered !== null) return lowered
    // Fall through to exprToXgis only if it's a non-boolean match —
    // user will see the warning at the bottom either way.
  }

  // Legacy filter syntax (Mapbox GL JS v0.x / v1.x style spec): the
  // FIELD is the second element, not an ["get", "field"] sub-expr.
  if ((op === '==' || op === '!=' || op === '<' || op === '<=' || op === '>' || op === '>=') &&
      typeof v[1] === 'string' && !Array.isArray(v[2])) {
    const field = v[1]
    const val = v[2]
    return `.${field} ${op} ${typeof val === 'string' ? JSON.stringify(val) : val}`
  }
  // Legacy `!in` — Mapbox v0/v1 style spec.
  if (op === '!in' && typeof v[1] === 'string') {
    const field = v[1]
    const eqs = v.slice(2).map(k => `.${field} != ${typeof k === 'string' ? JSON.stringify(k) : k}`)
    return eqs.join(' && ')
  }
  // Otherwise route through the expression converter — it covers
  // all (non-legacy) forms uniformly.
  return exprToXgis(v, warnings)
}

// ═══ Helpers ═════════════════════════════════════════════════════════

function maybeBracket(x: string): string {
  // Short numeric / identifier values stay bare (`stroke-1.5`); any
  // expression-shaped string gets wrapped in brackets so the xgis
  // utility lexer recognises the data-driven form.
  if (/^-?\d+(\.\d+)?$/.test(x)) return x
  if (/^[\w-]+$/.test(x)) return x
  return `[${x}]`
}

function parenthesize(s: string): string {
  // Wrap with parens when the string contains binary operators that
  // could re-bind under outer && / ||.
  return / (\?\?|\|\||&&|==|!=|<|>|<=|>=|\+|-|\*|\/|%) /.test(s) ? `(${s})` : s
}

function sanitizeId(s: string): string {
  // X-GIS identifiers — keep alphanumerics and underscores; replace
  // others (Mapbox often uses kebab-case like `landcover_glacier`,
  // already valid). Common transformation: dashes → underscores
  // when needed.
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) ? s : s.replace(/[^a-zA-Z0-9_]/g, '_')
}
