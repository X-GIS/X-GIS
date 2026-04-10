import { XGISMap } from '@xgis/runtime'

// X-GIS — Raster + Vector Layering

const LAYERED_MAP = `
let basemap = load("https://tile.openstreetmap.org/{z}/{x}/{y}.png")
let countries = load("countries.geojson")

show basemap {}
show countries {
    fill: #3a6b4e40
    stroke: #ffffff80, 1px
}
`

async function main() {
  const canvas = document.getElementById('map') as HTMLCanvasElement
  const status = document.getElementById('status')!
  const errorDiv = document.getElementById('error')!
  const errorMsg = document.getElementById('error-msg')!

  if (!navigator.gpu) {
    errorDiv.style.display = 'block'
    errorMsg.textContent = 'WebGPU is not supported in this browser.\nPlease use Chrome 113+ or Edge 113+.'
    return
  }

  try {
    status.textContent = 'X-GIS loading...'
    const map = new XGISMap(canvas)
    await map.run(LAYERED_MAP, '/data/')
    status.textContent = 'X-GIS | Raster + Vector | scroll to zoom, drag to pan'
    setTimeout(() => { status.style.opacity = '0.5' }, 3000)
  } catch (err) {
    console.error('[X-GIS]', err)
    errorDiv.style.display = 'block'
    errorMsg.textContent = String(err)
  }
}

main()
