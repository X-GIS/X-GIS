// Reserved property keys injected into the evaluator's props bag by
// the runtime/worker before each evaluate() call.
//
// THIS FILE IS THE ONE AND ONLY SOURCE OF TRUTH for these literal
// strings. evaluator.ts looks them up under these exact names, so a
// typo anywhere else in the codebase ("zoom" instead of "$zoom",
// "featureId" instead of "$featureId") produces a silent
// undefined-lookup that the evaluator then folds into 0/null — the
// PR #102 bug class.
//
// Every call site that builds an evaluator props bag MUST import
// from here (no literal '$zoom' strings allowed elsewhere). The
// conformance test suite has a grep-based guard
// (mapbox-spec-conformance.test.ts → reserved-keys-no-literals) that
// fails CI if a new literal slips in.

/** Reserved key for the current CAMERA ZOOM (not tile zoom — the
 *  fractional value the user is actually viewing the map at). The
 *  evaluator's `zoom` identifier resolves to `props[CAMERA_ZOOM_KEY]`.
 *  Workers inject `tileZoom` here as a close-enough proxy when
 *  baking per-feature values at decode time. */
export const CAMERA_ZOOM_KEY = '$zoom' as const

/** Reserved key for the current CAMERA PITCH in degrees (0 = top-down,
 *  60 = max tilt). The evaluator's `pitch` identifier resolves to
 *  `props[CAMERA_PITCH_KEY]`. Mirror of CAMERA_ZOOM_KEY for the Mapbox
 *  `["pitch"]` expression accessor. Only the render-path eval sites
 *  (filter / paint) inject it (they hold `camera.pitch`); worker /
 *  tile-decode sites leave it absent (no camera), so `["pitch"]`
 *  resolves to null there — same proxy contract `["zoom"]` has with
 *  tileZoom. */
export const CAMERA_PITCH_KEY = '$pitch' as const

/** Reserved key for the RUNNING AGGREGATE of one `clusterProperties` key — Mapbox
 *  `["accumulated"]` (#2050). The evaluator's `accumulated` identifier resolves to
 *  `props[ACCUMULATED_KEY]`, the same injection contract `zoom` / `pitch` have.
 *  A `clusterProperties` reduce is `accumulated <op> ["get", key]`: the reserved key
 *  carries the value merged so far while the ordinary props bag carries the INCOMING
 *  mapped values, so the two operands cannot collide. The injector is the cluster
 *  index's merge step (design §4.3, T3 P2/P3 — `compiler/src/tiler/cluster/`, running
 *  inside `data/src/workers/geojson-tiling-worker.ts`); every other eval site leaves it
 *  absent and `["accumulated"]` resolves to null there, as `["pitch"]` does off-camera. */
export const ACCUMULATED_KEY = '$accumulated' as const

/** Reserved key for the feature ANCHOR's distance from the viewport centre —
 *  Mapbox `["distance-from-center"]` (#2119), in units of the viewport
 *  half-diagonal (0 at centre, ~1 at the edge, >1 off-screen; see
 *  ./distance-from-center.ts for the exact arithmetic and its witnesses).
 *  Camera-dependent like `zoom` / `pitch`, but NOT a per-frame scalar — the
 *  anchor is per-FEATURE, so this is the one member of the family that is
 *  per-feature, not per-frame; a render-path caller computes it once per
 *  evaluated feature and passes the reduced number in, the same contract
 *  `accumulated` has with the cluster merge step.
 *
 *  Routed differently than `zoom` / `pitch` / `accumulated`: those lower to
 *  a BARE identifier the evaluator special-cases (`expr.name === 'pitch'`).
 *  `distance-from-center` cannot — the lexer tokenizes `-` as Minus
 *  (lexer.ts `readIdentifier` stops at `[a-zA-Z0-9_]`), so a bare
 *  `distance-from-center` identifier would parse as three subtractions, not
 *  one name. It rides the OTHER existing reserved-key channel instead — the
 *  `get("$key")` form `["geometry-type"]` / `["id"]` already use for the
 *  same reason (see GEOMETRY_TYPE_KEY / FEATURE_ID_KEY) — which evaluator.ts
 *  needs zero new code for: the generic `get(...)` builtin already does
 *  `props[key] ?? null` for any string-literal key. Shadowing a feature
 *  property named literally "distance-from-center" is structural, not a
 *  runtime check: the injected slot lives at `props['$distanceFromCenter']`,
 *  the feature's own field (if any) at `props['distance-from-center']` —
 *  disjoint keys, so `["get", "distance-from-center"]` and
 *  `["distance-from-center"]` can never collide. */
