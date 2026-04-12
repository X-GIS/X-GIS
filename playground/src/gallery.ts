// ═══ Gallery ═══

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
}

const allTags = [...new Set(Object.values(DEMOS).map(d => d.tag))]
const entries = Object.entries(DEMOS)
const filterBar = document.getElementById('filter-bar')!
const grid = document.getElementById('demo-grid')!
const countEl = document.getElementById('demo-count')!

// ── Filters ──
function mkBtn(tag: string, label: string) {
  const btn = document.createElement('button')
  btn.className = 'tag-btn'
  btn.dataset.tag = tag
  btn.textContent = label
  btn.addEventListener('click', () => filterByTag(tag))
  filterBar.appendChild(btn)
  return btn
}

const allBtn = mkBtn('all', 'All')
allBtn.classList.add('active')
for (const tag of allTags) mkBtn(tag, tag)

// ── Cards ──
entries.forEach(([id, demo], i) => {
  const card = document.createElement('a')
  card.href = `demo.html?id=${id}`
  card.className = 'demo-card'
  card.dataset.tag = demo.tag
  card.style.animationDelay = `${i * 35}ms`

  const color = TAG_COLORS[demo.tag] ?? '#60a5fa'
  const lines = demo.source.trim().split('\n')
  const preview = lines.slice(0, Math.min(lines.length, 10)).join('\n')

  card.innerHTML = `
    <div class="card-header">
      <span class="card-tag" style="color:${color};border-color:${color}40;background:${color}10">${demo.tag}</span>
      <span class="card-title">${demo.name}</span>
    </div>
    <p class="card-desc">${demo.description}</p>
    <pre class="card-code"><code>${esc(preview)}</code></pre>
    <span class="card-arrow">Open demo <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg></span>
  `
  grid.appendChild(card)
})

countEl.textContent = `${entries.length} demos`

function filterByTag(tag: string) {
  document.querySelectorAll('.tag-btn').forEach(b =>
    b.classList.toggle('active', (b as HTMLElement).dataset.tag === tag),
  )
  const cards = grid.querySelectorAll('.demo-card') as NodeListOf<HTMLElement>
  let n = 0
  cards.forEach(c => {
    const match = tag === 'all' || c.dataset.tag === tag
    c.style.display = match ? '' : 'none'
    if (match) n++
  })
  countEl.textContent = tag === 'all' ? `${entries.length} demos` : `${n} of ${entries.length}`
}

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
