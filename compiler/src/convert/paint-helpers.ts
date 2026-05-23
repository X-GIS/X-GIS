// ═══ Mapbox paint → xgis: pure helpers ═══
// Side-effect-free helpers extracted from paint.ts. None close over
// module-level mutable state; each is a pure transform of its inputs.
// Kept here so paint.ts stays focused on the per-property emitters.

import {
  parseSrgbHex, srgbToLab, labToHex, labToLch, lchToLab,
} from '../tokens/colors'
import type { InterpolateZoomShape } from './paint-types'

/** Unwrap Mapbox v8's `["literal", value]` wrapper for any scalar /
 *  array stop value or paint scalar input. The callbacks downstream
 *  type-check against the inner concrete type (number / string / array)
 *  and reject the wrapper as "not the shape I expected"; unwrapping
 *  eagerly lets a uniform code path handle both the bare and v8-
 *  strict forms. */
export function unwrapStopLiteral(v: unknown): unknown {
  // Loop unwrap so double-wraps like `["literal", ["literal", 0.5]]`
  // (rare, but emitted by some v8 strict preprocessor chains) peel
  // down to the inner scalar/array in one pass. Mirror of the loop
  // unwrap in colorToXgis (921d5ad).
  while (Array.isArray(v) && v.length === 2 && v[0] === 'literal') {
    v = v[1]
  }
  return v
}

/** True when v should be treated as "property omitted" per Mapbox
 *  spec: bare null/undefined OR `["literal", null]`. Used by every
 *  paint helper's early-return gate to ensure null + v8-wrapped-null
 *  both fall to the default-emission path instead of leaking through
 *  as a runtime `null` identifier binding (commit a969be5). */
export function isOmitted(v: unknown): boolean {
  if (v === undefined || v === null) return true
  // Loop peel so multi-wrapped null (`["literal", ["literal", null]]`)
  // also falls through to "omitted". Mirror of the loop unwrap in
  // colorToXgis (921d5ad) + unwrapStopLiteral (0532bc3). Pre-fix the
  // single-pass check missed double-wrapped nulls and they leaked
  // through to exprToXgis as `null` identifier bindings.
  let cur: unknown = v
  while (Array.isArray(cur) && cur.length === 2 && cur[0] === 'literal') {
    cur = cur[1]
  }
  return cur === null || cur === undefined
}

export function unwrapLiteralScalarLocal(v: unknown): unknown {
  while (Array.isArray(v) && v.length === 2 && v[0] === 'literal') v = v[1]
  return v
}

/** Pull the curve type + stops out of an `["interpolate", curve,
 *  ["zoom"], z1, v1, …]` expression. Returns null when the shape
 *  doesn't match (non-zoom input, missing stops, etc.) so callers
 *  can short-circuit and route through the generic expression
 *  converter instead.
 *
 *  Cubic-bezier curves fall back to linear with a warning — xgis has
 *  no per-stop control-point evaluator yet. */
