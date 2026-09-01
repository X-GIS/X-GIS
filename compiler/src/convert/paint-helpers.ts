// ═══ Mapbox paint → xgis: pure helpers ═══
// Side-effect-free helpers extracted from paint.ts. None close over
// module-level mutable state; each is a pure transform of its inputs.
// Kept here so paint.ts stays focused on the per-property emitters.

import { parseSrgbHex, srgbToLab, labToHex, labToLch, lchToLab } from '../tokens/colors'
import type { InterpolateZoomShape } from './paint-types'
import { colorToXgis } from './colors'
import { exprToXgis } from './expressions'
import { maybeBracket } from './utils'
import { isZoomInterpCandidate, unwrapStopLiteral } from './zoom-function-fold'

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
 *  xgis has no per-stop control-point evaluator, so a cubic-bezier curve
 *  is DENSIFIED at compile time into a longer linear stop list whose
 *  samples carry the easing (numeric stops, and — since #2166 — hex-colour
 *  stops in sRGB or, for interpolate-lab / interpolate-hcl, in the authored
 *  Lab / LCh space). Only what cannot be sampled ahead of time — an
 *  expression-valued or non-hex-spelled stop — still falls back to linear
 *  with a warning. */
function interpolateZoomStops(v: unknown, warnings?: string[]): InterpolateZoomShape | null {
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
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Array.isArray((v as { stops?: unknown }).stops)
  ) {
    // FIX #9: Detect legacy Mapbox data-driven property functions before
    // treating the object as a zoom-function. A property function carries
    // a `property` key (the feature attribute to evaluate against). These
    // are silently mishandled — if the stop keys happen to be numbers
    // (e.g. {property:'height', type:'interval', stops:[[0,'#aaa'],…]})
    // the zoom-function path treats them as zoom levels and produces a
    // wrong interpolation with no warning. If the stop keys are strings
    // (e.g. categorical), the typeof-number guard returns null — a silent
    // drop. Either way the output is wrong and the user gets no signal.
    // Emit a clear warning and bail; the caller will fall through to
    // exprToXgis which will also not convert it, but the warning surfaces
    // the loss instead of hiding it.
    if (typeof (v as { property?: unknown }).property === 'string') {
      const propName = (v as { property: string }).property
      const propType =
        typeof (v as { type?: unknown }).type === 'string'
          ? (v as { type: string }).type
          : 'unknown'
      warnings?.push(
        `paint property uses a legacy Mapbox data-driven property function` +
          ` (property: "${propName}", type: "${propType}"). Data-driven` +
          ` property functions are not yet supported by the X-GIS converter;` +
          ` the property falls back to its default. Use a modern Mapbox` +
          ` expression (["match", ["get", "${propName}"], …] or` +
          ` ["step", ["get", "${propName}"], …]) instead.`,
      )
      return null
    }
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
    const base =
      typeof rawBase === 'number' && Number.isFinite(rawBase) && rawBase !== 1 ? rawBase : 1
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
  if (v[0] !== 'interpolate' && v[0] !== 'interpolate-lab' && v[0] !== 'interpolate-hcl')
    return null
  const isLabHcl = v[0] === 'interpolate-lab' || v[0] === 'interpolate-hcl'
  // v8 strict tooling can wrap the curve spec itself as
  // `["literal", ["exponential", 2]]`. Pre-fix the wrapped form left
  // curveSpec[0] === 'literal' (not 'exponential'/'cubic-bezier'),
  // the curve recognition fell through, and the authored exponential
  // / bezier curve collapsed to linear without a warning.
  let curveSpec: unknown = v[1]
  while (
    Array.isArray(curveSpec) &&
    curveSpec.length === 2 &&
    curveSpec[0] === 'literal' &&
    Array.isArray(curveSpec[1])
  ) {
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
      warnings?.push(
        `["${v[0]}"] stops not strictly ascending: stop ${i} zoom=${stops[i]!.zoom} <= stop ${i - 1} zoom=${stops[i - 1]!.zoom}. Mapbox spec requires monotonically increasing input values — evaluator output is undefined for the violating range.`,
      )
      break // one warning per interpolate, not per pair
    }
  }

  let curve: 'linear' | 'exponential' = 'linear'
  let base = 1
  // Cubic-bezier control points, published by the cubic-bezier arm below so
  // the interpolate-lab / interpolate-hcl densifier can apply the SAME
  // easing in the authored perceptual space. Null for every other curve;
  // mutually exclusive with `curve === 'exponential'` by the else-if.
  let bezier: readonly [number, number, number, number] | null = null
  if (Array.isArray(curveSpec)) {
    // Mapbox spec: curve type must be one of `linear` / `exponential` /
    // `cubic-bezier`. An unknown curve name silently falls through to
    // linear below without diagnostic — surface it so the author sees
    // the typo at compile time. (Linear itself is recognised by the
    // outer `if (Array.isArray(curveSpec))` + falling through with
    // defaults; this gate only fires for truly unknown names.)
    const cn = curveSpec[0]
    if (
      typeof cn === 'string' &&
      cn !== 'linear' &&
      cn !== 'exponential' &&
      cn !== 'cubic-bezier'
    ) {
      warnings?.push(
        `["${v[0]}"] unknown curve type "${cn}". Mapbox spec recognises only linear / exponential / cubic-bezier. Falling back to linear.`,
      )
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
          warnings?.push(
            `["${v[0]}", ["exponential", ${b}], …] base must be > 0 per Mapbox spec; got ${b}. Falling back to linear interpolation.`,
          )
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
        warnings?.push(
          `["${v[0]}", ["cubic-bezier", …]] requires exactly 4 control points (x1, y1, x2, y2); got ${curveSpec.length - 1}. Missing slots default to (0, 0, 1, 1) — verify the authored curve.`,
        )
      }
      // CSS cubic-bezier easing approximated by dense piecewise-linear
      // resampling at compile time. For each adjacent stop pair we
      // insert SAMPLES_PER_SEGMENT intermediate stops with eased Y
      // values — the runtime then does its normal linear interpolate
      // between the dense stops and visually approximates the bezier.
      // Numeric stops densify here; hex-colour stops densify in the
      // branch below (in sRGB for `interpolate`, or — for
      // interpolate-lab / interpolate-hcl — in the authored Lab / LCh
      // space via the densifier further down, which reads the control
      // points this arm publishes on `bezier`). Anything else warns
      // and folds to linear.
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
      bezier = [x1, y1, x2, y2]
      // CSS cubic-bezier spec: x1 + x2 MUST be in [0, 1] (so x(t) is
      // monotonic on [0, 1] and the curve is invertible). y1 + y2 can
      // be any value (overshoot curves are common in CSS animations).
      // Out-of-range x produces a non-invertible curve — Newton-
      // Raphson then converges to weird values. Surface so the
      // author sees the spec violation.
      if (x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) {
        warnings?.push(
          `["${v[0]}", ["cubic-bezier", ${x1}, ${y1}, ${x2}, ${y2}], …]: x control points (x1=${x1}, x2=${x2}) must be in [0, 1] per CSS spec; the curve becomes non-invertible outside that range and the eased output is undefined.`,
        )
      }
      const allNumeric = stops.every(
        (s) => typeof s.value === 'number' && Number.isFinite(s.value as number),
      )
      if (allNumeric) {
        const SAMPLES_PER_SEGMENT = 6
        const dense: typeof stops = []
        for (let i = 0; i < stops.length - 1; i++) {
          const a = stops[i]!
          const b = stops[i + 1]!
          dense.push(a)
          const az = a.zoom,
            bz = b.zoom
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
        warnings?.push(
          `["interpolate", ["cubic-bezier", ${x1}, ${y1}, ${x2}, ${y2}], ["zoom"], …] approximated via dense piecewise-linear samples (${SAMPLES_PER_SEGMENT} per segment) — xgis has no per-stop bezier interpolator at runtime.`,
        )
        return { curve, base, stops: dense }
      }
      // Not all-numeric: try HEX COLOUR stops, sampling each segment's
      // colour at the bezier-EASED fraction in sRGB — the space Mapbox's
      // non-lab `interpolate` uses. Mirror of the data-driven twin
      // (expr-interpolate.ts). Segment endpoints keep their authored
      // spelling, as in the Lab/LCh densifier below.
      //
      // `interpolate-lab` / `interpolate-hcl` are EXCLUDED: sampling their
      // ramp in sRGB would silently discard the perceptual colour space the
      // style authored. They fall through to the Lab/LCh densifier below,
      // which applies this same bezier easing in Lab / LCh — measured
      // byte-exact against the pinned reference implementation, where an
      // sRGB sample is not (interpolate-hcl / cubic-bezier(0.42, 0, 0.58,
      // 1) midpoint: #f50086 authored, #800080 in sRGB).
      //
      // 4- and 8-digit hex carry an alpha `parseSrgbHex` drops. Densifying
      // those would silently delete the alpha the plain-linear fold below
      // preserves, so they stay on the fold path.
      const colourStops: Array<[number, number, number]> = []
      let allHex = true
      for (const s of stops) {
        const rgb =
          typeof s.value === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s.value)
            ? parseSrgbHex(s.value)
            : null
        if (!rgb) {
          allHex = false
          break
        }
        colourStops.push(rgb)
      }
      if (allHex && !isLabHcl) {
        const SAMPLES_PER_SEGMENT = 6
        const ch = (c: number) =>
          Math.max(0, Math.min(255, Math.round(c * 255)))
            .toString(16)
            .padStart(2, '0')
        const dense: typeof stops = []
        for (let i = 0; i < stops.length - 1; i++) {
          const a = stops[i]!
          const b = stops[i + 1]!
          const ca = colourStops[i]!
          const cb = colourStops[i + 1]!
          dense.push(a)
          for (let k = 1; k < SAMPLES_PER_SEGMENT; k++) {
            const t = k / SAMPLES_PER_SEGMENT
            const eased = cssBezierEase(t, x1, y1, x2, y2)
            dense.push({
              zoom: a.zoom + (b.zoom - a.zoom) * t,
              value:
                `#${ch(ca[0] + (cb[0] - ca[0]) * eased)}` +
                `${ch(ca[1] + (cb[1] - ca[1]) * eased)}` +
                `${ch(ca[2] + (cb[2] - ca[2]) * eased)}`,
            })
          }
        }
        dense.push(stops[stops.length - 1]!)
        warnings?.push(
          `["${v[0]}", ["cubic-bezier", ${x1}, ${y1}, ${x2}, ${y2}], ["zoom"], …] colour stops approximated via dense piecewise-linear sRGB samples (${SAMPLES_PER_SEGMENT} per segment) at bezier-eased fractions — xgis has no per-stop bezier interpolator at runtime.`,
        )
        return { curve, base, stops: dense }
      }
      // interpolate-lab / interpolate-hcl are NOT folded here — the
      // densifier below owns them and emits its own diagnostic (both for
      // the densified case and for the non-hex one).
      if (!isLabHcl) {
        warnings?.push(
          `["${v[0]}", ["cubic-bezier", …], ["zoom"], …] folded to linear — xgis has no per-stop bezier interpolator and non-numeric, non-hex stop values can't be densified at compile time.`,
        )
      }
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
  // ALL THREE curves densify here — linear, exponential and (since
  // #2166) cubic-bezier. The dense stop's ZOOM always sits at the linear
  // position; only the sample's COLOUR parameter is warped, so the
  // runtime's linear interpolate between dense stops reproduces the
  // authored easing. Exponential uses the Mapbox progress warp
  // `t' = (base^(z-az) - 1) / (base^(bz-az) - 1)` (canonical form at
  // evaluator.ts:553-554); cubic-bezier uses cssBezierEase — the same
  // function the sRGB branch above uses, applied in Lab / LCh so the
  // authored colour space survives the curve. The emitted curve is
  // downgraded to 'linear' so the runtime does NOT re-apply a warp on
  // top of the already-warped dense samples.
  if (isLabHcl && (curve === 'linear' || curve === 'exponential')) {
    const labStops: Array<{ zoom: number; L: number; a: number; b: number }> = []
    let allColour = true
    for (const s of stops) {
      if (typeof s.value !== 'string') {
        allColour = false
        break
      }
      const rgb = parseSrgbHex(s.value)
      if (!rgb) {
        allColour = false
        break
      }
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
          // — e.g. span 0 — already excluded by ascending-stop guard);
          // cubic-bezier eases it. The three are mutually exclusive.
          const t = bezier
            ? cssBezierEase(p, bezier[0], bezier[1], bezier[2], bezier[3])
            : isExp
              ? (Math.pow(base, span * p) - 1) / denom
              : p
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
      const curveDesc = bezier
        ? `cubic-bezier ${bezier[0]}, ${bezier[1]}, ${bezier[2]}, ${bezier[3]}`
        : isExp
          ? `exponential base ${base}`
          : 'linear'
      warnings?.push(
        `${v[0]}(…) [${curveDesc}] approximated via dense piecewise-linear sRGB samples (${SAMPLES_PER_SEGMENT} per segment) — perceptually correct in ${useHcl ? 'LCh' : 'Lab'} space at compile time; runtime interpolation between dense hex stops.`,
      )
      // Dense samples already carry the exponential / bezier warp — emit
      // linear so the runtime doesn't double-apply it.
      return { curve: 'linear', base: 1, stops: dense }
    }
    // Non-hex stops (data-driven values etc.) fall through with a
    // graceful-downgrade warning matching the prior behaviour. This is
    // the genuine §11 remnant: closing it needs a runtime LAB/HCL
    // per-stop evaluator (non-hex values can't be densified ahead of
    // time because the colour isn't known until feature eval).
    warnings?.push(
      `${v[0]}(…) approximated as linear-sRGB — xgis has no LAB/HCL per-stop evaluator at runtime and non-hex stop values can't be densified at compile time.${bezier ? ' The authored cubic-bezier curve is dropped with it.' : ''}`,
    )
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
export function cssBezierEase(t: number, x1: number, y1: number, x2: number, y2: number): number {
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
  let lo = 0,
    hi = 1
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

// ─── shared ignored-paint diagnostic (used by every per-type emitter) ───

/** Consolidated "ignored paint property" diagnostic. Pushes ONE
 *  warning per layer listing every property that's been declared but
 *  isn't honoured by the runtime today. Mirror of the symbol-layer
 *  `ignoredText` block in layers.ts — one warning per layer keeps
 *  the conversion-notes section readable while still surfacing every
 *  gap. Callers pass the list of property names that the layer
 *  TYPE doesn't currently process. */
/** Mapbox spec: anchor properties have no effect without their parent
 *  translate. Skip the warning when the parent is absent — the layer's
 *  visual is unchanged regardless of our handling. landcover_wetland
 *  in openfreemap-liberty hits this (fill-translate-anchor: "map"
 *  with no fill-translate) so the iter 467 lossy report counted a
 *  spurious entry for that layer. */
const ANCHOR_PARENT: Record<string, string> = {
  'fill-translate-anchor': 'fill-translate',
  'line-translate-anchor': 'line-translate',
  'icon-translate-anchor': 'icon-translate',
  'text-translate-anchor': 'text-translate',
  'fill-extrusion-translate-anchor': 'fill-extrusion-translate',
}

/** Spec-default values where authoring the default matches X-GIS
 *  behaviour — no warning needed. Per-property lookup; the warn-only
 *  case is the gap-revealing value (e.g. fill-antialias=false). Keyed
 *  by property name; value is the spec default that suppresses warn.
 *  ["literal", v] wraps unwrapped before comparison.
 */
const SPEC_DEFAULT_NO_WARN: Record<string, unknown> = {
  'raster-resampling': 'linear',
  // NOTE (#2170): the four `*-translate-anchor` props used to live here
  // mapped to 'viewport', on the stated belief that viewport was their
  // spec default. It is not — reference/v8.json gives fill / line /
  // circle / fill-extrusion translate-anchor default='map'. The entries
  // were also DEAD: none of the three surfaceIgnoredPaint call sites
  // lists an anchor in its candidates (paint-fill.ts, paint-line.ts,
  // paint-fill-extrusion.ts), and circle keeps its own inline mirror in
  // layers-circle.ts. fill / line / fill-extrusion now honour BOTH enum
  // values (addTranslateAnchor), so neither is a gap to surface; circle
  // has no map arm and warns from its own block. Add future
  // spec-defaults here when they enter surfaceIgnoredPaint.
  // fill-extrusion-vertical-gradient already handled inline because
  // its conditional is at the candidate-list site (cleaner there).
  // fill-antialias has its own value-aware emit before this fn.
}

export function surfaceIgnoredPaint(
  layerId: string,
  paint: Record<string, unknown>,
  warnings: string[],
  candidates: readonly string[],
): void {
  const hits: string[] = []
  for (const k of candidates) {
    // Both undefined AND null mean "property omitted" per Mapbox
    // spec — no warning needed when the author explicitly set it
    // to null to fall back to the default.
    if (paint[k] === undefined || paint[k] === null) continue
    // Anchor-dependency skip: a `*-translate-anchor` without its
    // parent `*-translate` has no observable effect (anchor only
    // controls the coordinate space of the translate).
    const parent = ANCHOR_PARENT[k]
    if (parent !== undefined && (paint[parent] === undefined || paint[parent] === null)) continue
    // Spec-default suppression: when the author explicitly sets the
    // spec default value AND that default matches X-GIS behaviour,
    // skip the warning (no actual gap to surface).
    const specDefault = SPEC_DEFAULT_NO_WARN[k]
    if (specDefault !== undefined && unwrapLiteralScalarLocal(paint[k]) === specDefault) continue
    hits.push(k)
  }
  if (hits.length > 0) {
    warnings.push(`Layer "${layerId}" — ignored paint properties: ${hits.join(', ')}`)
  }
}

// ─── shared per-property emitters (used by multiple per-type modules) ───

export function addFill(out: string[], v: unknown, warnings: string[]): void {
  // Treat null the same as undefined — Mapbox spec: a null paint
  // value falls back to the property default. Without this gate
  // null flowed through to exprToXgis (commit a969be5 made null
  // lower to the `null` identifier), emitted `fill-[null]`, and the
  // runtime resolved to no-fill instead of the spec default.
  if (isOmitted(v)) return
  const interp = interpolateZoomCall(v, warnings, (val, w) => colorToXgis(val, w))
  if (interp !== null) {
    out.push(`fill-[${interp}]`)
    return
  }
  const s = colorToXgis(v, warnings)
  if (s) {
    out.push(`fill-${s}`)
    return
  }
  // Per-feature data-driven shape (`match` / `case` / etc.) — route
  // through the generic expression converter. Without this fallback
  // the MapLibre demo's `countries-fill` (`["match", ["get",
  // "ADM0_A3"], …, default]`) silently dropped fill-color: the
  // constant-only path returned null and the layer rendered without
  // a fill. lower.ts now extracts the match default arm as a
  // constant fallback when the runtime per-feature fill pipeline
  // isn't yet wired.
  const expr = exprToXgis(v, warnings)
  if (expr !== null) out.push(`fill-[${expr}]`)
}

export function addOpacity(out: string[], v: unknown, warnings: string[]): void {
  if (isOmitted(v)) return
  // See unwrapLiteralNumeric — covers `["literal", 0.5]` so the
  // scalar-scale conversion fires. Sibling to colorToXgis literal
  // unwrap (e3c5c62).
  v = unwrapLiteralNumeric(v)
  if (typeof v === 'number') {
    // Reject NaN/Infinity. typeof v === 'number' passes for NaN, then
    // Math.max(0, Math.min(1, NaN)) propagates NaN, `Math.round(NaN
    // * 100)` is NaN, and the emitted utility name is `opacity-NaN`
    // — the runtime lex-rejects it and the whole layer's paint
    // utilities silently drop. Same pattern as the raster-opacity
    // NaN guard.
    if (!Number.isFinite(v)) {
      warnings.push(
        `paint.*opacity: non-finite value ${v} (NaN/Infinity); Mapbox spec requires a finite number in [0, 1]. Property dropped.`,
      )
      return
    }
    // Mapbox spec: opacity ∈ [0, 1]. Clamp at convert time so a
    // typo'd negative or > 1 value doesn't produce a malformed
    // utility name (`opacity--50` lexes as an utility name with
    // double-dash that the parser splits on the wrong segment).
    //
    // FIX #6: Three-way classification for out-of-spec values:
    //   v < 0         → clamp to 0 (existing behaviour, warn if v<0||v>100)
    //   v in (1, 2]   → typo window: author almost certainly meant the 0..1
    //                   range (e.g. fill-opacity: 1.2 instead of 1.0). Clamp
    //                   to 1.0 and WARN. Pre-fix: silently divided by 100
    //                   → 0.012 → opacity-1 (~1% = near-invisible layer).
    //   v in (2, 100] → legacy 0..100 percent form: divide by 100 (heuristic,
    //                   pre-existing behaviour, no change).
    //   v > 100       → out-of-range even for percent form; clamp to 1 with
    //                   existing warn (v<0||v>100 gate fires).
    let clamped: number
    if (v < 0 || v > 100) {
      warnings.push(
        `paint.*opacity: value ${v} out of range; Mapbox spec requires [0, 1] (X-GIS auto-detects [0, 100] percent). Clamped to ${Math.max(0, Math.min(1, v <= 1 ? v : v / 100))}.`,
      )
      clamped = Math.max(0, Math.min(1, v <= 1 ? v : v / 100))
    } else if (v > 1 && v <= 2) {
      // Typo window: value slightly above 1 in the 0..1 range. Mapbox/MapLibre
      // clamp to 1.0; pre-fix X-GIS divided by 100 → near-zero opacity.
      warnings.push(
        `paint.*opacity: value ${v} is slightly above 1.0 — looks like a typo in the 0..1 range. Clamped to 1 (opacity-100). Use a value > 2 if you intended the legacy 0..100 percent form.`,
      )
      clamped = 1
    } else {
      clamped = Math.max(0, Math.min(1, v <= 1 ? v : v / 100))
    }
    out.push(`opacity-${Math.round(clamped * 100)}`)
    return
  }
  const interp = interpolateZoomCall(v, warnings, (val) => {
    if (typeof val !== 'number' || !Number.isFinite(val)) return null
    // Mapbox opacity is 0..1; xgis opacity utility takes 0..100.
    // Scale here so the stops match the utility's scale. Apply the
    // SAME [0, 1] clamp the constant path uses — pre-fix a negative
    // or > 1 stop emitted invalid utility names (opacity-[-50, …])
    // or > 100 percent values. Mirror of the constant-path clamp
    // at line 558. Reject non-finite (NaN/Infinity) too — same
    // class as the constant-path guard above.
    const clamped = Math.max(0, Math.min(1, val <= 1 ? val : val / 100))
    return String(Math.round(clamped * 100))
  })
  if (interp !== null) {
    out.push(`opacity-[${interp}]`)
    return
  }
  const x = exprToXgis(v, warnings)
  if (x !== null) {
    // #725 — the runtime has no per-feature opacity channel: `opacity-[…]`
    // evaluates to ONE layer scalar per frame (folded into fill_color.a /
    // stroke alpha), so a feature-referencing expression silently loses its
    // per-feature variation. Warn LOUDLY instead of dropping silently; the
    // zoom-only interpolate form above is fully supported (per-frame interp).
    if (JSON.stringify(v).includes('"get"')) {
      // NB: phrasing avoids the substrings 'let'/'var' — converter tests assert
      // those tokens are substituted OUT of the emitted source, and conversion
      // notes are part of that source.
      warnings.push(
        `paint.*opacity: data-driven (per-feature) opacity is not yet wired to a per-feature channel — the expression is evaluated as a single per-layer value, so per-feature differences will NOT render. Fold the alpha into a data-driven *-color instead (e.g. match(...) -> #rrggbbAA).`,
      )
    }
    out.push(`opacity-${maybeBracket(x)}`)
  }
}

/** Mapbox `paint.fill-translate: [dx, dy]` → xgis
 *  `fill-translate-x-N fill-translate-y-M` (signed pixel offsets).
 *  Constant form only at the moment; zoom-interp on vec2 needs
 *  per-axis decomposition (Mapbox emits a single stop value per
 *  zoom that is itself [x, y]) which the binding-form parser
 *  doesn't yet handle. Default [0,0] is silent.
 *
 *  Sign convention: Mapbox positive x = right, positive y = down
 *  (screen space). The runtime WGSL multiplies by clip.w to keep
 *  the offset constant in pixels regardless of depth, then negates
 *  y for NDC convention (NDC y is UP).
 *
 *  Anchor: handled by addTranslateAnchor below, NOT here — "map" is
 *  implemented (the fill-translate-anchor-map flag; VTR rotates the offset
 *  by the camera bearing) and is the v8 DEFAULT since #2170. This comment
 *  used to say it was unimplemented, which would send a reader off to
 *  build what the next function in this file already does. */
export function addFillTranslate(
  out: string[],
  v: unknown,
  warnings: string[],
  // `property` names the paint key the value came from. fill-extrusion-
  // translate rides the SAME fill-translate-{x,y} utilities and so shares
  // this emitter — without the parameter its drop warning mislabelled a
  // fill-extrusion-translate loss as "paint.fill-translate" (#1976).
  property: 'fill-translate' | 'fill-extrusion-translate',
): void {
  if (isOmitted(v)) return
  // Mapbox v8 wraps `[dx, dy]` as `["literal", [dx, dy]]`. Unwrap so
  // the bare-array fast path catches both forms.
  while (Array.isArray(v) && v.length === 2 && v[0] === 'literal') {
    v = v[1]
  }
  if (
    Array.isArray(v) &&
    v.length === 2 &&
    typeof v[0] === 'number' &&
    Number.isFinite(v[0]) &&
    typeof v[1] === 'number' &&
    Number.isFinite(v[1])
  ) {
    // Negative numbers wrap in brackets so the utility-name lexer
    // doesn't read the `-` as a segment separator (same convention
    // as label-offset-x / -y in layers.ts:656).
    const fmt = (n: number): string => (n < 0 ? `[${n}]` : `${n}`)
    if (v[0] !== 0) out.push(`fill-translate-x-${fmt(v[0])}`)
    if (v[1] !== 0) out.push(`fill-translate-y-${fmt(v[1])}`)
    return
  }
  // WS-1 — per-frame zoom-interp via per-axis scalar PropertyShape.
  // Mapbox emits stops whose values are [x, y] arrays; split into two
  // scalar zoom-interpolates (x and y) and emit a bracket binding per
  // axis (fill-translate-x-[interpolate(zoom,…)]). lower.ts parses each
  // into RenderNode.fillTranslate{X,Y}Shape → resolveShow resolves them
  // per frame (resolveNumberShape) → VTR NDC-bakes the resolved value.
  // Replaces the old last-stop approximation.
  if (isZoomInterpCandidate(v)) {
    const ix = vec2AxisZoomInterp(v, warnings, 0)
    // Skip the y axis once x has already failed: both axes run the SAME
    // lift over the SAME value, so a diagnostic the lift pushes (e.g. the
    // legacy data-driven property-function note) would otherwise be
    // reported twice for one authored value.
    const iy = ix === null ? null : vec2AxisZoomInterp(v, warnings, 1)
    if (ix !== null && iy !== null) {
      out.push(`fill-translate-x-[${ix}]`)
      out.push(`fill-translate-y-[${iy}]`)
      return
    }
  }
  warnings.push(
    `paint.${property}: non-constant form not yet supported — value dropped: ${JSON.stringify(v).slice(0, 80)}`,
  )
}

/** Mapbox `*-translate-anchor` → optional `<prefix>-translate-anchor-map`
 *  flag. The spec default is **map**, not viewport (reference/v8.json:
 *  paint_fill / paint_line / paint_circle / paint_fill-extrusion all carry
 *  default='map'), so an ABSENT anchor emits the flag exactly as an explicit
 *  'map' does (#2170) and the runtime rotates the [dx,dy] offset with the map
 *  bearing instead of leaving it screen-fixed. Only an explicit 'viewport'
 *  emits nothing — that value selects the screen-space path. prefix is the
 *  xgis utility namespace ('fill', or 'stroke' for the line layer); skipped
 *  entirely when the parent `*-translate` is absent, since the anchor is a
 *  no-op with no offset to anchor. */
export function addTranslateAnchor(
  out: string[],
  prefix: 'fill' | 'stroke',
  anchorRaw: unknown,
  parentTranslate: unknown,
  warnings: string[],
): void {
  // Checked FIRST so the spec default below cannot flag a layer that has no
  // offset. Mirror of surfaceIgnoredPaint's ANCHOR_PARENT skip.
  if (isOmitted(parentTranslate)) return
  if (!translateAnchorIsMap(anchorRaw, warnings)) return
  // Absent (⇒ spec default), explicit 'map', and an invalid enum (⇒ default)
  // all anchor the offset in world space.
  out.push(`${prefix}-translate-anchor-map`)
}

/** The spec-default DECISION every `*-translate-anchor` shares, in one place.
 *
 *  Returns true when the offset is world-anchored: an ABSENT anchor (the
 *  v8 default is 'map' for every layer type that has the property), an
 *  explicit 'map', or an invalid enum (which warns and falls back to the
 *  default). Only an explicit 'viewport' returns false — that is the one
 *  value selecting the screen-space path.
 *
 *  Extracted because #2170 fixed this rule for fill / line / circle /
 *  fill-extrusion by editing `addTranslateAnchor`, while the symbol
 *  emitter carried its own `anchor === 'map'` copy and kept the pre-#2170
 *  behaviour — a second authority is exactly how the two drifted. Callers
 *  must still skip when the parent `*-translate` is omitted; the anchor is
 *  a no-op with no offset to anchor, and checking it here would let a
 *  layer with no offset surface the invalid-enum warning. */
export function translateAnchorIsMap(anchorRaw: unknown, warnings: string[]): boolean {
  let v: unknown = anchorRaw
  while (Array.isArray(v) && v.length === 2 && v[0] === 'literal') v = v[1]
  if (v === 'viewport') return false // the one value that picks screen-space
  if (!isOmitted(v) && v !== 'map') {
    warnings.push(
      `paint.*-translate-anchor: unexpected value ${JSON.stringify(v)}; Mapbox spec allows only "map" | "viewport". Treated as the spec default "map".`,
    )
  }
  return true
}

/** Build a scalar zoom-interpolate bracket-binding body for ONE axis
 *  (idx 0 = x, 1 = y) of a Mapbox vec2 `interpolate(zoom, …, [dx,dy], …)`.
 *  Returns the inner xgis interpolate string (no brackets) or null when
 *  the value isn't a zoom-interp vec2 (caller falls through to a
 *  warning). WS-1 — per-axis scalar shapes reuse resolveNumberShape so
 *  no new vec2 interpolator is needed. */
export function vec2AxisZoomInterp(v: unknown, warnings: string[], idx: 0 | 1): string | null {
  return interpolateZoomCall(v, warnings, (val) => {
    let inner: unknown = val
    while (Array.isArray(inner) && inner.length === 2 && inner[0] === 'literal') inner = inner[1]
    if (
      Array.isArray(inner) &&
      inner.length === 2 &&
      typeof inner[idx] === 'number' &&
      Number.isFinite(inner[idx])
    ) {
      return String(inner[idx])
    }
    return null
  })
}
