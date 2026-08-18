// ═══ Built-in JSON field-mapping source loader (#1303) ═══
//
// Closes the declarative gap docs/architecture/source-loader-seam.md#1303-hunt
// identified: a REST endpoint that returns bespoke JSON, not GeoJSON — e.g.
// NOAA CO-OPS' `{ "data": [ { "s": "34.5", "d": "210" } ] }` — has no built-in
// `type:` today, so a host had to hand-assemble GeoJSON and push it via
// `setSourceData`. This is a `SourceLoader` FACTORY (source-loader-seam.md §6's
// "typed constructor params" pattern, not the free-form `ctx.options` bag): a
// host picks a registry key and declares the mapping once in JS —
//
//   const map = new XGISMap(canvas, {
//     sources: {
//       json: jsonFieldMappingLoader({
//         recordsPath: 'data',
//         lon: 'longitude',
//         lat: 'latitude',
//         properties: { speed: 's', dir: 'd' },
//       }),
//     },
//   })
//
//   source stations { type: "json", url: "https://.../stations.json" }
//
// A missing/ambiguous mapping fails at THIS call (construction), not deep
// inside a fetch — same rationale as source-loader-seam.md §6's krAdminLoader.
//
// Single-document only, matching the issue's stated scope: a product whose
// lon/lat live in a SEPARATE table (the CO-OPS case itself — see
// playground/src/examples/coops-currents.recipe.ts) needs a multi-URL fan-out
// + join, which is genuine ETL and stays host-side by design (CLAUDE.md §12 —
// read the JSON standard in place, don't invent a transcode step here).

import {
  assertIngestBudget,
  assertNotErrorPage,
  readBodyCapped,
  XGISInputError,
} from '@xgis/shared'
import type { SourceLoader } from './source-loader'

/** Declarative field mapping for `jsonFieldMappingLoader`. Every path is a
 *  dot-separated JSON field path (`"a.b"` → `doc.a.b`), so a record's fields
 *  can be nested one or more levels deep. */
export interface JsonFieldMappingOptions {
  /** Path to the array of records inside the fetched document (e.g. `"data"`
   *  for `{ "data": [...] }`). Omit when the document's top level IS the
   *  array of records. */
  recordsPath?: string
  /** Per-record field holding longitude. Must be paired with `lat`;
   *  mutually exclusive with `coordinates`. */
  lon?: string
  /** Per-record field holding latitude. Must be paired with `lon`. */
  lat?: string
  /** Per-record field holding a `[lon, lat]` pair, as an alternative to
   *  separate `lon`/`lat` fields. Mutually exclusive with `lon`/`lat`. */
  coordinates?: string
  /** Output property name → source field path. Omit to pass the whole
   *  record through as `properties` verbatim (the record itself becomes
   *  the feature's property bag). */
  properties?: Readonly<Record<string, string>>
}

// Same DoS ceiling the built-in geojson-URL branch uses (source-manager.ts) —
// far above any interactive dataset, bounded so a pathological body can't
// OOM the tab before JSON.parse even runs.
const MAX_JSON_BYTES = 256 * 1024 * 1024

/** Walk a dot-separated path into a JSON value. Returns `undefined` on any
 *  missing/non-object hop rather than throwing — a field absent from ONE
 *  record is a per-record concern the caller decides how to handle, not a
 *  loader-fatal one. */