export function interpolateZoomStops(
  v: unknown,
  warnings?: string[],
): InterpolateZoomShape | null {
  // Legacy stops shape (Mapbox style spec v0 / v1, still emitted by
  // many older styles — incl. the MapLibre demo basemap):
  //   { "stops": [[zoom, value], …], "base"?: number }
  // Modern equivalent:
  //   ["interpolate", ["exponential", base], ["zoom"], zoom, value, …]
  // Lift the legacy shape into the same InterpolateZoomShape so all
  // downstream emit/lower code (interpolate_exp / interpolate-zoom-
  // color stops / etc.) sees one canonical form. Without this lift,
  // every legacy-style line-width / fill-color / text-size silently
  // collapsed to its default in the converter output.
  if (
    v !== null && typeof v === 'object' && !Array.isArray(v)
    && Array.isArray((v as { stops?: unknown }).stops)
  ) {
    const rawStops = (v as { stops: unknown[] }).stops
    const legacyStops: Array<{ zoom: number; value: unknown }> = []
    for (const s of rawStops) {
      if (!Array.isArray(s) || s.length < 2) return null
      // Unwrap v8 strict `["literal", N]` on the zoom key — same pattern
      // as the modern interpolate path. Pre-fix a wrapped zoom key
      // failed the typeof === 'number' gate and the legacy stops form
      // returned null, dropping the property to its default.
      const z = unwrapStopLiteral(s[0])
      // Number.isFinite rejects NaN — pre-fix a NaN zoom key (rare
      // but observed in malformed legacy v0/v1 styles where the
      // stop pair was hand-edited) landed in `legacyStops` as the
      // zoom value; downstream sort + bounds-clamp at the
      // interpolate evaluator returned NaN at every zoom, the
      // emitted utility silently collapsed.
      if (typeof z !== 'number' || !Number.isFinite(z)) return null
      legacyStops.push({ zoom: z, value: unwrapStopLiteral(s[1]) })
    }
    if (legacyStops.length < 2) return null
    const rawBase = (v as { base?: unknown }).base
    // Number.isFinite gate rejects NaN — `NaN !== 1` is true so a
    // typeof-only check would let a NaN base land in the IR as the
    // exponential curve's base, propagating through interpolate_exp
    // math to NaN at the renderer.
    const base = typeof rawBase === 'number' && Number.isFinite(rawBase) && rawBase !== 1 ? rawBase : 1
    return {
      curve: base === 1 ? 'linear' : 'exponential',
      base,
      stops: legacyStops,
    }
  }

  // `interpolate-lab` / `interpolate-hcl` (Mapbox v3 perceptually-uniform
  // colour interp in CIELAB / CIEHCL space) accepted as a graceful
  // downgrade to linear-RGB interpolation. X-GIS doesn't have a per-
  // stop colour-space evaluator yet, so falling back to linear is the
  // same loss-prevention pattern cubic-bezier already uses below.
  if (!Array.isArray(v)) return null
  if (v[0] !== 'interpolate' && v[0] !== 'interpolate-lab' && v[0] !== 'interpolate-hcl') return null
  const isLabHcl = v[0] === 'interpolate-lab' || v[0] === 'interpolate-hcl'
  // v8 strict tooling can wrap the curve spec itself as
  // `["literal", ["exponential", 2]]`. Pre-fix the wrapped form left
  // curveSpec[0] === 'literal' (not 'exponential'/'cubic-bezier'),
  // the curve recognition fell through, and the authored exponential
  // / bezier curve collapsed to linear without a warning.
  let curveSpec: unknown = v[1]
  while (Array.isArray(curveSpec) && curveSpec.length === 2 && curveSpec[0] === 'literal'
      && Array.isArray(curveSpec[1])) {
    curveSpec = curveSpec[1]
  }
  // Element 2 must be the `zoom` accessor.
  const input = v[2]
  if (!Array.isArray(input) || input[0] !== 'zoom') return null
  const stops: Array<{ zoom: number; value: unknown }> = []
  for (let i = 3; i + 1 < v.length; i += 2) {
    // Unwrap v8 strict `["literal", N]` on the zoom key — mirror of
    // the same unwrap applied to each stop value below. Pre-fix a
    // wrapped zoom key failed the typeof === 'number' gate and the
    // entire interpolate-zoom returned null → property fell to its
    // default (e.g. line-width snapping to 1px regardless of zoom).
    const z = unwrapStopLiteral(v[i])
    // Number.isFinite — mirror of the legacy-stops NaN guard above.
    if (typeof z !== 'number' || !Number.isFinite(z)) return null
    // Mapbox v8 allows each stop's value to be wrapped in `["literal",
    // …]`. Unwrap eagerly so the numeric / colour callbacks
    // downstream see the bare value — without this each
    // `(val) => typeof val === 'number' ? String(val) : null` callback
    // returns null on the wrap and the whole interpolate fails.
    stops.push({ zoom: z, value: unwrapStopLiteral(v[i + 1]) })
  }
  if (stops.length < 2) return null

  // Mapbox spec: stops must be in strictly ascending order on the
  // input axis. Non-monotonic stops produce undefined evaluator
  // output (the runtime scan picks the first range matching the
  // input). Warn at compile time so the author sees the diagnostic
  // rather than silently rendering wrong values.
  for (let i = 1; i < stops.length; i++) {
    if (stops[i]!.zoom <= stops[i - 1]!.zoom) {
      warnings?.push(`["${v[0]}"] stops not strictly ascending: stop ${i} zoom=${stops[i]!.zoom} <= stop ${i - 1} zoom=${stops[i - 1]!.zoom}. Mapbox spec requires monotonically increasing input values — evaluator output is undefined for the violating range.`)
      break // one warning per interpolate, not per pair
    }
  }

  let curve: 'linear' | 'exponential' = 'linear'
  let base = 1
  if (Array.isArray(curveSpec)) {
    // Mapbox spec: curve type must be one of `linear` / `exponential` /
    // `cubic-bezier`. An unknown curve name silently falls through to
    // linear below without diagnostic — surface it so the author sees
    // the typo at compile time. (Linear itself is recognised by the
    // outer `if (Array.isArray(curveSpec))` + falling through with
    // defaults; this gate only fires for truly unknown names.)
    const cn = curveSpec[0]
    if (typeof cn === 'string'
        && cn !== 'linear' && cn !== 'exponential' && cn !== 'cubic-bezier') {
      warnings?.push(`["${v[0]}"] unknown curve type "${cn}". Mapbox spec recognises only linear / exponential / cubic-bezier. Falling back to linear.`)
    }
    if (curveSpec[0] === 'exponential') {
      // v8 strict tooling can wrap the base scalar as
      // `["exponential", ["literal", 2]]`. Mirror of the same unwrap
      // in expressions.ts's interpolate handler. Without it the
      // typeof === 'number' gate failed and the exponential curve
      // silently fell back to linear interpolation.
      let b: unknown = curveSpec[1]
      while (Array.isArray(b) && b.length === 2 && b[0] === 'literal') b = b[1]
      // base === 1 is mathematically identical to linear; collapse so
      // the runtime takes the cheaper code path.
      if (typeof b === 'number' && Number.isFinite(b) && b !== 1) {
        // Mapbox spec: exponential base must be > 0 (and != 1).
        // Negative / zero / non-finite base produces a degenerate
        // curve at the evaluator (pow(neg, frac) is NaN, pow(0, neg)
        // is Infinity). Surface so the author sees the spec violation.
        if (b <= 0) {
          warnings?.push(`["${v[0]}", ["exponential", ${b}], …] base must be > 0 per Mapbox spec; got ${b}. Falling back to linear interpolation.`)
        } else {
          // Mirror of the legacy-stops base NaN guard above.
          curve = 'exponential'
          base = b
        }
      }
    } else if (curveSpec[0] === 'cubic-bezier') {
      // Mapbox spec: cubic-bezier requires EXACTLY 4 control points
      // (x1, y1, x2, y2). Malformed forms (e.g. `["cubic-bezier",
      // 0.42]`) previously silently defaulted to (0.42, 0, 1, 1)
      // with no diagnostic — the authored curve was nonsense + the
      // emitted curve didn't reflect it either.
      if (curveSpec.length !== 5) {
        warnings?.push(`["${v[0]}", ["cubic-bezier", …]] requires exactly 4 control points (x1, y1, x2, y2); got ${curveSpec.length - 1}. Missing slots default to (0, 0, 1, 1) — verify the authored curve.`)
      }
      // CSS cubic-bezier easing approximated by dense piecewise-linear
      // resampling at compile time. For each adjacent stop pair we
      // insert SAMPLES_PER_SEGMENT intermediate stops with eased Y
      // values — the runtime then does its normal linear interpolate
      // between the dense stops and visually approximates the bezier.
      // This only works when stop values are numeric; colour / array
      // values still warn-and-fold-to-linear (see else branch).
      // v8 strict tooling can wrap individual control points as
      // `["literal", N]`; unwrap so the typeof gate accepts both bare
      // and wrapped forms instead of silently degrading to (0,0,1,1)
      // linear.
      const unwrapCP = (v: unknown, fallback: number): number => {
        while (Array.isArray(v) && v.length === 2 && v[0] === 'literal') v = v[1]
        return typeof v === 'number' && Number.isFinite(v) ? v : fallback
      }
      const x1 = unwrapCP(curveSpec[1], 0)
      const y1 = unwrapCP(curveSpec[2], 0)
      const x2 = unwrapCP(curveSpec[3], 1)
      const y2 = unwrapCP(curveSpec[4], 1)
      // CSS cubic-bezier spec: x1 + x2 MUST be in [0, 1] (so x(t) is
      // monotonic on [0, 1] and the curve is invertible). y1 + y2 can
      // be any value (overshoot curves are common in CSS animations).
      // Out-of-range x produces a non-invertible curve — Newton-
      // Raphson then converges to weird values. Surface so the
      // author sees the spec violation.
      if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) {
        warnings?.push(`["${v[0]}", ["cubic-bezier", ${x1}, ${y1}, ${x2}, ${y2}], …]: x control points (x1=${x1}, x2=${x2}) must be in [0, 1] per CSS spec; the curve becomes non-invertible outside that range and the eased output is undefined.`)
      }
      const allNumeric = stops.every(s => typeof s.value === 'number' && Number.isFinite(s.value as number))
      if (allNumeric) {
        const SAMPLES_PER_SEGMENT = 6
        const dense: typeof stops = []
        for (let i = 0; i < stops.length - 1; i++) {
          const a = stops[i]!
          const b = stops[i + 1]!
          dense.push(a)
          const az = a.zoom, bz = b.zoom
          const av = a.value as number
          const bv = b.value as number
          for (let k = 1; k < SAMPLES_PER_SEGMENT; k++) {
            const t = k / SAMPLES_PER_SEGMENT
            const eased = cssBezierEase(t, x1, y1, x2, y2)
            dense.push({
              zoom: az + (bz - az) * t,
              value: av + (bv - av) * eased,
            })
          }
        }
        dense.push(stops[stops.length - 1]!)
        warnings?.push(`["interpolate", ["cubic-bezier", ${x1}, ${y1}, ${x2}, ${y2}], ["zoom"], …] approximated via dense piecewise-linear samples (${SAMPLES_PER_SEGMENT} per segment) — xgis has no per-stop bezier interpolator at runtime.`)
        return { curve, base, stops: dense }
      }
      warnings?.push(`["interpolate", ["cubic-bezier", …], ["zoom"], …] folded to linear — xgis has no per-stop bezier interpolator and non-numeric stop values can't be densified at compile time.`)
    }
  }
  // Interpolate-lab / interpolate-hcl densification (Plan §11 follow-
  // up). When all stop values are hex colours, resample each adjacent
  // stop pair in Lab/LCh space at SAMPLES_PER_SEGMENT intermediate
  // values, converting each sample back to a hex colour. The runtime
  // then linearly interpolates between the dense hex stops in
  // gamma-sRGB — visually approximating the authored perceptual-
  // colour-space interpolation. Endpoints preserved exactly so styles
  // that depend on z<=z_first / z>=z_last hex colours render
  // identically to the authored intent.
  //
  // Both the linear AND exponential curves densify here. For the
  // exponential curve the sample's COLOUR uses the Mapbox progress
  // warp `t' = (base^(z-az) - 1) / (base^(bz-az) - 1)` (canonical form
  // at evaluator.ts:553-554) while the dense stop's ZOOM stays at the
  // linear position — the runtime's linear interpolate between dense
  // stops then reproduces the exponential easing the same way the
  // cubic-bezier branch above reproduces its easing. The emitted
  // curve is downgraded to 'linear' so the runtime does NOT re-apply
  // the exponential warp on top of the already-warped dense samples.
  if (isLabHcl && (curve === 'linear' || curve === 'exponential')) {
    const labStops: Array<{ zoom: number; L: number; a: number; b: number }> = []
    let allColour = true
    for (const s of stops) {
      if (typeof s.value !== 'string') { allColour = false; break }
      const rgb = parseSrgbHex(s.value)
      if (!rgb) { allColour = false; break }
      const [L, a, b] = srgbToLab(rgb[0], rgb[1], rgb[2])
      labStops.push({ zoom: s.zoom, L, a, b })
    }
    if (allColour) {
      const SAMPLES_PER_SEGMENT = 6
      const dense: typeof stops = []
      const useHcl = v[0] === 'interpolate-hcl'
      const isExp = curve === 'exponential' && Math.abs(base - 1) >= 1e-6
      for (let i = 0; i < labStops.length - 1; i++) {
        const a = labStops[i]!
        const b = labStops[i + 1]!
        dense.push({ zoom: a.zoom, value: stops[i]!.value })
        const span = b.zoom - a.zoom
        // Exponential denominator is constant per segment.
        const denom = isExp ? Math.pow(base, span) - 1 : 1
        for (let k = 1; k < SAMPLES_PER_SEGMENT; k++) {
          const p = k / SAMPLES_PER_SEGMENT
          const z = a.zoom + span * p
          // Colour interpolation parameter: linear curve uses the
          // raw fraction; exponential warps it (degenerate denom==0
          // — e.g. span 0 — already excluded by ascending-stop guard).
          const t = isExp ? (Math.pow(base, span * p) - 1) / denom : p
          let L: number, A: number, B: number
          if (useHcl) {
            // Interpolate in LCh (polar) space — hue takes shortest
            // angular path (mod 360, choose direction by smaller arc).
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
          dense.push({ zoom: z, value: labToHex(L, A, B) })
        }
      }
      dense.push({
        zoom: labStops[labStops.length - 1]!.zoom,
        value: stops[stops.length - 1]!.value,
      })
      const curveDesc = isExp ? `exponential base ${base}` : 'linear'
      warnings?.push(`${v[0]}(…) [${curveDesc}] approximated via dense piecewise-linear sRGB samples (${SAMPLES_PER_SEGMENT} per segment) — perceptually correct in ${useHcl ? 'LCh' : 'Lab'} space at compile time; runtime interpolation between dense hex stops.`)
      // Dense samples already carry the exponential warp — emit linear
      // so the runtime doesn't double-apply it.
      return { curve: 'linear', base: 1, stops: dense }
    }
    // Non-hex stops (data-driven values etc.) fall through with a
    // graceful-downgrade warning matching the prior behaviour. This is
    // the genuine §11 remnant: closing it needs a runtime LAB/HCL
    // per-stop evaluator (non-hex values can't be densified ahead of
    // time because the colour isn't known until feature eval).
    warnings?.push(`${v[0]}(…) approximated as linear-sRGB — xgis has no LAB/HCL per-stop evaluator at runtime and non-hex stop values can't be densified at compile time.`)
  }
  return { curve, base, stops }
}

