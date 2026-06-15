// Mapbox `["interpolate", …]` family → xgis interpolate conversion.
//
// Extracted verbatim from expressions.ts's `_exprToXgisImpl` switch
// (the `interpolate` / `interpolate-lab` / `interpolate-hcl` arm) so
// the god-function shrinks without changing output. The handler
// recurses into the converter; to avoid an import cycle it takes the
// recursion fn (`exprToXgis`) as the `recurse` parameter rather than
// importing expressions.ts.

import { cssBezierEase } from './paint'
import {
  parseSrgbHex, srgbToLab, labToHex, labToLch, lchToLab,
} from '../tokens/colors'

export function convertInterpolate(
  v: unknown[],
  warnings: string[],
  recurse: (x: unknown, w: string[]) => string | null,
): string | null {
  const op = v[0] as string
  // Mapbox `["interpolate", curve, input, x1, y1, x2, y2, …]`. The
  // converter has a dedicated zoom-stops path (paint.ts /
  // interpolateZoomCall) that wraps everything in
  // `interpolate(zoom, …)` and `interpolate_exp(zoom, base, …)`
  // when the input IS `["zoom"]`. NON-zoom inputs — `["get",
  // "magnitude"]`, `["heatmap-density"]`, `["feature-state",
  // "hover"]`, etc. — fall through here so per-feature
  // interpolations don't drop. Common pattern: `circle-radius:
  // interpolate(linear, get("mag"), 0, 1, 10, 20)` for earthquake
  // magnitude scaling, similar for per-feature line-width / opacity.
  // LAB/HCL colour-space interpolation is approximated as
  // linear-RGB — the evaluator has no per-stop colour-space
  // walker yet (same trade-off paint.ts uses for the zoom path).
  if (v.length < 5) return null
  // v8 strict tooling can wrap the curve spec itself as
  // `["literal", ["exponential", 2]]`. Pre-fix the outer literal
  // wrap left curveSpec[0] === 'literal' (not 'exponential'), the
  // exponential branch never fired, and the authored curve fell
  // back to linear silently.
  let curveSpec: unknown = v[1]
  while (Array.isArray(curveSpec) && curveSpec.length === 2 && curveSpec[0] === 'literal'
      && Array.isArray(curveSpec[1])) {
    curveSpec = curveSpec[1]
  }
  const input = recurse(v[2], warnings)
  if (input === null) return null
  let isExp = false
  let base = 1
  // Cubic-bezier control points (when curveSpec is cubic-bezier).
  // Used by the data-driven densification path below (iter 62, mirror
  // of paint.ts:cssBezierEase densification for zoom interpolates).
  let bezierX1 = 0, bezierY1 = 0, bezierX2 = 1, bezierY2 = 1
  let isBezier = false
  if (Array.isArray(curveSpec)) {
    // Mapbox spec: curve type must be one of `linear` / `exponential`
    // / `cubic-bezier`. An unknown curve name silently falls through
    // to linear without diagnostic — surface it so the author sees
    // the typo. Mirror of paint.ts gate (iter 78).
    const cn = curveSpec[0]
    if (typeof cn === 'string'
        && cn !== 'linear' && cn !== 'exponential' && cn !== 'cubic-bezier') {
      warnings.push(`["${op}"] unknown curve type "${cn}". Mapbox spec recognises only linear / exponential / cubic-bezier. Falling back to linear.`)
    }
    if (curveSpec[0] === 'exponential') {
      // v8 strict tooling can wrap the base scalar as
      // `["exponential", ["literal", 2]]`. Without the unwrap the
      // typeof === 'number' gate failed and the exponential curve
      // silently fell back to linear interpolation — the visible
      // diff was line-width / text-size growing on a straight
      // ramp instead of the authored eased curve.
      let b: unknown = curveSpec[1]
      while (Array.isArray(b) && b.length === 2 && b[0] === 'literal') b = b[1]
      if (typeof b === 'number' && Number.isFinite(b) && b !== 1) {
        // Mapbox spec: exponential base must be > 0 (and != 1).
        // Mirror of paint.ts gate (iter 83).
        if (b <= 0) {
          warnings.push(`["${op}", ["exponential", ${b}], …] base must be > 0 per Mapbox spec; got ${b}. Falling back to linear interpolation.`)
        } else {
          isExp = true; base = b
        }
      }
    } else if (curveSpec[0] === 'cubic-bezier') {
      isBezier = true
      // Mapbox spec: cubic-bezier requires EXACTLY 4 control
      // points. Mirror of paint.ts gate (iter 82).
      if (curveSpec.length !== 5) {
        warnings.push(`["${op}", ["cubic-bezier", …]] requires exactly 4 control points (x1, y1, x2, y2); got ${curveSpec.length - 1}. Missing slots default to (0, 0, 1, 1) — verify the authored curve.`)
      }
      // v8 strict tooling can wrap individual control points as
      // `["literal", N]`; unwrap so the typeof gate accepts both
      // bare and wrapped forms — mirror of paint.ts cubic-bezier
      // handler's unwrapCP helper.
      const unwrapCP = (v: unknown, fallback: number): number => {
        while (Array.isArray(v) && v.length === 2 && v[0] === 'literal') v = v[1]
        return typeof v === 'number' && Number.isFinite(v) ? v : fallback
      }
      bezierX1 = unwrapCP(curveSpec[1], 0)
      bezierY1 = unwrapCP(curveSpec[2], 0)
      bezierX2 = unwrapCP(curveSpec[3], 1)
      bezierY2 = unwrapCP(curveSpec[4], 1)
      // CSS cubic-bezier spec: x1 + x2 MUST be in [0, 1] for
      // monotonic x(t). Mirror of paint.ts gate (iter 103).
      if (bezierX1 < 0 || bezierX1 > 1 || bezierX2 < 0 || bezierX2 > 1) {
        warnings.push(`["${op}", ["cubic-bezier", ${bezierX1}, ${bezierY1}, ${bezierX2}, ${bezierY2}], …]: x control points (x1=${bezierX1}, x2=${bezierX2}) must be in [0, 1] per CSS spec; the curve becomes non-invertible outside that range and the eased output is undefined.`)
      }
    }
  }
  const isLab = op === 'interpolate-lab' || op === 'interpolate-hcl'
  // Stops follow as flat (xi, yi) pairs. The trailing-arg-count
  // parity check fires BEFORE the loop so a malformed
  // ["interpolate", curve, input, x1, y1, x2] (missing y2) emits
  // a warning rather than silently dropping x2. Pre-fix the loop
  // bound `i + 1 < v.length` short-circuited on the odd-trailing
  // arg and the authored stop vanished without any diagnostic —
  // styles in the wild that hand-edited a stop pair off centre
  // lost the trailing transition silently.
  const stopArgCount = v.length - 3
  if (stopArgCount % 2 !== 0) {
    warnings.push(`["${op}"] has an odd number of stop arguments (${stopArgCount}); trailing unpaired value dropped.`)
  }
  const stopArgs: string[] = []
  for (let i = 3; i + 1 < v.length; i += 2) {
    // Mapbox spec strict: stop x-values MUST be literal finite
    // numbers. Expression-form x-values (e.g. `["get", "k"]`)
    // pre-fix routed through exprToXgis and emitted runtime
    // identifiers — the resulting interpolate() call had a
    // non-monotonic / non-numeric stop axis at evaluation time
    // which silently degenerates to the default-arm value. Unwrap
    // ["literal", N] wraps because v8 strict tooling can emit
    // those for explicit numeric literals.
    let rawZ: unknown = v[i]
    while (Array.isArray(rawZ) && rawZ.length === 2 && rawZ[0] === 'literal') rawZ = rawZ[1]
    if (typeof rawZ !== 'number' || !Number.isFinite(rawZ)) {
      const stopIdx = ((i - 3) / 2) | 0
      warnings.push(`["${op}"] stop ${stopIdx + 1} x-value must be a literal finite number per Mapbox spec; got ${JSON.stringify(v[i]).slice(0, 80)}. Whole interpolate bails.`)
      return null
    }
    const z = String(rawZ)
    const y = recurse(v[i + 1], warnings)
    if (y === null) {
      const stopIdx = ((i - 3) / 2) | 0
      warnings.push(`["${op}"] stop ${stopIdx + 1} value failed to convert; whole interpolate bails.`)
      return null
    }
    stopArgs.push(z, y)
  }
  if (stopArgs.length < 4) return null

  // Mapbox spec: stops must be in strictly ascending order on
  // the input axis. Non-monotonic stops produce undefined
  // evaluator output. Warn at compile time so the author sees
  // the diagnostic rather than silently rendering wrong values.
  // (Parallel to the paint.ts:interpolateZoomStops gate.)
  for (let i = 2; i < stopArgs.length; i += 2) {
    const prev = Number(stopArgs[i - 2]!)
    const cur = Number(stopArgs[i]!)
    if (Number.isFinite(prev) && Number.isFinite(cur) && cur <= prev) {
      warnings.push(`["${op}"] stops not strictly ascending: stop input=${cur} <= prior input=${prev}. Mapbox spec requires monotonically increasing input values — evaluator output is undefined for the violating range.`)
      break // one warning per interpolate, not per pair
    }
  }

  // ── Compile-time stop densification for cubic-bezier and Lab/LCh
  // colour-space curves over data-driven inputs (iter 62, mirror of
  // paint.ts:interpolateZoomStops densification for zoom inputs).
  // The runtime sees ordinary linear `interpolate(input, …)` with a
  // longer stop list that visually approximates the authored eased
  // / perceptual curve. Densification requires literal stop values
  // — when a stop value is itself an expression (`["get", "k"]`
  // etc.), compile-time eased samples can't be computed and the
  // stops fall through to plain linear with a graceful-downgrade
  // warning.
  if (isBezier) {
    // stopArgs is [z0, y0, z1, y1, ...] strings. Densify iff all y
    // strings parse as finite numeric literals.
    const numericStops: Array<{ z: number; v: number }> = []
    let allNumeric = true
    for (let i = 0; i < stopArgs.length; i += 2) {
      const z = Number(stopArgs[i]!)
      const y = Number(stopArgs[i + 1]!)
      if (!Number.isFinite(z) || !Number.isFinite(y)) { allNumeric = false; break }
      numericStops.push({ z, v: y })
    }
    if (allNumeric) {
      const SAMPLES_PER_SEGMENT = 6
      const dense: string[] = []
      for (let i = 0; i < numericStops.length - 1; i++) {
        const a = numericStops[i]!
        const b = numericStops[i + 1]!
        dense.push(String(a.z), String(a.v))
        for (let k = 1; k < SAMPLES_PER_SEGMENT; k++) {
          const t = k / SAMPLES_PER_SEGMENT
          const eased = cssBezierEase(t, bezierX1, bezierY1, bezierX2, bezierY2)
          dense.push(String(a.z + (b.z - a.z) * t), String(a.v + (b.v - a.v) * eased))
        }
      }
      const last = numericStops[numericStops.length - 1]!
      dense.push(String(last.z), String(last.v))
      warnings.push(`["${op}", ["cubic-bezier", ${bezierX1}, ${bezierY1}, ${bezierX2}, ${bezierY2}], …] approximated via dense piecewise-linear samples (${SAMPLES_PER_SEGMENT} per segment) — xgis has no per-stop bezier interpolator at runtime.`)
      return `interpolate(${input}, ${dense.join(', ')})`
    }
    warnings.push(`["${op}", ["cubic-bezier", …], …] folded to linear — xgis has no per-stop bezier interpolator and non-numeric stop values can't be densified at compile time.`)
  }
  if (isLab && !isExp && !isBezier) {
    // Try Lab/LCh densification over hex colour stops. stopArgs y
    // entries are the converted xgis strings — for hex literals
    // these may be either bare `#rrggbb` form OR JSON-quoted
    // `"#rrggbb"` (the latter is what exprToXgis emits for raw
    // string stop values, since strings are quoted at the
    // expression level to survive lexer round-trip).
    const labStops: Array<{ z: number; L: number; a: number; b: number; hex: string; quoted: boolean }> = []
    let allHex = true
    for (let i = 0; i < stopArgs.length; i += 2) {
      const z = Number(stopArgs[i]!)
      let y = stopArgs[i + 1]!
      if (!Number.isFinite(z)) { allHex = false; break }
      // Strip JSON quote wrap if present
      const quoted = y.length >= 2 && y.startsWith('"') && y.endsWith('"')
      const peeled = quoted ? y.slice(1, -1) : y
      const rgb = parseSrgbHex(peeled)
      if (!rgb) { allHex = false; break }
      const [L, a, b] = srgbToLab(rgb[0], rgb[1], rgb[2])
      labStops.push({ z, L, a, b, hex: peeled, quoted })
    }
    if (allHex) {
      const SAMPLES_PER_SEGMENT = 6
      const dense: string[] = []
      const useHcl = op === 'interpolate-hcl'
      // Preserve input quoting convention: if any stop was JSON-
      // quoted, every emitted hex is JSON-quoted too so the
      // resulting interpolate call parses identically.
      const reQuote = labStops.some(s => s.quoted)
      const emit = (hex: string) => reQuote ? `"${hex}"` : hex
      for (let i = 0; i < labStops.length - 1; i++) {
        const a = labStops[i]!
        const b = labStops[i + 1]!
        dense.push(String(a.z), emit(a.hex))
        for (let k = 1; k < SAMPLES_PER_SEGMENT; k++) {
          const t = k / SAMPLES_PER_SEGMENT
          const z = a.z + (b.z - a.z) * t
          let L: number, A: number, B: number
          if (useHcl) {
            const [La, Ca, ha] = labToLch(a.L, a.a, a.b)
            const [Lb, Cb, hb] = labToLch(b.L, b.a, b.b)
            let dh = hb - ha
            if (dh > 180) dh -= 360
            if (dh < -180) dh += 360
            const Lt = La + (Lb - La) * t
            const Ct = Ca + (Cb - Ca) * t
            const ht = ha + dh * t
            ;[L, A, B] = lchToLab(Lt, Ct, ht)
          } else {
            L = a.L + (b.L - a.L) * t
            A = a.a + (b.a - a.a) * t
            B = a.b + (b.b - a.b) * t
          }
          dense.push(String(z), emit(labToHex(L, A, B)))
        }
      }
      const last = labStops[labStops.length - 1]!
      dense.push(String(last.z), emit(last.hex))
      warnings.push(`${op}(…) approximated via dense piecewise-linear sRGB samples (${SAMPLES_PER_SEGMENT} per segment) — perceptually correct in ${useHcl ? 'LCh' : 'Lab'} space at compile time; runtime interpolation between dense hex stops.`)
      return `interpolate(${input}, ${dense.join(', ')})`
    }
    // iter-164 (§11 runtime evaluator): non-hex linear lab/hcl
    // now routes to the dedicated runtime case rather than
    // silently downgrading to linear-sRGB. Stop values may be
    // ANY expression yielding a colour (e.g. `["get","k"]`,
    // `["case",…]`, `rgb(r,g,b)`); the evaluator parses each
    // stop's y as a hex / rgba colour at eval time, interpolates
    // in Lab / LCh space, returns a hex. Exponential lab/hcl
    // (the else-if below) stays as the existing warning — the
    // base curve adds another dimension that would compound the
    // runtime cost; not yet routed.
    const lookup = op === 'interpolate-hcl' ? 'interpolate_hcl' : 'interpolate_lab'
    warnings.push(`${op}(…) routed to runtime ${lookup}(…) — per-feature Lab/LCh interpolation between resolved stop colours. iter 164.`)
    return `${lookup}(${input}, ${stopArgs.join(', ')})`
  } else if (isLab) {
    warnings.push(`${op}(…) with non-linear curve approximated as linear-sRGB — compile-time densification only handles the linear curve.`)
  }

  if (isExp) return `interpolate_exp(${input}, ${base}, ${stopArgs.join(', ')})`
  return `interpolate(${input}, ${stopArgs.join(', ')})`
}
