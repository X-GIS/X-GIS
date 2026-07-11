// 01 — Hello, map. The minimum XGISMap: a canvas, a scene, a render.
//
// Run in a browser module with a bundler that resolves `@xgis/map` (Vite/esbuild/…):
//   <canvas id="map" style="width:100vw;height:100vh"></canvas>
//   <script type="module" src="./01-hello-map.ts"></script>
import { XGISMap } from '@xgis/map'

// The scene is written in the `.xgis` style language. `run()` takes the style SOURCE
// string; `type: geojson url: …` fetches the data (relative to run()'s baseUrl, or an
// absolute URL as here). The `| …` utilities style the layer (Tailwind-like tokens).
const scene = `
  source world {
    type: geojson
    url: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson"
  }
  layer countries {
    source: world
    | fill-slate-800 stroke-cyan-400 stroke-1 opacity-95
  }
`

const canvas = document.getElementById('map') as HTMLCanvasElement

// 'auto' (default) runs on WebGPU and falls back to WebGL2 under ?forcegl2=1.
// Pin explicitly with backend: 'webgpu' | 'webgl2' if you need a fixed backend.
const map = new XGISMap(canvas, { backend: 'auto' })

await map.run(scene)

// The map is now live — scroll to zoom, drag to pan, shift-drag to rotate/pitch.
// Frame it on a region:
map.fitBounds([
  [-10, 35],
  [40, 60],
]) // [ [west, south], [east, north] ]

// When you're done, release GPU resources:
// map.destroy()