/** CSS cubic-bezier easing function: given a normalized parameter
 *  t ∈ [0, 1] along the input axis and control points (x1, y1) +
 *  (x2, y2), returns the eased y value. The CSS spec defines the
 *  curve parametrically — both x and y are cubic Bezier polynomials
 *  in a parameter s ∈ [0, 1]. We invert numerically: find s such
 *  that x(s) == t, then evaluate y(s).
 *
 *  Newton-Raphson with 8 iterations converges within ~1e-7 for the
 *  standard CSS control points (x1/x2 ∈ [0, 1]) — well below the
 *  visible discretization of the runtime interpolate. Fallback to
 *  bisection if the derivative goes near-zero (rare with valid CSS
 *  control points but covered for robustness). */
export function cssBezierEase(
  t: number, x1: number, y1: number, x2: number, y2: number,
): number {
  if (t <= 0) return 0
  if (t >= 1) return 1
  // x(s) = 3(1-s)² s x1 + 3(1-s) s² x2 + s³
  //      = ((1-3x2+3x1) s + (3x2 - 6x1)) s² + 3x1 s   [Horner-ish]
  // Coefficients of a polynomial a s³ + b s² + c s for the x curve:
  const ax = 1 - 3 * x2 + 3 * x1
  const bx = 3 * x2 - 6 * x1
  const cx = 3 * x1
  const ay = 1 - 3 * y2 + 3 * y1
  const by = 3 * y2 - 6 * y1
  const cy = 3 * y1
  const xOf = (s: number) => ((ax * s + bx) * s + cx) * s
  const dxOf = (s: number) => (3 * ax * s + 2 * bx) * s + cx
  const yOf = (s: number) => ((ay * s + by) * s + cy) * s
  // Newton-Raphson seed at s = t (good approximation when x1/x2
  // close to the diagonal); 8 iterations is plenty for CSS curves.
  let s = t
  for (let i = 0; i < 8; i++) {
    const xs = xOf(s) - t
    if (Math.abs(xs) < 1e-7) return yOf(s)
    const ds = dxOf(s)
    if (Math.abs(ds) < 1e-6) break
    s = s - xs / ds
    if (s < 0) s = 0
    if (s > 1) s = 1
  }
  // Bisection fallback if Newton stalled — guaranteed convergence
  // on a monotonic x(s) (CSS constrains control points so x is
  // monotonic on [0, 1]).
  let lo = 0, hi = 1
  for (let i = 0; i < 24; i++) {
    s = (lo + hi) * 0.5
    const xs = xOf(s)
    if (xs < t) lo = s
    else hi = s
    if (hi - lo < 1e-7) break
  }
  return yOf(s)
}

