// 04 — Text overlays. Geo-anchored labels that reproject every frame.
//
//   <canvas id="map" style="width:100vw;height:100vh"></canvas>
//   <script type="module" src="./04-text-overlays.ts"></script>
import { XGISMap } from '@xgis/map'

const canvas = document.getElementById('map') as HTMLCanvasElement
const map = new XGISMap(canvas)

await map.run(`
  source world {
    type: geojson
    url: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson"
  }
  layer bg { source: world | fill-slate-800 }
`)

// A geo-anchored text overlay — the map reprojects the anchor each frame, so the label
// tracks its lon/lat as you pan and zoom.
const seoul = map.addOverlay({
  text: 'Seoul',
  anchor: [126.98, 37.57], // [lon, lat]
  size: 18, // display px
  color: [1, 1, 1, 1], // rgba, 0..1 per channel
})

console.log('overlay added:', seoul)

// The returned handle lets you remove the label later:
//   seoul.remove()
