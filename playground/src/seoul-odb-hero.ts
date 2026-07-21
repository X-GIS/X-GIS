// ═══ Hero demo — real 수도권 생활이동 OD data via the .odb pipeline ═══
//
// The full loop the user asked for: the raw KT/서울 OD CSV (345MB / 5.2M rows/day,
// OA-22300) was aggregated OFFLINE by tools/csv-to-odb into a tiny .odb — this demo
// ships a committable ~26KB fixture (서울 top-2000 inflow) so it renders without the
// 345MB raw. The custom source-loader seam wires `odbLoader` (decode → sum inflow
// per 자치구 → join to 시군구 centroids → bubbles) to a declarative
// `source { type: "x-seoul-odb" }`. Nothing here touches the raw CSV.

import { XGISMap } from '@xgis/runtime'
import { seoulSigunguGazetteer, odbLoader } from '@xgis/pipeline'

const STYLE = `
xgis 1

background { fill: #020617 }

source gu_bounds {
  type: geojson
  url: "seoul_gu.geojson"
}
layer gu_fill {
  source: gu_bounds
  | fill-slate-900 stroke-slate-700 stroke-1 opacity-90
}

source flows {
  type: "x-seoul-odb"
  url: "fixture-seoul-od.odb"
}
layer flow_bubbles {
  source: flows
  | fill-orange-400 size-10 stroke-slate-900 stroke-1 opacity-90
}
`

const canvas = document.getElementById('map') as HTMLCanvasElement
const gaz = seoulSigunguGazetteer({ vintage: '2026' })

// Register the .odb loader: inflow = population arriving in each 자치구 (all hours).
const map = new XGISMap(canvas, {
  sources: { 'x-seoul-odb': odbLoader(gaz, { mode: 'inflow' }) },
})
;(window as unknown as { __xgisMap?: unknown }).__xgisMap = map

async function main(): Promise<void> {
  await map.run(STYLE, import.meta.env.BASE_URL + 'data/')
  map.setCenter(126.99, 37.55)
  map.setZoom(10.2)
  map.invalidate()
  ;(window as unknown as { __xgisReady?: boolean }).__xgisReady = true
}
void main()
