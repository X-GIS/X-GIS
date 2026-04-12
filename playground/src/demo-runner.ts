// ═══ Demo Runner ═══

import { XGISMap } from '@xgis/runtime'
import { DEMOS } from './demos'

const demoIds = Object.keys(DEMOS)
const params = new URLSearchParams(location.search)
let currentIdx = Math.max(0, demoIds.indexOf(params.get('id') ?? 'minimal'))
let currentMap: XGISMap | null = null

const canvas = document.getElementById('map') as HTMLCanvasElement
const status = document.getElementById('status')!
const errorDiv = document.getElementById('error')!
const errorMsg = document.getElementById('error-msg')!
const sourceEl = document.getElementById('source-code')!
const tagEl = document.getElementById('demo-tag')!
const descEl = document.getElementById('demo-desc')!
const selectEl = document.getElementById('demo-select') as HTMLSelectElement
const prevBtn = document.getElementById('prev-btn') as HTMLButtonElement
const nextBtn = document.getElementById('next-btn') as HTMLButtonElement
const sourcePanel = document.getElementById('source-panel') as HTMLDetailsElement

// ── Build selector ──
for (let i = 0; i < demoIds.length; i++) {
  const opt = document.createElement('option')
  opt.value = String(i)
  opt.textContent = DEMOS[demoIds[i]].name
  selectEl.appendChild(opt)
}

// ── Syntax highlighting (Material Ocean palette) ──
function highlight(src: string): string {
  return src
    .replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="tk-cm">$1</span>')
    .replace(/(\/\/.*$)/gm, '<span class="tk-cm">$1</span>')
    .replace(/("(?:[^"\\]|\\.)*")/g, '<span class="tk-str">$1</span>')
    .replace(/(#[0-9a-fA-F]{3,8})\b/g, '<span class="tk-num">$1</span>')
    .replace(/\b(source|layer|style|preset|let|show|fn|if|else|for|in|return|import|from|match|symbol|filter)\b/g, '<span class="tk-kw">$1</span>')
    .replace(/\b(type|url|source|style|filter|fill|stroke|stroke-width|opacity|size|visible|z-order)(?=\s*:)/g, '<span class="tk-prop">$1</span>')
    .replace(/\b(categorical|gradient|match|clamp|min|max|abs|sqrt|log|sin|cos)(?=\s*\()/g, '<span class="tk-fn">$1</span>')
    .replace(/(\|)(?!\|)/g, '<span class="tk-pipe">$1</span>')
    .replace(/(==|!=|&lt;=|&gt;=|&lt;|&gt;|&amp;&amp;|\|\||->)/g, '<span class="tk-op">$1</span>')
    .replace(/(\.[A-Z_][A-Z_0-9]*)\b/g, '<span class="tk-field">$1</span>')
    .replace(/\b(\d+\.?\d*)\b/g, '<span class="tk-num">$1</span>')
    .replace(/(?<=fill-|stroke-|bg-)((?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)(?:-\d+)?)/g, '<span class="tk-color">$1</span>')
    .replace(/(?<=:\s*)((?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)(?:-\d+)?)\b/g, '<span class="tk-color">$1</span>')
}

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ── Load demo ──
async function loadDemo(idx: number) {
  currentIdx = idx
  const id = demoIds[idx]
  const demo = DEMOS[id]

  document.title = `${demo.name} — X-GIS`
  tagEl.textContent = demo.tag
  descEl.textContent = demo.description
  selectEl.value = String(idx)
  prevBtn.disabled = idx === 0
  nextBtn.disabled = idx === demoIds.length - 1

  sourceEl.innerHTML = highlight(esc(demo.source.trim()))
  history.replaceState(null, '', `demo.html?id=${id}`)

  errorDiv.style.display = 'none'
  currentMap?.stop()

  try {
    status.textContent = `Loading ${demo.name}...`
    status.style.opacity = '1'

    currentMap = new XGISMap(canvas)
    await currentMap.run(demo.source, '/data/')

    status.textContent = `${demo.name} · scroll to zoom, drag to pan`
    setTimeout(() => { status.style.opacity = '0.4' }, 3000)
  } catch (err) {
    console.error('[X-GIS]', err)
    errorDiv.style.display = 'block'
    errorMsg.textContent = String(err)
    status.textContent = 'Error'
  }
}

// ── Navigation ──
prevBtn.addEventListener('click', () => { if (currentIdx > 0) loadDemo(currentIdx - 1) })
nextBtn.addEventListener('click', () => { if (currentIdx < demoIds.length - 1) loadDemo(currentIdx + 1) })
selectEl.addEventListener('change', () => { loadDemo(parseInt(selectEl.value)) })

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLSelectElement) return
  if (e.key === 'ArrowLeft' && currentIdx > 0) { e.preventDefault(); loadDemo(currentIdx - 1) }
  else if (e.key === 'ArrowRight' && currentIdx < demoIds.length - 1) { e.preventDefault(); loadDemo(currentIdx + 1) }
  else if (e.key === 's' || e.key === 'S') { sourcePanel.open = !sourcePanel.open }
})

loadDemo(currentIdx)
