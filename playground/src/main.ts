import { XGISMap } from '@xgis/runtime'

// ═══ Demo Scenes ═══

const DEMOS: Record<string, { name: string; description: string; source: string }> = {
  raster_vector: {
    name: 'Raster + Vector',
    description: 'OpenStreetMap tiles with country borders overlay',
    source: `
let basemap = load("https://tile.openstreetmap.org/{z}/{x}/{y}.png")
let countries = load("countries.geojson")

show basemap {}
show countries {
    fill: #3a6b4e40
    stroke: #ffffff80, 1px
}
`,
  },

  new_syntax: {
    name: 'New Syntax (source/layer)',
    description: 'Tailwind utility styling with source/layer blocks',
    source: `
source world {
  type: geojson
  url: "countries.geojson"
}

layer countries {
  source: world
  | fill-green-200 stroke-gray-400 stroke-1 opacity-90
}
`,
  },

  dark_theme: {
    name: 'Dark Theme',
    description: 'Dark map with bright borders',
    source: `
source world {
  type: geojson
  url: "countries.geojson"
}

layer countries {
  source: world
  | fill-slate-800 stroke-cyan-400 stroke-1 opacity-95
}
`,
  },

  raster_overlay: {
    name: 'Raster + Styled Overlay',
    description: 'OSM tiles with blue translucent country fill',
    source: `
let basemap = load("https://tile.openstreetmap.org/{z}/{x}/{y}.png")

source world {
  type: geojson
  url: "countries.geojson"
}

show basemap {}

layer overlay {
  source: world
  | fill-blue-500 opacity-30 stroke-white stroke-1
}
`,
  },

  zoom_modifiers: {
    name: 'Zoom Modifiers',
    description: 'Opacity changes with zoom level (zoom in/out to see)',
    source: `
source world {
  type: geojson
  url: "countries.geojson"
}

layer countries {
  source: world
  | fill-purple-400 stroke-purple-200 stroke-1
  | z2:opacity-30 z5:opacity-60 z8:opacity-90
}
`,
  },

  data_modifiers: {
    name: 'Data Modifiers',
    description: 'Conditional styling by feature properties',
    source: `
source world {
  type: geojson
  url: "countries.geojson"
}

preset base_style {
  | stroke-gray-500 stroke-1 opacity-85
}

layer countries {
  source: world
  | apply-base_style
  | fill-gray-300
}
`,
  },

  multi_layer: {
    name: 'Multi-Layer',
    description: 'Multiple layers with different styles',
    source: `
let basemap = load("https://tile.openstreetmap.org/{z}/{x}/{y}.png")

source world {
  type: geojson
  url: "countries.geojson"
}

show basemap {}

layer fill_layer {
  source: world
  | fill-orange-200 opacity-40
}

layer border_layer {
  source: world
  | stroke-red-500 stroke-2 opacity-80
}
`,
  },

  vector_tiles: {
    name: 'Vector Tiles (.xgvt)',
    description: 'Pre-tiled vector data with COG-style loading (5.7MB vs 14MB GeoJSON)',
    source: `
let world = load("countries.xgvt")

show world {
  fill: #2d6a4f80
  stroke: #95d5b2, 1px
}
`,
  },

  minimal: {
    name: 'Minimal',
    description: 'Simplest possible X-GIS program',
    source: `
let world = load("countries.geojson")
show world {
  fill: #f2efe9
  stroke: #ccc, 1px
}
`,
  },
}

// ═══ App ═══

let currentMap: XGISMap | null = null

async function loadDemo(key: string) {
  const demo = DEMOS[key]
  if (!demo) return

  const canvas = document.getElementById('map') as HTMLCanvasElement
  const status = document.getElementById('status')!
  const errorDiv = document.getElementById('error')!
  const errorMsg = document.getElementById('error-msg')!

  errorDiv.style.display = 'none'

  // Stop previous map
  currentMap?.stop()

  try {
    status.textContent = `Loading: ${demo.name}...`
    status.style.opacity = '1'

    currentMap = new XGISMap(canvas)
    await currentMap.run(demo.source, '/data/')

    status.textContent = `X-GIS | ${demo.name} | scroll to zoom, drag to pan`
    setTimeout(() => { status.style.opacity = '0.5' }, 3000)
  } catch (err) {
    console.error('[X-GIS]', err)
    errorDiv.style.display = 'block'
    errorMsg.textContent = String(err)
  }

  // Update active button
  document.querySelectorAll('#demo-picker button').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-demo') === key)
  })

  // Update URL hash
  history.replaceState(null, '', `#${key}`)
}

function init() {
  // Build demo picker
  const picker = document.getElementById('demo-picker')!
  for (const [key, demo] of Object.entries(DEMOS)) {
    const btn = document.createElement('button')
    btn.setAttribute('data-demo', key)
    btn.textContent = demo.name
    btn.title = demo.description
    btn.addEventListener('click', () => loadDemo(key))
    picker.appendChild(btn)
  }

  // Load from URL hash or default
  const hash = location.hash.slice(1)
  const startDemo = hash && DEMOS[hash] ? hash : 'raster_vector'
  loadDemo(startDemo)
}

init()
