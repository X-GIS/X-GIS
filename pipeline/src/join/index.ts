// ═══ @xgis/pipeline · join — standard admin code → geometry ═══
//
// The highest-leverage step: public data is overwhelmingly keyed by an admin CODE,
// never a coordinate. A gazetteer resolves a STANDARD code → WGS84 centroid. It is
// COUNTRY-GENERIC — other countries plug in their own gazetteer with their own
// standard code system (KR 행정표준코드, US FIPS, JP JIS X 0402, or ISO 3166-2 for
// first subdivisions). Bundled country snapshots live in gazetteer/ (one file per
// country); this module is the generic resolver + join.
//
// Four identifiers make a gazetteer self-describing + a join safe:
//   • country    — ISO 3166-1 alpha-2 ('KR', 'US', 'JP') — the universal top key.
//   • system     — the standard CODE SYSTEM ('KR:ADMCD', 'US:FIPS', 'ISO3166-2');
//                  a join compares it to the data's declared system.
//   • adminLevel — GADM/ISO depth: 0 = country, 1 = first subdivision (시도/state),
//                  2 = second (시군구/county), 3 = locality (행정동/municipality).
//   • vintage    — snapshot year; boundaries drift, so a wrong-vintage code is a
//                  silent wrong-dot the join guards against.
//
// Centroids are WGS84 → the join path never reprojects (single reprojection
// authority stays the renderer's, for projected COORDINATE input).

import { ColumnarTable, type Table, type Cell } from '../core/table'

/** GADM/ISO-style hierarchy depth. 0 = country, 1 = first subdivision, 2 = second, … */
export type AdminLevel = 0 | 1 | 2 | 3 | 4 | 5

/** Self-describing metadata every gazetteer carries. */
export interface GazetteerMeta {
  /** ISO 3166-1 alpha-2 country code, e.g. 'KR', 'US'. */
  readonly country: string
  /** The standard code system, e.g. 'KR:ADMCD', 'US:FIPS', 'ISO3166-2'. */
  readonly system: string
  /** Hierarchy depth (0 = country, 1 = first subdivision, …). */
  readonly adminLevel: AdminLevel
  /** Snapshot vintage (e.g. '2023'); the join asserts it equals the data's. */
  readonly vintage: string
}

export interface Gazetteer extends GazetteerMeta {
  /** WGS84 [lon, lat], or null when the standard code is absent from this vintage. */
  centroid(code: string): readonly [number, number] | null
  name(code: string): string | null
}

/** One gazetteer entry (the bundled-snapshot row shape). `code` is the standard code. */
export interface GazEntry {
  code: string
  name: string
  lon: number
  lat: number
}

/** Build an in-memory gazetteer from its metadata + a code→entry list. */
export function makeGazetteer(meta: GazetteerMeta, entries: readonly GazEntry[]): Gazetteer {
  const byCode = new Map<string, GazEntry>()
  for (const e of entries) byCode.set(e.code, e)
  return {
    ...meta,
    centroid: (code) => {
      const e = byCode.get(code)
      return e ? [e.lon, e.lat] : null
    },
    name: (code) => byCode.get(code)?.name ?? null,
  }
}

/** Resolve a standard-code column → WGS84 centroid, writing `${as}.lon` / `${as}.lat`
 *  (+ `${as}.name`). An INNER join: rows whose code is absent from the vintage are
 *  dropped (warn-once per code — the "missing sprite" pattern, never a throw across
 *  the dataset). The data's `vintage` MUST equal the gazetteer's; if the data also
 *  declared its code `system`, a mismatch throws — the guards against a reassigned or
 *  wrong-system code silently resolving to the wrong place. */
export function join(t: Table, o: { code: string; gaz: Gazetteer; as: string }): Table {
  if (t.vintage === undefined) {
    throw new Error(
      `[@xgis/pipeline] join needs the data vintage — stamp it at ingest ` +
        `(fromCSV(text, { vintage: '${o.gaz.vintage}' })) so it can be checked against the gazetteer.`,
    )
  }
  if (t.vintage !== o.gaz.vintage) {
    throw new Error(
      `[@xgis/pipeline] vintage mismatch: data is '${t.vintage}' but the ${o.gaz.country} ` +
        `${o.gaz.system} gazetteer is '${o.gaz.vintage}'. Admin codes get reassigned across years — ` +
        `resolving them against the wrong vintage silently mis-places features. Use a matching gazetteer.`,
    )
  }
  if (t.system !== undefined && t.system !== o.gaz.system) {
    throw new Error(
      `[@xgis/pipeline] code-system mismatch: data column "${o.code}" is '${t.system}' but the ` +
        `gazetteer is '${o.gaz.system}'. These are not interchangeable (e.g. 행정동 ≠ 법정동, ` +
        `FIPS ≠ ISO3166-2) — a wrong-system code resolves to the wrong place.`,
    )
  }
  const codeCol = t.col(o.code)
  const kept: number[] = []
  const lon: number[] = []
  const lat: number[] = []
  const nm: Cell[] = []
  const warned = new Set<string>()
  let dropped = 0
  for (let i = 0; i < t.length; i++) {
    const code = String(codeCol[i])
    const c = o.gaz.centroid(code)
    if (c === null) {
      dropped++
      if (!warned.has(code)) {
        warned.add(code)
        // eslint-disable-next-line no-console
        console.warn(
          `[@xgis/pipeline] join: code "${code}" not in the ${o.gaz.country} ${o.gaz.system} ` +
            `gazetteer (vintage ${o.gaz.vintage}) — row dropped`,
        )
      }
      continue
    }
    kept.push(i)
    lon.push(c[0])
    lat.push(c[1])
    nm.push(o.gaz.name(code) ?? '')
  }
  if (dropped > 0 && kept.length === 0) {
    throw new Error(
      `[@xgis/pipeline] join: NONE of ${t.length} codes resolved in the ${o.gaz.country} ` +
        `${o.gaz.system} gazetteer (vintage ${o.gaz.vintage}) — wrong code system or wrong vintage?`,
    )
  }
  const out = new Map<string, Cell[]>()
  for (const name of t.columns) {
    const src = t.col(name)
    out.set(
      name,
      kept.map((i) => src[i]!),
    )
  }
  out.set(`${o.as}.lon`, lon)
  out.set(`${o.as}.lat`, lat)
  out.set(`${o.as}.name`, nm)
  return new ColumnarTable(out, t.vintage, t.system)
}
