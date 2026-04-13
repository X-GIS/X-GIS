// ═══ Demo Runner ═══

import { XGISMap } from '@xgis/runtime'
import { DEMOS } from './demos'
import { createHighlighter, type Highlighter } from 'shiki'
import xgisGrammar from '../../vscode-xgis/syntaxes/xgis.tmLanguage.json'

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

// ── Syntax highlighting via Shiki + xgis TextMate grammar ──
let highlighter: Highlighter | null = null

async function initHighlighter() {
  try {
    highlighter = await createHighlighter({
      themes: ['material-theme-ocean'],
      langs: [{ ...xgisGrammar as any, name: 'xgis' }],
    })
  } catch (e) {
    console.warn('[X-GIS] Shiki init failed, using plain text:', e)
  }
}

function highlightCode(src: string): string {
  if (!highlighter) {
    return src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
  return highlighter.codeToHtml(src, { lang: 'xgis', theme: 'material-theme-ocean' })
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

  sourceEl.innerHTML = highlightCode(demo.source.trim())
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

// Init: load highlighter async, then show demo
initHighlighter().then(() => {
  // Re-highlight current demo once Shiki is ready
  const demo = DEMOS[demoIds[currentIdx]]
  if (demo) sourceEl.innerHTML = highlightCode(demo.source.trim())
})

loadDemo(currentIdx)
