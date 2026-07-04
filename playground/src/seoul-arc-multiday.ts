// ═══ Multi-day OD flow-map — proves n-day visualisation scales ═══
//
// The single-day hero animates 24 hours. This one adds a DATE axis: 3 days of real
// OA-22300 (20260529/30/31), each decoded ONCE, played back as a continuous
// date×hour timeline with a scrubber. The point is the SHAPE — a slider over
// (day, hour) frames. Extending to 1247 days is just more fixtures behind the same
// scrubber (or a server-backed range query); nothing about the render changes.

import { XGISMap } from '@xgis/runtime'
import { seoulSigunguGazetteer, decodeODB, fromRows, join, odFlow } from '@xgis/pipeline'

const DAYS = ['20260529', '20260530', '20260531'] // chronological
const HOURS = 24

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
const dateLabel = document.getElementById('date-label')!
const hourLabel = document.getElementById('hour-label')!
const slider = document.getElementById('scrubber') as HTMLInputElement
const playBtn = document.getElementById('play') as HTMLButtonElement
const gaz = seoulSigunguGazetteer({ vintage: '2026' })
const map = new XGISMap(canvas, {})
;(window as unknown as { __xgisMap?: unknown }).__xgisMap = map

type Row = { o_code: string; d_code: string; pop: number }

async function main(): Promise<void> {
  await map.run(STYLE, import.meta.env.BASE_URL + 'data/')
  map.setCenter(126.99, 37.55)
  map.setZoom(10.2)

  // Decode every day ONCE, index rows by hour per day.
  const dayData = new Map<string, Map<number, Row[]>>()
  await Promise.all(
    DAYS.map(async (d) => {
      const resp = await fetch(import.meta.env.BASE_URL + `data/fixture-seoul-od-${d}.odb`)
      const odb = decodeODB(await resp.arrayBuffer())
      const byHour = new Map<number, Row[]>()
      for (let i = 0; i < odb.rowCount; i++) {
        const h = odb.hour[i]!
        let rows = byHour.get(h)
        if (!rows) {
          rows = []
          byHour.set(h, rows)
        }
        rows.push({
          o_code: odb.dict[odb.origin[i]!]!,
          d_code: odb.dict[odb.dest[i]!]!,
          pop: odb.pop[i]!,
        })
      }
      dayData.set(d, byHour)
    }),
  )

  const totalFrames = DAYS.length * HOURS
  slider.max = String(totalFrames - 1)

  function renderFrame(frame: number): void {
    const dayIdx = Math.floor(frame / HOURS)
    const hour = frame % HOURS
    const day = DAYS[dayIdx]!
    const rows = dayData.get(day)!.get(hour) ?? []
    const t = fromRows(rows, { vintage: gaz.vintage })
    const j = join(join(t, { code: 'o_code', gaz, as: 'origin' }), { code: 'd_code', gaz, as: 'dest' })
    odFlow(j, { origin: 'origin', dest: 'dest', weight: 'pop' }).apply(map, 'arcs')
    dateLabel.textContent = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`
    hourLabel.textContent = `${String(hour).padStart(2, '0')}:00`
    slider.value = String(frame)
    map.invalidate()
  }

  let frame = 0
  renderFrame(frame)
  ;(window as unknown as { __xgisReady?: boolean }).__xgisReady = true

  // Scrubber — manual (day, hour) seek.
  slider.oninput = () => {
    frame = Number(slider.value)
    renderFrame(frame)
  }

  // Play/pause — advance one (day, hour) frame every 600ms, wrapping across days.
  let timer: ReturnType<typeof setInterval> | null = null
  function play(): void {
    if (timer) return
    playBtn.textContent = '⏸'
    timer = setInterval(() => {
      frame = (frame + 1) % totalFrames
      renderFrame(frame)
    }, 600)
  }
  function pause(): void {
    if (timer) clearInterval(timer)
    timer = null
    playBtn.textContent = '▶'
  }
  playBtn.onclick = () => (timer ? pause() : play())
  play() // autostart
}
void main()