export const DISTANCE_FROM_CENTER_KEY = '$distanceFromCenter' as const

/** Reserved key PREFIX for a declared `input`'s live value (#1539) —
 *  `props[INPUT_KEY_PREFIX + name]`. The evaluator's `InputRef` node
 *  (resolved from a bare identifier by ir/resolve-inputs.ts before
 *  evaluate() ever sees it) looks up this key, falling back to the
 *  node's own carried `default` when absent — so a compile-time
 *  const-fold (which passes `{}` as props) and a runtime host-set value
 *  both resolve correctly through the same evaluator. Prefix, not a
 *  single fixed key like $zoom/$pitch, since there can be many inputs. */
export const INPUT_KEY_PREFIX = '$input:' as const

/** Reserved key for the feature's stable ID. Mapbox `["id"]` (PR #91)
 *  and `["get", "$featureId"]` both resolve through this slot.
 *  Worker / runtime inject `feature.id` here when present. */
export const FEATURE_ID_KEY = '$featureId' as const

/** Reserved key for the feature's geometry type — Mapbox spec
 *  NORMALIZES Multi* shapes to their base form:
 *      MultiPoint      → 'Point'
 *      MultiLineString → 'LineString'
 *      MultiPolygon    → 'Polygon'
 *  Mapbox `["geometry-type"]` lowers to `["get", "$geometryType"]`
 *  and `makeEvalProps` applies the normalisation so a filter
 *  `["==", ["geometry-type"], "Polygon"]` matches BOTH Polygon and
 *  MultiPolygon features (MapLibre's behaviour). Pre-fix workers /
 *  runtime injected the raw `feature.geometry.type`, so MultiPolygon
 *  features silently failed `==="Polygon"` filters. */
export const GEOMETRY_TYPE_KEY = '$geometryType' as const

/** Reserved key for the feature's RAW geometry object ({ type, coordinates }).
 *  Mapbox `["within", polygon]` lowers to `within(get("$geometry"), …)` and
 *  needs the actual coordinates (not just the type) to test containment.
 *  `applyFilter` (GeoJSON path) injects `feature.geometry` here; paths that
 *  don't supply it (MVT tile-coordinate filter eval) leave it absent, so
 *  `within` degrades to false there — see eval/within.ts. */
export const GEOMETRY_KEY = '$geometry' as const

/** Normalize a raw GeoJSON geometry-type string to the form Mapbox's
 *  `["geometry-type"]` accessor returns. Multi* → base. Pass-through
 *  for already-base shapes and unrecognised inputs. */
export function normalizeGeometryType(t: string | undefined): string | undefined {
  if (t === 'MultiPoint') return 'Point'
  if (t === 'MultiLineString') return 'LineString'
  if (t === 'MultiPolygon') return 'Polygon'
  return t
}

/** Union of every reserved key — useful for "is this prop name
 *  reserved" checks in lower.ts / converter. */
export type ReservedKey =
  | typeof CAMERA_ZOOM_KEY
  | typeof CAMERA_PITCH_KEY
  | typeof ACCUMULATED_KEY
  | typeof DISTANCE_FROM_CENTER_KEY
  | typeof FEATURE_ID_KEY
  | typeof GEOMETRY_TYPE_KEY
  | typeof GEOMETRY_KEY

/** Build an evaluator props bag with reserved keys correctly named.
 *
 *  Pass this helper instead of building the bag inline:
 *
 *      // ❌ pre-PR-#102 — typo-prone, silent on miss
 *      const v = evaluate(ast, { ...props, zoom: tileZoom })
 *
 *      // ✅ post-fix — sigil enforced by the type system
 *      const v = evaluate(ast, makeEvalProps({ props, cameraZoom: tileZoom }))
 *
 *  Every reserved-key injection site is a one-typo-from-broken call;
 *  centralising the construction here moves that risk from the
 *  worker / runtime / future call sites to ONE function that's
 *  pinned by its own unit test. */
