// ─── NOAA CO-OPS live tidal currents — the browser-DIRECT recipe (#1272) ───
//
// This is the code the `coops-currents` demo actually runs — the JS/TS tab in
// the playground shows THIS FILE verbatim, so what you read here is what draws
// on the map. It is Recipe 3 from docs/api/noaa-coverage-recipes.md ("live JSON,
// browser-direct, no proxy").
//
// The split, and why it exists:
//   • The DECLARATIVE part lives in coops-currents.xgis — a satellite basemap
//     plus an (initially empty) `source stations { type: geojson }` and a
//     `station_dots` layer that colours + sizes each point by its `.speed`
//     field. That is pure style; no code.
//   • The IMPERATIVE part is here — fetch the live observations, ASSEMBLE them
//     into GeoJSON (the CO-OPS API is not GeoJSON, and the station lon/lat is
//     not even in the response — it comes from the table below), then PUSH the
//     result into the declared source with `map.setSourceData`. That fan-out +
//     join + typing is data work, not style, so it is host code.
//
// Direction is the one thing the declarative layer cannot express yet: rotating
// EACH glyph by EACH station's `.dir` needs data-driven `icon-rotate` (#1302),
// which does not exist, so the arrows stay on the retained-graphics primitive
// `map.graphics.add({ type: 'arrow' })`. The remote-JSON source adapter (#1303)
// and a source `refresh:` property (#1304) would move the fetch + polling into
// the .xgis too; today they are the `fetch` + `setInterval` below.

import type { XGISMap } from '@xgis/runtime'

export interface Station {
  id: string
  lon: number
  lat: number
  name: string
  speed: number // cm/s
  dir: number // degrees true, the bearing the current flows TOWARD
}

// (id, lon, lat, name) for the 11 active Chesapeake Bay PORTS current stations —
// mdapi `stations.json?type=currents` filtered to the bay and snapshotted, so at
// runtime the demo needs only the per-station datagetter fetch (the coordinates
// are not returned by the observation endpoint).
export const COOPS_STATIONS: ReadonlyArray<readonly [string, number, number, string]> = [
  ['cb0102', -76.013, 36.959, 'Cape Henry'],
  ['cb0201', -76.134, 37.14, 'York Spit'],
  ['cb0301', -76.249, 37.011, 'Thimble Shoal'],
  ['cb0402', -76.334, 36.963, 'Naval Station Norfolk'],
  ['cb0601', -76.414, 36.956, 'Newport News Ch'],
  ['cb0801', -76.155, 37.674, 'Rappahannock Shoal'],
  ['cb1001', -76.384, 38.403, 'Cove Point'],
  ['cb1102', -76.39, 38.98, 'Chesapeake Bay Bridge'],
  ['cb1202', -76.333, 39.149, 'Brewerton Ch Ext'],
  ['cb1301', -75.828, 39.531, 'Chesapeake City'],
  ['cb1401', -76.444, 36.984, 'Newport News Shipbuilding'],
]

/** Speed (cm/s) → a blue→cyan→amber→red hex ramp for the direction arrows.
 *  (The declarative `station_dots` layer ramps the same field in the .xgis via
 *  `gradient(.speed, …)`; this mirror is only for the host-drawn arrows.) */
export function coopsSpeedColor(cmPerS: number): string {
  const stops: [number, [number, number, number]][] = [
    [0, [40, 90, 180]],
    [25, [30, 170, 200]],
    [60, [230, 180, 40]],
    [120, [220, 50, 40]],
  ]
  const s = Math.max(0, Math.min(120, cmPerS))
  let a = stops[0]!
  let b = stops[stops.length - 1]!
  for (let i = 0; i < stops.length - 1; i++) {
    if (s >= stops[i]![0] && s <= stops[i + 1]![0]) {
      a = stops[i]!
      b = stops[i + 1]!
      break
    }
  }
  const t = b[0] === a[0] ? 0 : (s - a[0]) / (b[0] - a[0])
  const ch = (i: number): string =>
    Math.round(a[1][i]! + (b[1][i]! - a[1][i]!) * t)
      .toString(16)
      .padStart(2, '0')
  return `#${ch(0)}${ch(1)}${ch(2)}`
}

