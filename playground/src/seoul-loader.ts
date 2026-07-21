// ═══ Custom source-loader DEMO — the DECLARATIVE seam ═══
//
// The essence the user asked for: the render + layer system is already complete,
// so a custom data type only needs a LOADER. Here `.xgis` declares
// `source flows { type: x-kr-admin, url: "seoul_outflow.csv" }` — a type the 7
// built-ins don't cover — and a per-map `krAdminLoader` (registered at
// construction) resolves it: fetch the code-keyed CSV → join each 자치구 code to
// its WGS84 centroid → emit a bubble FeatureCollection → the existing render
// pipeline draws it. No imperative `.apply()`; the source block IS the wiring.
// Design: docs/architecture/source-loader-seam.md.

import { XGISMap } from '@xgis/runtime'
import { seoulSigunguGazetteer, krAdminLoader } from '@xgis/pipeline'

// A custom `type: x-kr-admin` source, declared like any built-in source.
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
  type: "x-kr-admin"
  url: "seoul_outflow.csv"
}
layer flow_bubbles {
  source: flows
  | fill-orange-400 size-9 stroke-slate-900 stroke-1 opacity-90
}
`

const canvas = document.getElementById('map') as HTMLCanvasElement
const gaz = seoulSigunguGazetteer({ vintage: '2026' })

// Register the loader at construction — construction-immutable, per-canvas.
const map = new XGISMap(canvas, {
  sources: {
    'x-kr-admin': krAdminLoader(gaz, { codeColumn: 'gu', valueColumn: 'out' }),
  },
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
