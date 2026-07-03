// ═══ Expression Evaluator: pure helpers ═══
// Side-effect-free helpers extracted from evaluator.ts. None close
// over module-level mutable state; each is a pure transform of its
// inputs. callBuiltin dispatches built-in functions on already-
// evaluated argument arrays; toNumber/toBool are leaf coercions.

import { parseSrgbHex, srgbToLab, labToHex, labToLch, lchToLab } from '../tokens/colors'
import { evalWithin } from './within'
import { evalDistance } from './distance'
import { collatorCompare, resolvedLocale } from './collator'

// ═══ Built-in functions ═══

export function callBuiltin(name: string, args: unknown[]): unknown {
  switch (name) {
    case 'clamp': {
      const [val, min, max] = args.map(toNumber)
      return Math.max(min, Math.min(max, val))
    }
    case 'min': {
      // Math.min() with no args returns +Infinity. Guard to 0 so the
      // non-finite doesn't propagate. Mirror of c6aa3b0 / c1a30b7.
      if (args.length === 0) return 0
      return Math.min(...args.map(toNumber))
    }
    case 'max': {
      // Math.max() with no args returns -Infinity.
      if (args.length === 0) return 0
      return Math.max(...args.map(toNumber))
    }
    case 'round':
      return Math.round(toNumber(args[0]))
    case 'floor':
      return Math.floor(toNumber(args[0]))
    case 'ceil':
      return Math.ceil(toNumber(args[0]))
    case 'abs':
      return Math.abs(toNumber(args[0]))
    case 'sqrt': {
      // Math.sqrt(-1) = NaN; clamp negative inputs to 0 so the NaN
      // doesn't propagate into downstream arithmetic (consistent with
      // toNumber's non-finite → 0 fallback at c6aa3b0).
      const x = toNumber(args[0])
      return x < 0 ? 0 : Math.sqrt(x)
    }
    case 'log10':
      return Math.log10(Math.max(1e-10, toNumber(args[0])))
    case 'log2':
      return Math.log2(Math.max(1e-10, toNumber(args[0])))
    case 'scale':
      return toNumber(args[0]) * toNumber(args[1])
    case 'step': {
      // Two shapes:
      //   (a) Legacy 4-arg:  step(val, threshold, below, above)
      //   (b) Mapbox N-stop: step(input, def, stop1, val1, stop2, val2, …)
      //                      result = def while input < stop1, else
      //                      walks stops left-to-right and returns the
      //                      val for the largest stop_i ≤ input.
      //
      // Both shapes have args.length === 4 in the minimal N-stop case,
      // so arg-count alone can't disambiguate. Look at args[2]:
      //   - Legacy: args[2] = `below` (any type — colour, string, etc.)
      //   - N-stop: args[2] = `stop1` (MUST be numeric — the cutoff)
      // → numeric args[2] picks N-stop, non-numeric picks legacy.
      // Pre-fix the 4-arg branch unconditionally treated as legacy,
      // which broke the Mapbox-converter emission for label text
      // zoom-stops like `step(zoom, .ABBREV, 4, .NAME)`: .ABBREV
      // became `toNumber("China") = NaN` and labels rendered as
      // "NaN" / blank instead of the intended ABBREV / NAME.
      if (args.length === 4 && typeof args[2] !== 'number') {
        // Legacy step(val, threshold, below, above) — only the input
        // value + threshold are numeric; the below/above payloads
        // pass through verbatim (could be strings, colours, anything).
        // Pre-fix `args.map(toNumber)` coerced ALL FOUR, so
        // step(.size, 12, "small", "large") returned 0 either branch
        // and the label fell back to literal "0" / NaN.
        const val = toNumber(args[0])
        const threshold = toNumber(args[1])
        return val < threshold ? args[2] : args[3]
      }
      if (args.length >= 4 && args.length % 2 === 0) {
        // Mapbox N-stop. Args: [input, def, stop1, val1, stop2, val2, …]
        const input = toNumber(args[0])
        let result: unknown = args[1]
        for (let i = 2; i + 1 < args.length; i += 2) {
          const stop = toNumber(args[i])
          if (input >= stop) result = args[i + 1]
          else break
        }
        return result
      }
      return null
    }
    // String concatenation — Mapbox `["concat", a, b, …]`. Coerces
    // every arg to its string form (numbers via String(), nulls drop).
    case 'concat': {
      let s = ''
      for (const a of args) {
        if (a === null || a === undefined) continue
        s += typeof a === 'string' ? a : String(a)
      }
      return s
    }
    // Case transforms — Mapbox `["downcase", x]` / `["upcase", x]`.
    // Numeric coercion is undefined in spec; we coerce via String().
    case 'downcase':
      return String(args[0] ?? '').toLowerCase()
    case 'upcase':
      return String(args[0] ?? '').toUpperCase()
    case 'typeof': {
      // Mapbox `["typeof", value]` — returns "string" / "number" /
      // "boolean" / "object" / null. JS typeof gives "string" /
      // "number" / "boolean" / "object" / "undefined" / "function" /
      // "symbol" / "bigint". Map null → "null" (Mapbox calls it that
      // for null inputs); collapse the JS-specific kinds.
      const v = args[0]
      if (v === null) return 'null'
      const t = typeof v
      if (t === 'undefined') return 'null'
      if (t === 'bigint') return 'number'
      if (t === 'function' || t === 'symbol') return 'string'
      return t
    }
    case 'slice': {
      // Mapbox `["slice", input, start]` or `["slice", input, start, end]`.
      // Works on strings (substring) and arrays (subarray). Native
      // String#slice / Array#slice handle negative indices (count from
      // end) which Mapbox spec doesn't formally guarantee but most
      // styles assume.
      const input = args[0]
      const start = toNumber(args[1])
      const end = args.length >= 3 ? toNumber(args[2]) : undefined
      if (typeof input === 'string') {
        return end === undefined ? input.slice(start) : input.slice(start, end)
      }
      if (Array.isArray(input)) {
        return end === undefined ? input.slice(start) : input.slice(start, end)
      }
      return null
    }
    case 'index-of':
    case 'index_of': {
      // Mapbox `["index-of", needle, haystack]` or
      // `["index-of", needle, haystack, from_index]`. Returns -1 when
      // not found. The converter emits the underscore form
      // (`index_of`) since the xgis identifier grammar disallows
      // hyphens; both names route here.
      const needle = args[0]
      const haystack = args[1]
      const from = args.length >= 3 ? toNumber(args[2]) : 0
      if (typeof haystack === 'string') {
        return haystack.indexOf(String(needle ?? ''), from)
      }
      if (Array.isArray(haystack)) {
        return haystack.indexOf(needle, from)
      }
      return -1
    }
    case 'number-format':
    case 'number_format': {
      // Two call shapes are accepted:
      //   - Object-options:   number_format(input, { locale, currency,
      //                                              "min-fraction-digits",
      //                                              "max-fraction-digits" })
      //     Direct AST callers (legacy / Mapbox-style synthesis) use this.
      //   - Positional:       number_format(input, minFrac, maxFrac, locale, currency)
      //     The xgis converter emits this form since the parser has no
      //     object-literal syntax. `null` slots mean "spec default".
      const input = toNumber(args[0])
      let minFrac: number | undefined
      let maxFrac: number | undefined
      let locale: string | undefined
      let currency: string | undefined
      const second = args[1]
      if (second && typeof second === 'object' && !Array.isArray(second)) {
        const o = second as Record<string, unknown>
        const mf = o['min-fraction-digits'] ?? o.minFractionDigits
        const xf = o['max-fraction-digits'] ?? o.maxFractionDigits
        if (typeof mf === 'number') minFrac = mf
        if (typeof xf === 'number') maxFrac = xf
        if (typeof o.locale === 'string') locale = o.locale
        if (typeof o.currency === 'string') currency = o.currency
      } else {
        if (typeof second === 'number') minFrac = second
        const a2 = args[2]
        if (typeof a2 === 'number') maxFrac = a2
        const a3 = args[3]
        if (typeof a3 === 'string') locale = a3
        const a4 = args[4]
        if (typeof a4 === 'string') currency = a4
      }
      const intlOpts: Intl.NumberFormatOptions = {}
      if (currency) {
        intlOpts.style = 'currency'
        intlOpts.currency = currency
      }
      if (minFrac !== undefined) intlOpts.minimumFractionDigits = minFrac
      if (maxFrac !== undefined) intlOpts.maximumFractionDigits = maxFrac
      try {
        return new Intl.NumberFormat(locale, intlOpts).format(input)
      } catch {
        return String(input)
      }
    }
    // PI alias — Mapbox `["pi"]` (zero-arg). The existing `PI`
    // builtin used the SCREAMING name; expose lowercase too so the
    // converter can emit a 1:1 name match.
    case 'pi':
      return Math.PI
    case 'e':
      return Math.E
    case 'ln2':
      return Math.LN2
    case 'ln':
      return Math.log(Math.max(1e-10, toNumber(args[0])))
    case 'interpolate':
    case 'interpolate_exp': {
      // interpolate(input, x1, y1, x2, y2, …) — linear interpolation
      // between (xi, yi) stops.
      // interpolate_exp(input, base, x1, y1, x2, y2, …) — Mapbox
      // `["interpolate", ["exponential", base], …]`; same shape but
      // with an extra leading `base` argument that shapes the
      // between-stops curve. base === 1 is mathematically linear.
      const isExp = name === 'interpolate_exp'
      const minArgs = isExp ? 4 : 3
      if (args.length < minArgs) return null
      let cursor = 0
      const input = toNumber(args[cursor++])
      let base = 1
      if (isExp) base = toNumber(args[cursor++])
      const remaining = args.length - cursor
      if (remaining < 2 || remaining % 2 !== 0) return null
      const stops: Array<{ x: number; y: unknown }> = []
      for (let i = cursor; i + 1 < args.length; i += 2) {
        stops.push({ x: toNumber(args[i]), y: args[i + 1] })
      }
      if (stops.length === 0) return null
      if (input <= stops[0].x) return stops[0].y
      if (input >= stops[stops.length - 1].x) return stops[stops.length - 1].y
      for (let i = 0; i + 1 < stops.length; i++) {
        const a = stops[i],
          b = stops[i + 1]
        if (input >= a.x && input <= b.x) {
          if (typeof a.y === 'number' && typeof b.y === 'number') {
            let t: number
            // Guard against duplicate-x stops (a.x === b.x) which
            // would otherwise produce division by zero → Infinity → t
            // NaN-propagates into the final result.
            if (b.x === a.x) {
              t = 0
            } else if (base === 1 || Math.abs(base - 1) < 1e-6) {
              t = (input - a.x) / (b.x - a.x)
            } else {
              const numer = Math.pow(base, input - a.x) - 1
              const denom = Math.pow(base, b.x - a.x) - 1
              t = denom === 0 ? 0 : numer / denom
            }
            if (!Number.isFinite(t)) t = 0
            return a.y + (b.y - a.y) * t
          }
          // Non-numeric — pick the closer stop.
          return input - a.x < b.x - input ? a.y : b.y
        }
      }
      return stops[0].y
    }
    case 'interpolate_lab':
    case 'interpolate_hcl': {
      // §11 runtime evaluator (iter 164). Data-driven Lab/LCh colour
      // interpolation: `interpolate_lab(input, x0, y0, x1, y1, …)`
      // where each yi resolves at eval time to a colour (hex string
      // / "#rrggbb" / "#rrggbbaa", produced by `["get",…]`,
      // `["case",…]`, `rgb(…)`, etc.). Stop x-values must be
      // literal numbers (the converter at expressions.ts:641 already
      // strict-rejects non-numeric stop inputs). For each adjacent
      // pair containing the input value, parse both endpoint colours
      // to sRGB → Lab (or LCh for -hcl, hue-shortest-path),
      // interpolate, convert back to hex.
      // Non-hex resolved colour (e.g. unrecognised) at eval time:
      // fall back to the nearest stop (parallel to the numeric-fail
      // branch in interpolate above). Curve is linear only — the
      // converter routes exponential lab/hcl through the legacy
      // warning, NOT here. (memory project_lovely_launching_eagle_iter_100)
      const useHcl = name === 'interpolate_hcl'
      if (args.length < 3) return null
      const input = toNumber(args[0])
      const remaining = args.length - 1
      if (remaining < 2 || remaining % 2 !== 0) return null
      const stops: Array<{ x: number; y: unknown }> = []
      for (let i = 1; i + 1 < args.length; i += 2) {
        stops.push({ x: toNumber(args[i]), y: args[i + 1] })
      }
      if (stops.length === 0) return null
      if (input <= stops[0].x) return stops[0].y
      if (input >= stops[stops.length - 1].x) return stops[stops.length - 1].y
      const toHex = (v: unknown): string | null => (typeof v === 'string' ? v : null)
      const parseLab = (s: string | null): [number, number, number] | null => {
        if (!s) return null
        const rgb = parseSrgbHex(s)
        if (!rgb) return null
        return srgbToLab(rgb[0], rgb[1], rgb[2])
      }
      for (let i = 0; i + 1 < stops.length; i++) {
        const a = stops[i],
          b = stops[i + 1]
        if (input >= a.x && input <= b.x) {
          const labA = parseLab(toHex(a.y))
          const labB = parseLab(toHex(b.y))
          if (!labA || !labB) {
            return input - a.x < b.x - input ? a.y : b.y
          }
          // Same duplicate-x guard as `interpolate`.
          const t = b.x === a.x ? 0 : (input - a.x) / (b.x - a.x)
          const tt = Number.isFinite(t) ? t : 0
          let L: number, A: number, B: number
          if (useHcl) {
            const [La, Ca, ha] = labToLch(labA[0], labA[1], labA[2])
            const [Lb, Cb, hb] = labToLch(labB[0], labB[1], labB[2])
            let dh = hb - ha
            if (dh > 180) dh -= 360
            if (dh < -180) dh += 360
            const Lt = La + (Lb - La) * tt
            const Ct = Ca + (Cb - Ca) * tt
            const ht = ha + dh * tt
            ;[L, A, B] = lchToLab(Lt, Ct, ht)
          } else {
            L = labA[0] + (labB[0] - labA[0]) * tt
            A = labA[1] + (labB[1] - labA[1]) * tt
            B = labA[2] + (labB[2] - labA[2]) * tt
          }
          return labToHex(L, A, B)
        }
      }
      return stops[0].y
    }
    // Trigonometry
    case 'sin':
      return Math.sin(toNumber(args[0]))
    case 'cos':
      return Math.cos(toNumber(args[0]))
    case 'tan':
      return Math.tan(toNumber(args[0]))
    case 'asin': {
      // Math.asin domain [-1, 1] — outside returns NaN. Clamp so the
      // NaN doesn't propagate downstream (consistent with sqrt clamp).
      const x = toNumber(args[0])
      return Math.asin(Math.max(-1, Math.min(1, x)))
    }
    case 'acos': {
      const x = toNumber(args[0])
      return Math.acos(Math.max(-1, Math.min(1, x)))
    }
    case 'atan':
      return Math.atan(toNumber(args[0]))
    case 'atan2':
      return Math.atan2(toNumber(args[0]), toNumber(args[1]))
    // Exponential
    case 'pow': {
      // Math.pow(-1, 0.5) = NaN, Math.pow(0, -1) = Infinity. Guard
      // both via non-finite → 0 mirror of c6aa3b0 / 2e6e623.
      const r = Math.pow(toNumber(args[0]), toNumber(args[1]))
      return Number.isFinite(r) ? r : 0
    }
    case 'exp': {
      // Math.exp(very-large) = Infinity. Guard.
      const r = Math.exp(toNumber(args[0]))
      return Number.isFinite(r) ? r : 0
    }
    case 'log':
      return Math.log(Math.max(1e-10, toNumber(args[0])))
    // Constants
    case 'PI':
      return Math.PI
    case 'TAU':
      return Math.PI * 2
    // Array
    case 'length': {
      // Mapbox `["length", v]` works on both strings and arrays.
      // Pre-fix the evaluator only returned the array length and
      // collapsed string inputs to 0 — \`["length", ["get", "name"]]\`
      // returned 0 for every feature.
      const v0 = args[0]
      if (Array.isArray(v0)) return v0.length
      if (typeof v0 === 'string') return [...v0].length // codepoint count, not UTF-16 units
      return 0
    }
    // Geometry generators — return coordinate arrays
    case 'circle': {
      const [cx, cy, r, s] = args.map(toNumber)
      // Clamp steps to a reasonable upper bound. A user-authored
      // `circle(x, y, r, 1e9)` would otherwise allocate a billion-
      // entry array and hang the worker. 4096 is the geo-builtin's
      // practical limit (matches MAX_LOOP_ITERATIONS class).
      const steps = Math.max(4, Math.min(4096, Math.floor(s || 32)))
      const pts: number[][] = []
      for (let i = 0; i <= steps; i++) {
        const a = ((i % steps) * Math.PI * 2) / steps
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
      }
      return pts
    }
    case 'arc': {
      const [cx, cy, r, startA, endA, s] = args.map(toNumber)
      // Upper bound matches `circle` (above) — prevent runaway alloc.
      const steps = Math.max(2, Math.min(4096, Math.floor(s || 32)))
      const pts: number[][] = []
      for (let i = 0; i <= steps; i++) {
        const a = startA + ((endA - startA) * i) / steps
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
      }
      return pts
    }
    case 'polygon': {
      // polygon(points) — wrap as GeoJSON-style ring (close if not closed)
      const pts = args[0] as number[][]
      if (!Array.isArray(pts)) return null
      return { type: 'Polygon', coordinates: [pts] }
    }
    case 'linestring': {
      const pts = args[0] as number[][]
      if (!Array.isArray(pts)) return null
      return { type: 'LineString', coordinates: pts }
    }
    // Mapbox to-X conversion builtins. The CONVERTER drops these and
    // emits a coalesce chain (convert/expressions.ts:412), but a
    // direct xgis source author or a Mapbox tooling chain that
    // bypasses the converter may still call them. Iter 539 added —
    // pre-fix the default `args[0] ?? null` branch returned the input
    // unchanged ("abc" → "abc" for to_number), silently breaking
    // strict-equality comparisons downstream.
    case 'to_number':
    case 'number': {
      // Try each arg until one converts to a finite number; null if none.
      for (const a of args) {
        if (typeof a === 'number' && Number.isFinite(a)) return a
        if (typeof a === 'string') {
          const n = Number(a)
          if (Number.isFinite(n)) return n
        }
        if (typeof a === 'boolean') return a ? 1 : 0
        // null / undefined / object — skip
      }
      return null
    }
    case 'to_string':
    case 'string': {
      const v = args[0]
      if (v === null || v === undefined) return ''
      if (typeof v === 'string') return v
      if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
      if (typeof v === 'boolean') return v ? 'true' : 'false'
      return JSON.stringify(v)
    }
    case 'to_boolean':
    case 'boolean': {
      // Mapbox spec: false-y values = false (0, "", null, undefined,
      // NaN). Anything else truthy.
      const v = args[0]
      if (v === null || v === undefined) return false
      if (typeof v === 'number') return v !== 0 && Number.isFinite(v)
      if (typeof v === 'string') return v.length > 0
      if (typeof v === 'boolean') return v
      return true
    }
    case 'to_color': {
      // Iter 541 — Mapbox `["to-color", value, fallback…]`. Try each
      // arg until one parses as a valid CSS-color hex string; null if
      // none. X-GIS represents colours as hex strings (`#rgb` /
      // `#rgba` / `#rrggbb` / `#rrggbbaa`), so "validity" is the
      // CSS Color Module 4 hex regex. Non-string args (numbers,
      // booleans, null) skip to the next fallback.
      const HEX_RE = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
      for (const a of args) {
        if (typeof a === 'string' && HEX_RE.test(a)) return a
      }
      return null
    }
    case 'within': {
      // Mapbox `["within", polygon]` — true when the feature geometry is
      // contained in the argument polygon(s). The converter lowers it to
      // `within(get("$geometry"), <coords>)`, so args[0] is the feature
      // geometry object (or null on paths that don't inject $geometry) and
      // args[1] is the polygon argument as a MultiPolygon-shaped nested
      // array. Pure CPU predicate — see eval/within.ts.
      return evalWithin(args[0], args[1])
    }
    case 'distance': {
      // Mapbox `["distance", target]` → metres between the feature geometry
      // and the target. The converter decomposes the constant target into
      // points / segments / polygons, so args are
      // [geometry, points, segments, polygons]. Pure CPU — see
      // eval/distance.ts.
      return evalDistance(args[0], args[1], args[2], args[3])
    }
    case 'collator_cmp': {
      // Mapbox `["==", a, b, ["collator", opts]]` (and the other 5
      // comparison ops) lowered by the converter. args:
      // [op, a, b, locale, caseSensitive, diacriticSensitive]. Pure CPU
      // locale-aware compare — see eval/collator.ts.
      return collatorCompare(
        String(args[0]),
        args[1],
        args[2],
        String(args[3] ?? ''),
        Boolean(args[4]),
        Boolean(args[5]),
      )
    }
    case 'resolved_locale': {
      // Mapbox `["resolved-locale", ["collator", opts]]` → the BCP-47 tag.
      return resolvedLocale(String(args[0] ?? ''))
    }
    default:
      return args[0] ?? null
  }
}

// ═══ Type coercion helpers ═══

export function toNumber(val: unknown): number {
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0
  if (typeof val === 'string') {
    const n = parseFloat(val)
    // Number.isFinite also rejects Infinity — parseFloat("Infinity")
    // returns Infinity which isNaN doesn't catch, and downstream
    // arithmetic would propagate Infinity into rendered properties.
    // Pre-fix `isNaN(n)` only caught NaN; an "Infinity" string
    // literal in feature properties would slip through.
    return Number.isFinite(n) ? n : 0
  }
  if (typeof val === 'boolean') return val ? 1 : 0
  return 0
}

export function toBool(val: unknown): boolean {
  if (typeof val === 'boolean') return val
  // NaN → false. Mirror of the runtime filter-eval / applyFilter NaN
  // guards: `val !== 0` accepted NaN as truthy and a filter returning
  // NaN (typically from arithmetic on missing/null props) would
  // bypass the authored predicate.
  if (typeof val === 'number') return val !== 0 && Number.isFinite(val)
  if (typeof val === 'string') return val !== ''
  return val !== null && val !== undefined
}