/** Render a Mapbox interpolate-by-zoom expression as an xgis
 *  `interpolate(zoom, …)` or `interpolate_exp(zoom, base, …)` call.
 *  The xgis evaluator handles the builtin uniformly — zoom-driven
 *  values evaluate per-frame, feature-driven values evaluate per-
 *  feature. Caller supplies an `emitValue` strategy that formats
 *  each stop value (colour, number, expression) into the bit that
 *  follows its zoom key.
 *
 *  Returns null when any stop value can't be formatted, so the
 *  caller can fall back to a more permissive path (e.g. take the
 *  first stop, or drop the property entirely). */
export function interpolateZoomCall(
  v: unknown,
  warnings: string[],
  emitValue: (val: unknown, warnings: string[]) => string | null,
): string | null {
  const shape = interpolateZoomStops(v, warnings)
  if (!shape) return null
  const parts: string[] = []
  for (const s of shape.stops) {
    const out = emitValue(s.value, warnings)
    if (out === null) return null
    parts.push(`${s.zoom}, ${out}`)
  }
  if (shape.curve === 'exponential') {
    return `interpolate_exp(zoom, ${shape.base}, ${parts.join(', ')})`
  }
  return `interpolate(zoom, ${parts.join(', ')})`
}

/** Unwrap Mapbox v8's `["literal", value]` wrapper for numeric paint
 *  helpers. The downstream `typeof === 'number'` shortcut fires only
 *  on the bare numeric form; without this unwrap a v8-wrapped numeric
 *  fell through to exprToXgis and emitted a bracket-binding form
 *  with the inner number as a quoted string. Mirror of the literal-
 *  unwrap pattern in colorToXgis (e3c5c62) and addOpacity (718d21a). */
export function unwrapLiteralNumeric(v: unknown): unknown {
  // Loop unwrap mirrors colorToXgis (921d5ad) so double-wrapped
  // `["literal", ["literal", 1.5]]` peels in one pass.
  while (Array.isArray(v) && v.length === 2 && v[0] === 'literal') {
    v = v[1]
  }
  return v
}