export function makeEvalProps(opts: {
  /** The feature's vector-tile / GeoJSON properties bag. */
  props?: Record<string, unknown> | null
  /** Camera (or tile) zoom — exposed to `interpolate(zoom, …)` etc. */
  cameraZoom?: number
  /** Camera pitch in degrees — exposed to Mapbox `["pitch"]`. Only the
   *  render-path eval sites supply it; absent at worker/decode time. */
  cameraPitch?: number
  /** Running aggregate for one `clusterProperties` key — exposed to Mapbox
   *  `["accumulated"]` (#2050). Only the cluster-index merge step supplies it. */
  accumulated?: unknown
  /** This FEATURE's anchor distance from the viewport centre, already
   *  normalized to half-diagonal units (0 centre, ~1 edge, >1 off-screen) —
   *  exposed to Mapbox `["distance-from-center"]` (#2119). Compute via
   *  `distanceFromCenterRatio` (./distance-from-center.ts); this option
   *  takes the already-reduced number, same contract `accumulated` has.
   *  Per-FEATURE, not per-frame — only a render-path caller that has
   *  resolved a screen anchor for THIS feature supplies it. Left absent
   *  (never null) for a feature whose anchor isn't well-defined (a
   *  line-placed label, a non-point geometry) or at any site with no
   *  camera at all (worker / decode-time) — `["distance-from-center"]`
   *  resolves to null there, the same absence contract every other
   *  reserved key has. */
  distanceFromCenter?: number
  /** Stable feature ID — exposed via `["id"]` / `["get","$featureId"]`. */
  featureId?: string | number
  /** GeoJSON geometry type — exposed via `["geometry-type"]`. */
  geometryType?: string
  /** Raw GeoJSON geometry object — exposed via `["within"]` containment.
   *  Only the filter-eval sites that hold the full geometry supply it. */
  geometry?: unknown
  /** Live values for declared `input`s (#1539), keyed by the DECLARED name
   *  (no sigil — this helper applies `INPUT_KEY_PREFIX`). Only the render-path
   *  eval sites that hold the map's InputStore supply it; worker / decode
   *  sites omit it and every `InputRef` falls back to its carried compile-time
   *  default, the same proxy contract `["zoom"]` has with tileZoom.
   *
   *  Value shape mirrors what `evaluate()` yields for the corresponding
   *  literal, so a live value and a carried default are interchangeable
   *  downstream: `f32` → number, `color` → hex STRING (ColorLiteral
   *  evaluates to `expr.value`, the hex text — not an RGBA tuple). */
  inputs?: Readonly<Record<string, number | string>>
}): Record<string, unknown> {
  // Defensive: coerce non-plain-object props to {}. A host passing
  // a string or array (TypeScript-typed-as-record cast at the
  // boundary) would otherwise spread char/index keys into the props
  // bag and downstream `.field` lookups would return chars.
  const rawProps = opts.props
  const safeProps =
    rawProps !== null &&
    rawProps !== undefined &&
    typeof rawProps === 'object' &&
    !Array.isArray(rawProps)
      ? (rawProps as Record<string, unknown>)
      : {}
  const out: Record<string, unknown> = { ...safeProps }
  if (opts.cameraZoom !== undefined) out[CAMERA_ZOOM_KEY] = opts.cameraZoom
  if (opts.cameraPitch !== undefined) out[CAMERA_PITCH_KEY] = opts.cameraPitch
  if (opts.accumulated !== undefined) out[ACCUMULATED_KEY] = opts.accumulated
  if (opts.distanceFromCenter !== undefined) out[DISTANCE_FROM_CENTER_KEY] = opts.distanceFromCenter
  if (opts.featureId !== undefined) out[FEATURE_ID_KEY] = opts.featureId
  if (opts.geometryType !== undefined) {
    out[GEOMETRY_TYPE_KEY] = normalizeGeometryType(opts.geometryType)
  }
  if (opts.geometry !== undefined) out[GEOMETRY_KEY] = opts.geometry
  if (opts.inputs !== undefined) {
    // Prefixed, so a declared input can never collide with a feature
    // property of the same name (the props spread above owns bare keys).
    for (const name of Object.keys(opts.inputs)) out[INPUT_KEY_PREFIX + name] = opts.inputs[name]
  }
  return out
}
