// ═══ PMTiles Backend — Types ═══
// Top-level type/interface declarations extracted verbatim from
// pmtiles-backend.ts. Behaviour-preserving structural split only; no
// logic or symbol renames. `PMTilesFetcher` and `PMTilesBackendOptions`
// remain part of the public surface and are re-exported from
// pmtiles-backend.ts.

/** Async HTTP byte fetcher.
 *
 *  Three-state return:
 *    - `Uint8Array`  — raw MVT bytes; decode + compile happen later
 *                      in tick().
 *    - `null`        — tile genuinely absent from the source (PMTiles
 *                      archive has no index entry, XYZ server returned
 *                      404). Caller caches an empty tile so the same
 *                      key isn't re-fetched.
 *    - `'failed'`    — transient/permanent fetch failure (5xx, network
 *                      error, retry exhaustion, OR aborted via signal).
 *                      Caller does NOT cache empty — keeps the tile in
 *                      "missing" state so the renderer's parent-walk
 *                      falls back to the nearest cached ancestor and
 *                      draws that magnified. The backend's per-key
 *                      negative cache prevents hammering the source
 *                      while the failure persists; abort failures are
 *                      handled separately so a cancelled request can
 *                      be re-issued immediately when the tile becomes
 *                      visible again.
 *
 *  `signal` lets the backend cancel an in-flight fetch when the
 *  catalog reports the tile is no longer wanted (camera moved past
 *  it, zoom changed enough that it's stale). Implementations should
 *  surface AbortError as `'failed'` and skip the negative cache for
 *  abort-induced failures (they're not a real fetch problem). */
export type PMTilesFetcher = (
  z: number, x: number, y: number,
  signal: AbortSignal,
) => Promise<Uint8Array | null | 'failed'>

export interface PMTilesBackendOptions {
  fetcher: PMTilesFetcher
  minZoom: number
  maxZoom: number
  bounds: [number, number, number, number]
  /** MVT layer name allow-list (decoder filters before compile). */
  layers?: string[]
  /** Per-MVT-layer info from `metadata.vector_layers` — id +
   *  minzoom/maxzoom + (optional) field schema. Used by the runtime
   *  to skip work for layers that don't have data at the current
   *  camera zoom (e.g. protomaps v4 `buildings` only at z≥14). */
  vectorLayers?: Array<{ id: string; minzoom: number; maxzoom: number; fields?: Record<string, string> }>
  /** Per-MVT-layer 3D-extrude expression AST. Forwarded to the MVT
   *  worker on every compile request; the worker evaluates the AST
   *  against each feature's properties to produce the feature's
   *  height in metres. */
  extrudeExprs?: Record<string, unknown>
  /** Companion to `extrudeExprs` for Mapbox `fill-extrusion-base` —
   *  per-feature wall-bottom z (default 0). */
  extrudeBaseExprs?: Record<string, unknown>
  /** Per-show slice descriptors. With this set, the worker emits one
   *  pre-filtered slice per UNIQUE (sourceLayer, filter) combo
   *  instead of one slice per source layer — eliminating the
   *  redundant draws when N xgis layers share one MVT layer with
   *  different filters. See `filter-eval.ts` for the contract. */
  showSlices?: Array<{ sliceKey: string; sourceLayer: string; filterAst: unknown | null; needsFeatureProps?: boolean; needsExtrude?: boolean; featurePropKeys?: string[] }>
  /** Per-sliceKey stroke-width override AST. The worker uses it to
   *  bake per-feature widths into the slice's line segment buffer so
   *  the line shader picks each feature's width without re-uploading
   *  per-frame uniforms. Compiler-synthesized by mergeLayers. */
  strokeWidthExprs?: Record<string, unknown>
  /** Per-sliceKey stroke-colour override AST. Same plumbing as
   *  width — worker resolves per feature, packs RGBA8 into u32,
   *  writes into segment buffer. */
  strokeColorExprs?: Record<string, unknown>
}
