// ═══ Gallery ═══

interface Example {
  file: string
  name: string
  tag: string
  description: string
  preview: string
}

const EXAMPLES: Example[] = [
  {
    file: 'minimal', name: 'Minimal', tag: 'basic',
    description: 'One source, one layer — the simplest X-GIS program',
    preview: `source world {\n  type: geojson\n  url: "countries.geojson"\n}\n\nlayer countries {\n  source: world\n  | fill-stone-200 stroke-stone-400 stroke-1\n}`,
  },
  {
    file: 'dark', name: 'Dark Theme', tag: 'basic',
    description: 'Dark fill with bright cyan borders',
    preview: `layer countries {\n  source: world\n  | fill-slate-800 stroke-cyan-400 stroke-1 opacity-95\n}`,
  },
  {
    file: 'raster', name: 'Raster + Borders', tag: 'raster',
    description: 'OSM tiles with translucent country borders',
    preview: `source basemap {\n  type: raster\n  url: "https://tile.openstreetmap.org/..."\n}\n\nlayer borders {\n  | fill-blue-500 opacity-20 stroke-white\n}`,
  },
  {
    file: 'zoom', name: 'Zoom Styles', tag: 'zoom',
    description: 'Opacity changes by zoom level — zoom in and out to see',
    preview: `| fill-purple-400 stroke-purple-200 stroke-1\n| z2:opacity-30 z5:opacity-60 z8:opacity-90`,
  },
  {
    file: 'multi-layer', name: 'Multi-Layer', tag: 'layer',
    description: 'Two layers from the same source with different styles',
    preview: `layer fill {\n  | fill-orange-200 opacity-40\n}\n\nlayer borders {\n  | stroke-red-500 stroke-2 opacity-80\n}`,
  },
  {
    file: 'categorical', name: 'Categorical Colors', tag: 'per-feature',
    description: 'Each country auto-colored by name — GPU categorical palette',
    preview: `layer countries {\n  source: world\n  | fill categorical(name)\n  | stroke-slate-700 stroke-1 opacity-95\n}`,
  },
  {
    file: 'vector-tiles', name: 'Vector Tiles', tag: 'xgvt',
    description: 'Pre-tiled .xgvt format with adaptive zoom',
    preview: `source world {\n  type: geojson\n  url: "countries.xgvt"\n}\n\nlayer countries {\n  | fill-emerald-700 stroke-emerald-900\n}`,
  },
  {
    file: 'vector-categorical', name: 'VT + Categorical', tag: 'xgvt',
    description: 'Per-feature categorical colors on vector tiles',
    preview: `source world {\n  url: "countries.xgvt"\n}\n\nlayer countries {\n  | fill categorical(name)\n}`,
  },
]

const grid = document.getElementById('demo-grid')!

for (const ex of EXAMPLES) {
  const card = document.createElement('a')
  card.href = `/examples/${ex.file}.html`
  card.className = 'demo-card'
  card.innerHTML = `
    <span class="tag">${ex.tag}</span>
    <h3>${ex.name}</h3>
    <p>${ex.description}</p>
    <pre><code>${escapeHtml(ex.preview)}</code></pre>
  `
  grid.appendChild(card)
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
