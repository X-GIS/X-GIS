// 03 — Retained graphics: sprite icons + a movement vector field (arrows).
//
//   <canvas id="map" style="width:100vw;height:100vh"></canvas>
//   <script type="module" src="./03-graphics-icons-arrows.ts"></script>
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

// Register a sprite under a name. Any ImageBitmap / ImageData works; here a 16×16 red dot.
// Register images BEFORE add() so the batch can resolve them.
const dot = new ImageData(16, 16)
for (let i = 0; i < dot.data.length; i += 4) {
  dot.data[i] = 255 // R
  dot.data[i + 3] = 255 // A
}
map.addImage('dot', dot)

// Icon markers — geo-anchored sprites, tinted per feature.
type Marker = { at: [number, number]; tint: string }
map.graphics.add({
  type: 'icon',
  data: [
    { at: [126.98, 37.57], tint: '#34c759' },
    { at: [139.69, 35.69], tint: '#ffd60a' },
  ] as Marker[],
  getPosition: (d) => d.at,
  getImage: 'dot',
  getSize: 1.5, // × the sprite's native px
  getColor: (d) => d.tint, // tint modulates the sprite
})

// Arrows — a movement vector field. Each item carries a geo anchor + a GEOGRAPHIC bearing
// (0 = north, clockwise). The direction is projected on the GPU, so it stays correct under
// camera bearing / pitch / on the globe — NOT a screen angle frozen at add()-time.
type Flow = { at: [number, number]; deg: number; len: number }
map.graphics.add({
  type: 'arrow',
  data: [
    { at: [126.98, 37.57], deg: 45, len: 44 },
    { at: [139.69, 35.69], deg: 120, len: 30 },
    { at: [77.1, 28.7], deg: 200, len: 36 },
  ] as Flow[],
  getPosition: (d) => d.at,
  getBearing: (d) => d.deg,
  getSize: (d) => d.len, // arrow length in px (tail → tip)
  getColor: '#0a84ff',
})