function getPath(value: unknown, path: string): unknown {
  let cur = value
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

/** Coerce a record field to a finite number, or `undefined` if it isn't one
 *  (missing, `null`, an empty/blank string, a non-numeric string, `NaN`, or
 *  `±Infinity`). A dropped record beats a NaN/0,0 vertex reaching the f32 GPU
 *  mesh — the same non-finite-drops-not-propagates convention `@xgis/data`'s
 *  MVT decoder uses for malformed coordinates (`data/src/mvt-decoder.ts`),
 *  adapted to "drop the point" since there is no in-bounds clamp target for
 *  an independent observation the way a tile-local vertex has one. */
function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return undefined
    const n = Number(trimmed)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/**
 * A built-in `SourceLoader` factory: fetches a JSON document and maps an
 * array of arbitrary records to Point features by field name. Register the
 * result under a `.xgis` custom `type:` key (`XGISMapOptions.sources`) —
 * see the module header for the full wiring.
 *
 * Throws at CALL time when the mapping itself is ambiguous or incomplete
 * (neither/both of `{lon,lat}`/`coordinates` given, or only one of `lon`/
 * `lat`). Malformed per-record DATA — a record missing its coordinate
 * field(s), or one whose value doesn't parse to a finite number — is a
 * per-record concern: that record is dropped (and the drop count logged),
 * the rest of the document still renders.
 */
export function jsonFieldMappingLoader(options: JsonFieldMappingOptions): SourceLoader {
  const { recordsPath, lon, lat, coordinates, properties } = options
  if ((lon !== undefined) !== (lat !== undefined)) {
    throw new Error(
      `[X-GIS] jsonFieldMappingLoader: 'lon' and 'lat' must both be set or both omitted ` +
        `(got lon=${JSON.stringify(lon)}, lat=${JSON.stringify(lat)}).`,
    )
  }
  const hasLonLat = lon !== undefined && lat !== undefined
  const hasCoordinates = coordinates !== undefined
  if (hasLonLat === hasCoordinates) {
    throw new Error(
      `[X-GIS] jsonFieldMappingLoader: pass exactly one of { lon, lat } or { coordinates } ` +
        `to locate each record (got ${hasLonLat ? 'both' : 'neither'}).`,
    )
  }

  return async ({ id, url, fetch }) => {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(
        `[X-GIS] json source "${id}": failed to load ${url} — HTTP ${response.status}.`,
      )
    }
    const rawBytes = await readBodyCapped(response, MAX_JSON_BYTES, `json source "${id}"`)
    assertNotErrorPage(response, rawBytes, `json source "${id}" (${url})`)
    let doc: unknown
    try {
      doc = JSON.parse(new TextDecoder().decode(rawBytes))
    } catch (e) {
      throw new XGISInputError(
        `[X-GIS] json source "${id}": ${url} did not parse as JSON ` +
          `(${e instanceof Error ? e.message : String(e)}).`,
      )
    }
    const records = recordsPath === undefined ? doc : getPath(doc, recordsPath)
    if (!Array.isArray(records)) {
      throw new XGISInputError(
        `[X-GIS] json source "${id}": expected an array of records at ` +
          `${recordsPath === undefined ? 'the document root' : `"${recordsPath}"`}, got ` +
          `${records === undefined ? 'undefined' : typeof records}.`,
      )
    }

    const features: Array<{
      type: 'Feature'
      geometry: { type: 'Point'; coordinates: [number, number] }
      properties: Record<string, unknown>
    }> = []
    let dropped = 0
    for (const record of records) {
      if (record === null || typeof record !== 'object') {
        dropped++
        continue
      }
      let lonNum: number | undefined
      let latNum: number | undefined
      if (hasCoordinates) {
        const pair = getPath(record, coordinates as string)
        if (Array.isArray(pair)) {
          lonNum = finiteNumber(pair[0])
          latNum = finiteNumber(pair[1])
        }
      } else {
        lonNum = finiteNumber(getPath(record, lon as string))
        latNum = finiteNumber(getPath(record, lat as string))
      }
      if (lonNum === undefined || latNum === undefined) {
        dropped++
        continue
      }
      let props: Record<string, unknown>
      if (properties) {
        props = {}
        for (const outKey of Object.keys(properties))
          props[outKey] = getPath(record, properties[outKey])
      } else {
        props = record as Record<string, unknown>
      }
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lonNum, latNum] },
        properties: props,
      })
    }
    if (dropped > 0) {
      console.warn(
        `[X-GIS] json source "${id}": dropped ${dropped} of ${records.length} record(s) ` +
          `with missing/non-finite coordinates.`,
      )
    }
    assertIngestBudget(features, `json source "${id}"`)
    return { kind: 'fc', data: { type: 'FeatureCollection', features } }
  }
}
