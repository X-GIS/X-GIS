// ═══ @xgis/pipeline · loaders — pipeline-backed source loaders ═══
//
// A `SourceLoader` (defined STRUCTURALLY — the pipeline NEVER imports @xgis/map, so
// it stays a shared-only leaf) that wraps the ingest→join→encode verbs. It lets a
// code-keyed CSV load DECLARATIVELY via `.xgis` `source { type: x-… }` +
// `XGISMapOptions.sources`, instead of the imperative `load(...).apply(map, id)`.
// The structural shape is assignable to @xgis/map's `SourceLoader` at the
// registration site. Design: docs/architecture/source-loader-seam.md §6.

import { fromCSV } from '../ingest'
import { join, type Gazetteer } from '../join'
import { bubble, type FeatureCollectionLike, type PointPatch } from '../encode'

/** What a loader receives at source-attach time (structural mirror of @xgis/map's
 *  `SourceLoadContext` — no @xgis/map import). */
export interface LoaderContext {
  readonly id: string
  readonly url: string
  readonly options: Readonly<Record<string, string | number | readonly string[]>>
  readonly fetch: (url: string) => Promise<Response>
}

/** A loader's output. Discriminant matches `EncodeResult.kind` and @xgis/map's
 *  `SourceLoadResult`, so a pipeline loader plugs straight in. */
export type LoaderResult =
  | { readonly kind: 'fc'; readonly data: FeatureCollectionLike }
  | { readonly kind: 'points'; readonly data: PointPatch }

export type SourceLoader = (ctx: LoaderContext) => Promise<LoaderResult>

/** A source loader backed by the gazetteer join + bubble encoder: fetch a
 *  code-keyed CSV → join each row's admin code to its WGS84 centroid → emit a
 *  value-scaled bubble FeatureCollection. Columns are TYPED constructor params,
 *  so a wrong/missing column name fails at the registration call site, not deep
 *  inside `join` with the wrong blame (api-review F4). The `.xgis` source block
 *  is then just `type` + `url`. */
export function krAdminLoader(
  gaz: Gazetteer,
  cols: { codeColumn: string; valueColumn: string },
): SourceLoader {
  return async ({ url, fetch }) => {
    // Guard the status BEFORE reading the body — safeFetch returns 4xx/5xx
    // responses without throwing, so an unchecked `.text()` would feed the error
    // page into fromCSV and surface a misleading "column not found" from `join`
    // instead of the real HTTP failure (mirrors the built-in geojson branch).
    const resp = await fetch(url)
    if (!resp.ok) {
      throw new Error(
        `[@xgis/pipeline] krAdminLoader: failed to fetch '${url}' — HTTP ${resp.status} ${resp.statusText}`,
      )
    }
    const text = await resp.text()
    const t = fromCSV(text, { vintage: gaz.vintage, types: { [cols.codeColumn]: 'string' } })
    const j = join(t, { code: cols.codeColumn, gaz, as: 'o' })
    const enc = bubble(j, { lon: 'o.lon', lat: 'o.lat', value: cols.valueColumn })
    // toFeatureCollection() is the SHIPPED EncodeResult escape hatch — points expand
    // to Point features; both kinds attach via the map's one geojson path (§3.3).
    return { kind: 'fc', data: enc.toFeatureCollection() }
  }
}
