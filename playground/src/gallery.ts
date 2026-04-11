// ═══ Gallery ═══

import { DEMOS } from './demos'

const grid = document.getElementById('demo-grid')!

for (const [id, demo] of Object.entries(DEMOS)) {
  const lines = demo.source.trim().split('\n')
  const preview = lines.slice(0, 8).join('\n') + (lines.length > 8 ? '\n...' : '')

  const card = document.createElement('a')
  card.href = `/demo.html?id=${id}`
  card.className = 'demo-card'
  card.innerHTML = `
    <span class="tag">${demo.tag}</span>
    <h3>${demo.name}</h3>
    <p>${demo.description}</p>
    <pre><code>${escapeHtml(preview)}</code></pre>
  `
  grid.appendChild(card)
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
