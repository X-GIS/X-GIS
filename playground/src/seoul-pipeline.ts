// ═══ @xgis/pipeline demo — Seoul 생활이동 bubble map ═══
//
// Proves the data-to-viz pipeline end-to-end on the REAL map: a code-keyed tabular
// sample (per-자치구 생활이동 outflow, by hour) → join to the bundled 시군구
// gazetteer → groupBy → bubble encoder → setSourcePoints → rendered on the globe.
// The flow data is a HONEST SAMPLE (the real 60MB portal file is not fetchable);
// it reproduces the daily rhythm (AM outflow from residential gu, PM from job
// centres) so the pulse reads. The pipeline is the point — swap in the real file
// and nothing else changes.

import { XGISMap } from '@xgis/runtime'
import {
  fromRows,
  load,
  where,
  filter,
  groupBy,
  bubble,
  seoulSigunguGazetteer,
  SEOUL_SIGUNGU,
} from '@xgis/pipeline'

// ── Honest sample: a per-자치구 daily-outflow profile. Job centres (강남/서초/중구/
// 영등포) draw people IN during the AM (low AM outflow) and release them PM (high PM
// outflow); residential gu (노원/도봉/은평/강서…) do the reverse. Magnitude ∝ a rough
// population weight so the bubbles read plausibly. NOT the real KT dataset. ──
const JOB_CENTRES = new Set(['11680', '11650', '11140', '11560', '11110', '11170', '11440'])
const POP_WEIGHT: Record<string, number> = {
  '11110': 15,
  '11140': 12,
  '11170': 22,
  '11200': 30,
  '11215': 35,
  '11230': 34,
  '11260': 39,
  '11290': 44,
  '11305': 31,
  '11320': 33,
  '11350': 52,
  '11380': 48,
  '11410': 31,
  '11440': 37,
  '11470': 46,
  '11500': 58,
  '11530': 40,
  '11545': 23,
  '11560': 38,
  '11590': 39,
  '11620': 50,
  '11650': 42,
  '11680': 54,
  '11710': 66,
  '11740': 45,
}
function buildSample(): Array<{ gu: string; hour: number; out: number }> {
  const rows: Array<{ gu: string; hour: number; out: number }> = []
  for (const { code } of SEOUL_SIGUNGU) {
    const pop = POP_WEIGHT[code] ?? 30
    const job = JOB_CENTRES.has(code)
    for (const hour of [8, 18]) {
      // AM: residents leave home (residential high); PM: workers leave work (job-centre high).
      const amFactor = job ? 0.45 : 1.15
      const pmFactor = job ? 1.35 : 0.6
      const out = Math.round(pop * 1000 * (hour === 8 ? amFactor : pmFactor))
      rows.push({ gu: code, hour, out })
    }
  }
  return rows
}

// Inline .xgis: dark base, 자치구 boundary context, + 4 bubble tiers (each a point
// source the pipeline fills, sized/coloured by outflow magnitude — a warm ramp).
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

source flow_t0 { type: geojson }
source flow_t1 { type: geojson }
source flow_t2 { type: geojson }
source flow_t3 { type: geojson }
layer f0 {
  source: flow_t0
  | fill-amber-300 size-10 opacity-80 stroke-slate-900 stroke-1
}
layer f1 {
  source: flow_t1
  | fill-orange-400 size-20 opacity-85 stroke-slate-900 stroke-1
}
layer f2 {
  source: flow_t2
  | fill-orange-500 size-32 opacity-88 stroke-slate-900 stroke-1
}
layer f3 {
  source: flow_t3
  | fill-red-500 size-46 opacity-90 stroke-slate-900 stroke-1
}
`

const canvas = document.getElementById('map') as HTMLCanvasElement
const hourLabel = document.getElementById('hour-label')!
const map = new XGISMap(canvas, {})
;(window as unknown as { __xgisMap?: unknown }).__xgisMap = map

const gaz = seoulSigunguGazetteer({ vintage: '2026' })
const sample = fromRows(buildSample(), { vintage: '2026' })

// 4 magnitude tiers by outflow (fixed cut points across the sample's range).
const TIERS: Array<[number, number]> = [
  [0, 25_000],
  [25_000, 45_000],
  [45_000, 65_000],
  [65_000, Infinity],
]

// Each tier is a COMPLETE declarative statement — which data → how it loads → how it shows.
// (At real-file scale you'd hoist the shared join+groupBy above the tier loop, docs §9;
// here the sample is 25 rows, so legibility wins over the join-once micro-opt.)
function renderHour(hour: number): void {
  TIERS.forEach(([lo, hi], t) => {
    load({
      from: sample, // WHICH — the code-keyed outflow table
      join: { code: 'gu', gaz, as: 'gu' }, // HOW loaded → 시군구 centroid (mints gu.lon/gu.lat)
      transform: [
        (tb) => where(tb, { hour }), // this hour
        (tb) => groupBy(tb, { by: ['gu.lon', 'gu.lat', 'gu.name'], agg: { out: 'sum' } }),
        (tb) => filter(tb, (r) => Number(r.out) >= lo && Number(r.out) < hi), // this magnitude tier
      ],
      show: (tb) => bubble(tb, { lon: 'gu.lon', lat: 'gu.lat', value: 'out' }), // HOW shown
    }).apply(map, `flow_t${t}`)
  })
  hourLabel.textContent = `${String(hour).padStart(2, '0')}:00`
}

async function main(): Promise<void> {
  await map.run(STYLE, import.meta.env.BASE_URL + 'data/')
  map.setCenter(126.99, 37.55)
  map.setZoom(10.2)
  renderHour(8)
  map.invalidate()
  ;(window as unknown as { __xgisReady?: boolean }).__xgisReady = true

  // Daily pulse — cycle AM ↔ PM every 2.5 s (the essence: the city breathing).
  let hour = 8
  setInterval(() => {
    hour = hour === 8 ? 18 : 8
    renderHour(hour)
    map.invalidate()
  }, 2500)
}
void main()
