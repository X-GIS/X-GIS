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

/** Reserved key for the feature's stable ID. Mapbox `["id"]` (PR #91)
 *  and `["get", "$featureId"]` both resolve through this slot.
 *  Worker / runtime inject `feature.id` here when present. */
export const FEATURE_ID_KEY = '$featureId' as const

/** Reserved key for the feature's geometry type ('Point' |
 *  'LineString' | 'Polygon' | 'MultiPoint' | …). Mapbox
 *  `["geometry-type"]` lowers to `["get", "$geometryType"]` and the
 *  worker / runtime inject `feature.geometry.type` here. */
export const GEOMETRY_TYPE_KEY = '$geometryType' as const

/** Union of every reserved key — useful for "is this prop name
 *  reserved" checks in lower.ts / converter. */
export type ReservedKey =
  | typeof CAMERA_ZOOM_KEY
  | typeof FEATURE_ID_KEY
  | typeof GEOMETRY_TYPE_KEY

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
  /** Stable feature ID — exposed via `["id"]` / `["get","$featureId"]`. */
  featureId?: string | number
  /** GeoJSON geometry type — exposed via `["geometry-type"]`. */
  geometryType?: string
}): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(opts.props ?? {}) }
  if (opts.cameraZoom !== undefined) out[CAMERA_ZOOM_KEY] = opts.cameraZoom
  if (opts.featureId !== undefined) out[FEATURE_ID_KEY] = opts.featureId
  if (opts.geometryType !== undefined) out[GEOMETRY_TYPE_KEY] = opts.geometryType
  return out
}
