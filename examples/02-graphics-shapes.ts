// 02 — Retained graphics: circles. Geo-anchored discs, drawn and styled from code.
//
//   <canvas id="map" style="width:100vw;height:100vh"></canvas>
//   <script type="module" src="./02-graphics-shapes.ts"></script>
import { XGISMap } from '@xgis/map'

const canvas = document.getElementById('map') as HTMLCanvasElement
const map = new XGISMap(canvas)

await map.run(`
  source world {
    type: geojson
    url: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson"
  }
  layer bg { source: world | fill-slate-800 stroke-slate-600 stroke-1 }
`)

type City = { name: string; lonLat: [number, number]; pop: number }
const cities: City[] = [
  { name: 'Seoul', lonLat: [126.98, 37.57], pop: 9.7 },
  { name: 'Tokyo', lonLat: [139.69, 35.69], pop: 13.9 },
  { name: 'Delhi', lonLat: [77.1, 28.7], pop: 32.9 },
  { name: 'São Paulo', lonLat: [-46.63, -23.55], pop: 12.3 },
  { name: 'Lagos', lonLat: [3.39, 6.52], pop: 15.4 },
]

// A retained circle batch. Every accessor runs ONCE at add() (pure — never read the
// live camera/zoom inside them): radius scales with population, the fill is data-driven,
// and a white ring strokes each disc. A camera move rewrites only the frame uniform —
// the instances are packed once, so 10 or 100k circles cost the same per frame.
const cityDots = map.graphics.add({
  type: 'circle',
  data: cities,
  getPosition: (c) => c.lonLat,
  getRadius: (c) => 4 + c.pop, // px
  getColor: (c) => (c.pop >= 15 ? '#ff3b30' : '#0a84ff'),
  getStrokeColor: '#ffffff',
  getStrokeWidth: 2,
  updateTriggers: { color: 1 }, // marks getColor re-packable via update({ triggers: ['color'] })
})

console.log(`drew ${cityDots.count} city circles`)

// Re-run ONLY the fill (one buffer upload, geometry untouched):
//   cityDots.update({ triggers: ['color'] })
// Remove the batch and free its GPU buffers:
//   cityDots.remove()