export interface CoopsHandle {
  stop(): void
}

/** Fetch one station's latest observed current from the CO-OPS datagetter
 *  (CORS `*`, so this runs straight from the browser). Returns null on any
 *  failure so one dead station never blanks the whole field. */
async function fetchStation(
  id: string,
  lon: number,
  lat: number,
  name: string,
): Promise<Station | null> {
  try {
    const url =
      `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?date=latest&station=${id}` +
      `&product=currents&units=metric&time_zone=gmt&format=json`
    const res = await fetch(url)
    if (!res.ok) return null
    const j = (await res.json()) as { data?: { s?: string; d?: string }[] }
    const row = j.data?.[0]
    if (!row || row.s === undefined || row.d === undefined) return null
    return { id, lon, lat, name, speed: parseFloat(row.s), dir: parseFloat(row.d) }
  } catch {
    return null
  }
}

/**
 * Wire the CO-OPS live-currents overlay onto `map`.
 *
 *   1. fetch the latest current for every Chesapeake Bay PORTS station,
 *   2. PUSH the assembled points into the declared `stations` geojson source
 *      (`setSourceData`) — the `station_dots` layer then colours/sizes them by
 *      `.speed` with zero draw code here (the declarative path),
 *   3. draw one DIRECTION arrow per station via the retained-graphics API
 *      (the per-feature rotation the declarative layer can't do yet, #1302),
 *   4. repeat every 6 minutes (the CO-OPS current cadence, #1304).
 *
 * `onStatus` reports progress for the demo's badge. Returns a handle whose
 * `stop()` cancels the timer and removes the arrows.
 */
export function installCoopsCurrents(
  map: XGISMap,
  onStatus?: (ready: number, total: number, asOf: string | null) => void,
): CoopsHandle {
  let cancelled = false
  let arrows: { remove(): void } | null = null

  const refresh = async (): Promise<void> => {
    const results = await Promise.all(
      COOPS_STATIONS.map(([id, lon, lat, name]) => fetchStation(id, lon, lat, name)),
    )
    if (cancelled) return
    const stations = results.filter((s): s is Station => s !== null)

    // (2) Declarative path: assemble GeoJSON and hand it to the map; the .xgis
    //     `station_dots` layer renders speed as colour + size. This "declare a
    //     source, push data in" shape is the same host-push API fixtures use.
    map.setSourceData('stations', {
      type: 'FeatureCollection',
      features: stations.map((s) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [s.lon, s.lat] },
        properties: { name: s.name, speed: s.speed, dir: s.dir },
      })),
    })

    // (3) Direction: the retained-graphics arrow is the ONLY primitive that
    //     rotates per feature today (#1302 would make this a declarative layer).
    arrows?.remove()
    arrows =
      stations.length > 0
        ? map.graphics.add({
            type: 'arrow',
            data: stations,
            getPosition: (d: Station) => [d.lon, d.lat] as const,
            getBearing: (d: Station) => d.dir,
            getSize: (d: Station) => Math.max(10, Math.min(46, 10 + Math.sqrt(d.speed) * 4)),
            getColor: (d: Station) => coopsSpeedColor(d.speed),
          })
        : null

    onStatus?.(
      stations.length,
      COOPS_STATIONS.length,
      stations.length ? new Date().toLocaleTimeString() : null,
    )
    ;(window as unknown as { __xgisCoopsStations?: number }).__xgisCoopsStations = stations.length
  }

  void refresh()
  const timer = setInterval(() => void refresh(), 6 * 60 * 1000)

  return {
    stop(): void {
      cancelled = true
      clearInterval(timer)
      arrows?.remove()
    },
  }
}
