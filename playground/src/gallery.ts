// ═══ Gallery — Category Sections ═══

import { DEMOS } from './demos'

const TAG_COLORS: Record<string, string> = {
  basic: '#60a5fa',
  style: '#f59e0b',
  raster: '#34d399',
  zoom: '#a78bfa',
  layer: '#f472b6',
  'per-feature': '#22d3ee',
  xgvt: '#fb7185',
  'natural-earth': '#4ade80',
  'data-driven': '#c084fc',
  point: '#fbbf24',
  line: '#38bdf8',
  '10m': '#f472b6',
  thematic: '#fb923c',
}

const TAG_LABELS: Record<string, string> = {
  basic: 'Basic',
  style: 'Style & Filter',
  raster: 'Raster',
  zoom: 'Zoom',
  layer: 'Multi-Layer',
  'per-feature': 'Per-Feature',
  xgvt: 'Vector Tiles (XGVT)',
  'natural-earth': 'Natural Earth',
  'data-driven': 'Data-Driven',
  point: 'Points & Shapes',
  line: 'SDF Lines',
  '10m': 'High Detail (10m)',
  thematic: 'Thematic',
  fixture: 'Fixtures (isolated features)',
}

// Explicit display order so sections don't scramble when demos are
// added or renamed. Tags not listed here are appended alphabetically
// at the end. Higher-impact / beginner-facing tags come first; the
// large `fixture` bucket goes last because it's a reference corpus
// rather than a learning path.
const TAG_ORDER: string[] = [
  'basic', 'style', 'raster', 'zoom', 'layer',
  'line', 'point', 'per-feature', 'data-driven',
  'xgvt', 'natural-earth', '10m', 'thematic',
  'fixture',
]

const content = document.getElementById('content')!
const countEl = document.getElementById('demo-count')!
const searchEl = document.getElementById('search') as HTMLInputElement
const noResults = document.getElementById('no-results')!

const entries = Object.entries(DEMOS)
countEl.textContent = `${entries.length} demos`

// Group demos by tag
const groups = new Map<string, { id: string; name: string; description: string }[]>()
for (const [id, demo] of entries) {
  if (!groups.has(demo.tag)) groups.set(demo.tag, [])
  groups.get(demo.tag)!.push({ id, name: demo.name, description: demo.description })
}

// Sort within each group by display name so additions don't land in
// "whatever order demos.ts has" — the rules change as fixtures are
// added, so insertion order is not a stable sort key.
for (const list of groups.values()) {
  list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
}

// Produce an ordered [tag, demos] list that respects TAG_ORDER, with
// any unknown tags appended alphabetically so we don't silently drop
// them if someone introduces a new category.
const orderedGroups: [string, { id: string; name: string; description: string }[]][] = []
const seen = new Set<string>()
for (const tag of TAG_ORDER) {
  const list = groups.get(tag)
  if (list) { orderedGroups.push([tag, list]); seen.add(tag) }
}
const leftovers = [...groups.keys()].filter(t => !seen.has(t)).sort()
for (const tag of leftovers) orderedGroups.push([tag, groups.get(tag)!])

// Build sections
const sections: { tag: string; el: HTMLElement; items: HTMLElement[] }[] = []

for (const [tag, demos] of orderedGroups) {
  const color = TAG_COLORS[tag] ?? '#60a5fa'
  const label = TAG_LABELS[tag] ?? tag

  const section = document.createElement('section')
  section.className = 'category'
  section.dataset.tag = tag

  const header = document.createElement('div')
  header.className = 'category-header'
  header.innerHTML = `
    <span class="category-dot" style="background:${color}"></span>
    <span class="category-name">${label}</span>
    <span class="category-count">${demos.length}</span>
  `
  section.appendChild(header)

  const list = document.createElement('div')
  list.className = 'demo-list'

  const items: HTMLElement[] = []
  for (const demo of demos) {
    const a = document.createElement('a')
    a.className = 'demo-item'
    a.href = `demo.html?id=${demo.id}`
    a.dataset.search = `${demo.name} ${demo.description} ${tag} ${label}`.toLowerCase()
    a.innerHTML = `
      <span class="demo-name">${demo.name}</span>
      <span class="demo-desc">${demo.description}</span>
      <svg class="demo-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
    `
    list.appendChild(a)
    items.push(a)
  }

  section.appendChild(list)
  content.appendChild(section)
  sections.push({ tag, el: section, items })
}

// ── Search ──
searchEl.addEventListener('input', () => {
  const q = searchEl.value.toLowerCase()
  let totalVisible = 0

  for (const { el, items } of sections) {
    let sectionVisible = 0
    for (const item of items) {
      const match = !q || (item.dataset.search?.includes(q) ?? false)
      item.style.display = match ? '' : 'none'
      if (match) sectionVisible++
    }
    el.style.display = sectionVisible > 0 ? '' : 'none'
    totalVisible += sectionVisible
  }

  noResults.style.display = totalVisible === 0 ? '' : 'none'
})
