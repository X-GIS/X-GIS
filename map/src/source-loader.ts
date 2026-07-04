// ═══ @xgis/map · custom source-loader contract ═══
//
// The per-map registration seam that lets `.xgis` declare a source of a CUSTOM
// `type:` beyond the built-ins, resolved by a host-supplied loader. Design +
// rationale: docs/architecture/source-loader-seam.md.
//
// The result `data` types are STRUCTURAL + loose on purpose: any producer
// satisfies them — a hand-written loader, or @xgis/pipeline's own
// `FeatureCollectionLike` / `PointPatch` (a shared-only leaf that never imports
// @xgis/map). The dispatch casts to the concrete @xgis/data types at the attach
// boundary, exactly as an inline `data:` source is cast (`source-manager.ts`).

/** Minimal structural FeatureCollection a loader may return. */
export interface LoaderFeatureCollection {
  readonly type: 'FeatureCollection'
  readonly features: readonly unknown[]
}

/** Minimal structural point patch — mirrors @xgis/data's columnar `PointPatch`. */
export interface LoaderPointPatch {
  readonly lon: ArrayLike<number>
  readonly lat: ArrayLike<number>
  readonly ids?: ArrayLike<number>
  readonly properties?: Record<string, ArrayLike<unknown>>
}

/** What a loader receives at source-attach time. */
export interface SourceLoadContext {
  /** The source name (`.xgis` `source <name> { … }`). */
  readonly id: string
  /** Resolved (base-joined) URL; `''` when the source declared none. */
  readonly url: string
  /** Non-reserved `.xgis` source-block props (source-loader-seam §5). Scalars
   *  and string-arrays only. A blessed loader prefers typed constructor params
   *  over fishing this bag (§6); it is the escape hatch for dynamic loaders. */
  readonly options: Readonly<Record<string, string | number | readonly string[]>>
  /** Host-injected, SSRF-guarded fetch (the map passes its `safeFetch`), so a
   *  loader never touches `fetch` directly and inherits the same fetch safety
   *  as the built-in geojson branch. */
  readonly fetch: (url: string) => Promise<Response>
}

/** A loader's output. The discriminant matches the pipeline's `EncodeResult.kind`
 *  ('fc' | 'points') so a pipeline-backed loader returns its result almost
 *  verbatim. Both kinds attach via the same geojson path (points → FC). */
export type SourceLoadResult =
  | { readonly kind: 'fc'; readonly data: LoaderFeatureCollection }
  | { readonly kind: 'points'; readonly data: LoaderPointPatch }

/** A custom source loader: declared options + host I/O → a renderable payload.
 *  Runs once at attach time; the output routes through the SAME
 *  `_attachGeoJSONViaVirtualPMTiles` path the built-in geojson branch uses, so a
 *  custom source is indistinguishable from a built-in downstream (§3.3). */
export type SourceLoader = (ctx: SourceLoadContext) => Promise<SourceLoadResult>
