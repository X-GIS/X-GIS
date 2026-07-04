// ═══ @xgis/pipeline · loaders — pipeline-backed source loaders ═══
//
// A `SourceLoader` (defined STRUCTURALLY — the pipeline NEVER imports @xgis/map, so
// it stays a shared-only leaf) that wraps the ingest→join→encode verbs. It lets a
// code-keyed CSV load DECLARATIVELY via `.xgis` `source { type: x-… }` +
// `XGISMapOptions.sources`, instead of the imperative `load(...).apply(map, id)`.
// The structural shape is assignable to @xgis/map's `SourceLoader` at the
// registration site. Design: docs/architecture/source-loader-seam.md §6.

import { fromCSV, fromRows } from '../ingest'
import { join, type Gazetteer } from '../join'
import { bubble, odFlow, type FeatureCollectionLike, type PointPatch } from '../encode'
import { decodeODB } from '../odb/format'

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

/** A source loader backed by an aggregated .odb OD-flow payload (the offline
 *  tools/csv-to-odb output — the consumer end of the 345MB→KB pipeline). Fetches
 *  the tiny binary, decodes it, sums flow population per node (inflow → by
 *  destination, outflow → by origin; `hour` selects one hour), joins codes to WGS84
 *  centroids, and emits a value-scaled bubble FC. Runs ONCE at source-attach (the
 *  seam is construction-immutable). A per-hour ANIMATION is future work: it must NOT
 *  re-invoke this (that re-fetches + re-decodes) — decode once + index by hour. */
export function odbLoader(
  gaz: Gazetteer,
  opts: { mode?: 'inflow' | 'outflow' | 'arc'; hour?: number } = {},
): SourceLoader {
  const mode = opts.mode ?? 'inflow'
  return async ({ url, fetch }) => {
    const resp = await fetch(url)
    if (!resp.ok) {
      throw new Error(
        `[@xgis/pipeline] odbLoader: failed to fetch '${url}' — HTTP ${resp.status} ${resp.statusText}`,
      )
    }
    const data = decodeODB(await resp.arrayBuffer())
    if (mode === 'arc') {
      const rows: { o_code: string; d_code: string; pop: number }[] = []
      for (let i = 0; i < data.rowCount; i++) {
        if (opts.hour !== undefined && data.hour[i] !== opts.hour) continue
        rows.push({
          o_code: data.dict[data.origin[i]!]!,
          d_code: data.dict[data.dest[i]!]!,
          pop: data.pop[i]!,
        })
      }
      const t = fromRows(rows, { vintage: gaz.vintage })
      const j = join(join(t, { code: 'o_code', gaz, as: 'origin' }), {
        code: 'd_code',
        gaz,
        as: 'dest',
      })
      const enc = odFlow(j, { origin: 'origin', dest: 'dest', weight: 'pop' })
      return { kind: 'fc', data: enc.toFeatureCollection() }
    }
    const codeCol = mode === 'inflow' ? data.dest : data.origin
    const byCode = new Map<string, number>()
    for (let i = 0; i < data.rowCount; i++) {
      if (opts.hour !== undefined && data.hour[i] !== opts.hour) continue
      const code = data.dict[codeCol[i]!]!
      byCode.set(code, (byCode.get(code) ?? 0) + data.pop[i]!)
    }
    const rows = [...byCode].map(([code, pop]) => ({ code, pop }))
    const t = fromRows(rows, { vintage: gaz.vintage })
    const j = join(t, { code: 'code', gaz, as: 'o' })
    const enc = bubble(j, { lon: 'o.lon', lat: 'o.lat', value: 'pop' })
    return { kind: 'fc', data: enc.toFeatureCollection() }
  }
}
