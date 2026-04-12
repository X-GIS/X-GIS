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
  {
    file: 'ocean-land', name: 'Ocean + Land', tag: 'natural-earth',
    description: 'Ocean and land polygons with contrasting fill colors',
    preview: `source ocean {\n  url: "ne_110m_ocean.geojson"\n}\nsource land {\n  url: "ne_110m_land.geojson"\n}\nlayer ocean { | fill-sky-900 }\nlayer land { | fill-emerald-800 }`,
  },
  {
    file: 'rivers-lakes', name: 'Rivers + Lakes', tag: 'natural-earth',
    description: 'Rivers (lines) and lakes (polygons) over countries',
    preview: `source rivers {\n  url: "ne_110m_rivers.geojson"\n}\nlayer rivers {\n  | stroke-sky-400 stroke-1\n}`,
  },
  {
    file: 'coastline', name: 'Coastline', tag: 'natural-earth',
    description: 'World coastline — line-only rendering',
    preview: `source coast {\n  url: "ne_110m_coastline.geojson"\n}\nlayer coastline {\n  | stroke-amber-400 stroke-2\n}`,
  },
  {
    file: 'physical-map', name: 'Physical Map', tag: 'natural-earth',
    description: 'Ocean + land + coastline + rivers + lakes — 5 layers',
    preview: `layer ocean { | fill-slate-900 }\nlayer land { | fill-stone-800 }\nlayer lakes { | fill-sky-800 }\nlayer rivers { | stroke-sky-700 }\nlayer coastline { | stroke-slate-500 }`,
  },
  {
    file: 'physical-map-10m', name: 'Physical Map 10m', tag: 'xgvt-10m',
    description: 'Highest detail — ocean + land + rivers + lakes (10m)',
    preview: `source ocean { url: "ne_10m_ocean.xgvt" }\nsource land { url: "ne_10m_land.xgvt" }\nsource rivers { url: "ne_10m_rivers.xgvt" }\nsource lakes { url: "ne_10m_lakes.xgvt" }`,
  },
  {
    file: 'states-10m', name: 'States 10m', tag: 'xgvt-10m',
    description: '10m admin-1 boundaries (4594 features) with categorical colors',
    preview: `source states {\n  url: "ne_10m_states.xgvt"\n}\nlayer states {\n  | fill categorical(admin)\n}`,
  },
  {
    file: 'physical-map-50m', name: 'Physical Map 50m', tag: 'xgvt',
    description: 'High-detail ocean + land + rivers + lakes (50m)',
    preview: `source ocean { url: "ne_110m_ocean.xgvt" }\nsource land { url: "ne_110m_land.xgvt" }\nsource rivers { url: "ne_50m_rivers.xgvt" }\nlayer ocean { | fill-sky-950 }\nlayer land { | fill-stone-800 }`,
  },
  {
    file: 'states-provinces', name: 'States & Provinces', tag: 'xgvt',
    description: '50m admin-1 boundaries with categorical colors',
    preview: `source states {\n  url: "ne_50m_states.xgvt"\n}\nlayer states {\n  | fill categorical(admin)\n}`,
  },
  {
    file: 'physical-map-xgvt', name: 'Physical Map (XGVT)', tag: 'xgvt',
    description: 'Land + rivers + lakes as pre-tiled vector tiles',
    preview: `source land {\n  url: "ne_110m_land.xgvt"\n}\nlayer land {\n  | fill-stone-800 stroke-slate-600\n}`,
  },
  {
    file: 'countries-categorical-xgvt', name: 'Countries 110m (XGVT)', tag: 'xgvt',
    description: 'Natural Earth 110m countries with categorical colors',
    preview: `source world {\n  url: "ne_110m_countries.xgvt"\n}\nlayer countries {\n  | fill categorical(NAME)\n}`,
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
