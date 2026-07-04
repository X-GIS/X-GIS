// ═══ Hero demo — OD flow-lines with a daily pulse (real 생활이동 data) ═══
//
// Extends the .odb hero: instead of per-자치구 inflow bubbles, it draws the actual
// origin→destination FLOW LINES (odFlow LineString FC), animated over the day.
//
// Architecture (survey-confirmed): the source-loader seam is construction-immutable,
// so animation does NOT go through it. Instead — decode the .odb ONCE, index rows by
// hour, then each tick filter+odFlow+setSourceData re-inject (the blessed renderHour
// pattern from seoul-pipeline.ts). At top-N fixture scale (~85 lines/hour) the geojson
// re-tile is cheap. NOTE: these are STRAIGHT flow-lines; curved great-circle arcs
// (bulge) need a retained arc draper — deferred as a perf/visual follow-up.

import { XGISMap } from '@xgis/runtime'
import { seoulSigunguGazetteer, decodeODB, fromRows, join, odFlow } from '@xgis/pipeline'

const STYLE = `
background { fill: #020617 }

source gu_bounds {
  type: geojson
  url: "seoul_gu.geojson"
}
layer gu_fill {
  source: gu_bounds
  | fill-slate-900 stroke-slate-700 stroke-1 opacity-90
}

source arcs {
  type: geojson
}
layer arc_lines {
  source: arcs
  | stroke-orange-400 stroke-2 opacity-70
}
`

const canvas = document.getElementById('map') as HTMLCanvasElement
const hourLabel = document.getElementById('hour-label')!
const gaz = seoulSigunguGazetteer({ vintage: '2026' })
const map = new XGISMap(canvas, {})
;(window as unknown as { __xgisMap?: unknown }).__xgisMap = map

type Row = { o_code: string; d_code: string; pop: number }

async function main(): Promise<void> {
  await map.run(STYLE, import.meta.env.BASE_URL + 'data/')
  map.setCenter(126.99, 37.55)
  map.setZoom(10.2)

  // Decode ONCE, index rows by hour (typed-array read, zero re-fetch per frame).
  const resp = await fetch(import.meta.env.BASE_URL + 'data/fixture-seoul-od.odb')
  const odb = decodeODB(await resp.arrayBuffer())
  const byHour = new Map<number, Row[]>()
  for (let i = 0; i < odb.rowCount; i++) {
    const h = odb.hour[i]!
    let rows = byHour.get(h)
    if (!rows) {
      rows = []
      byHour.set(h, rows)
    }
    rows.push({ o_code: odb.dict[odb.origin[i]!]!, d_code: odb.dict[odb.dest[i]!]!, pop: odb.pop[i]! })
  }
  const hours = [...byHour.keys()].sort((a, b) => a - b)

  function renderHour(hour: number): void {
    const rows = byHour.get(hour) ?? []
    const t = fromRows(rows, { vintage: gaz.vintage })
    // Double-join: mint origin.lon/lat + dest.lon/lat, then odFlow → LineString FC.
    const j = join(join(t, { code: 'o_code', gaz, as: 'origin' }), { code: 'd_code', gaz, as: 'dest' })
    odFlow(j, { origin: 'origin', dest: 'dest', weight: 'pop' }).apply(map, 'arcs')
    hourLabel.textContent = `${String(hour).padStart(2, '0')}:00`
    map.invalidate()
  }

  // First frame: a representative commute hour (08:00 if present, else the first).
  const firstHour = hours.includes(8) ? 8 : (hours[0] ?? 0)
  if (hours.length > 0) renderHour(firstHour)
  ;(window as unknown as { __xgisReady?: boolean }).__xgisReady = true

  // No hours → nothing to animate (empty .odb); skip the interval so the label
  // never shows "undefined:00" (code-review MEDIUM).
  if (hours.length === 0) return

  // Daily pulse — cycle hours every 2.5s (the city breathing). Store the handle on
  // window so an HMR reload can clear the prior interval instead of stacking them.
  let idx = hours.indexOf(firstHour)
  const w = window as unknown as { __xgisArcInterval?: ReturnType<typeof setInterval> }
  if (w.__xgisArcInterval) clearInterval(w.__xgisArcInterval)
  w.__xgisArcInterval = setInterval(() => {
    idx = (idx + 1) % hours.length
    renderHour(hours[idx]!)
  }, 2500)
}
void main()
