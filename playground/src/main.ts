import { XGISMap } from '@xgis/runtime'

// ═══ Demo Scenes ═══

const DEMOS: Record<string, { name: string; description: string; source: string }> = {
  // ── Basic ──

  minimal: {
    name: 'Minimal',
    description: 'Simplest X-GIS program — one source, one layer',
    source: `
source world {
  type: geojson
  url: "countries.geojson"
}

layer countries {
  source: world
  | fill-stone-200 stroke-stone-400 stroke-1
}
`,
  },

  dark: {
    name: 'Dark Theme',
    description: 'Dark fill with bright borders',
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

  // ── Raster ──

  raster: {
    name: 'Raster + Borders',
    description: 'OpenStreetMap tiles with country border overlay',
    source: `
source basemap {
  type: raster
  url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
}

source world {
  type: geojson
  url: "countries.geojson"
}

layer tiles {
  source: basemap
}

layer borders {
  source: world
  | fill-blue-500 opacity-20 stroke-white stroke-1
}
`,
  },

  // ── Zoom ──

  zoom: {
    name: 'Zoom Styles',
    description: 'Opacity changes with zoom level — zoom in/out to see',
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

  // ── Multi-Layer ──

  multi_layer: {
    name: 'Multi-Layer',
    description: 'Same source, different layer styles stacked',
    source: `
source basemap {
  type: raster
  url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
}

source world {
  type: geojson
  url: "countries.geojson"
}

layer tiles {
  source: basemap
}

layer fill {
  source: world
  | fill-orange-200 opacity-40
}

layer borders {
  source: world
  | stroke-red-500 stroke-2 opacity-80
}
`,
  },

  // ── Per-Feature Styling ──

  categorical: {
    name: 'Categorical',
    description: 'Each country auto-colored by name — 20 distinct colors',
    source: `
source world {
  type: geojson
  url: "countries.geojson"
}

layer countries {
  source: world
  | fill categorical(name) stroke-slate-700 stroke-1 opacity-95
}
`,
  },

  // ── Vector Tiles ──

  vector_tiles: {
    name: 'Vector Tiles',
    description: 'Pre-tiled .xgvt format — Range Request, adaptive zoom, COG-style',
    source: `
source world {
  type: geojson
  url: "countries.xgvt"
}

layer countries {
  source: world
  | fill-emerald-700 stroke-emerald-900 stroke-1
}
`,
  },

  vector_categorical: {
    name: 'VT Categorical',
    description: 'Per-feature colors on vector tiles — PropertyTable → GPU',
    source: `
source world {
  type: geojson
  url: "countries.xgvt"
}

layer countries {
  source: world
  | fill categorical(name) stroke-slate-700 stroke-1 opacity-95
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
  const startDemo = hash && DEMOS[hash] ? hash : 'minimal'
  loadDemo(startDemo)
}

init()
