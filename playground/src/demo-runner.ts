// ═══ Demo Runner — Monaco Editor ═══

import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'

import { XGISMap } from '@xgis/runtime'
import { DEMOS } from './demos'
import { registerXGISLanguage, registerXGISTheme, validateSource, discoverFields } from './monaco-xgis'

// Monaco web worker setup
self.MonacoEnvironment = {
  getWorker: () => new editorWorker(),
}

const demoIds = Object.keys(DEMOS)
const params = new URLSearchParams(location.search)
let currentIdx = Math.max(0, demoIds.indexOf(params.get('id') ?? 'minimal'))
let currentMap: XGISMap | null = null

const canvas = document.getElementById('map') as HTMLCanvasElement
const status = document.getElementById('status')!
const errorDiv = document.getElementById('error')!
const errorMsg = document.getElementById('error-msg')!
const runBtn = document.getElementById('run-btn') as HTMLButtonElement
const tagEl = document.getElementById('demo-tag')!
const selectEl = document.getElementById('demo-select') as HTMLSelectElement
const prevBtn = document.getElementById('prev-btn') as HTMLButtonElement
const nextBtn = document.getElementById('next-btn') as HTMLButtonElement
const editorPane = document.getElementById('editor-pane')!
const resizeHandle = document.getElementById('resize-handle')!
const monacoContainer = document.getElementById('monaco-container')!

// ── Register language + theme ──
registerXGISLanguage()
registerXGISTheme()

// ── Create Monaco Editor ──
const editor = monaco.editor.create(monacoContainer, {
  language: 'xgis',
  theme: 'xgis-dark',
  value: '',
  fontSize: 12,
  lineHeight: 22,
  fontFamily: "'DM Mono', 'Fira Code', monospace",
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  renderLineHighlight: 'line',
  padding: { top: 8, bottom: 8 },
  lineNumbers: 'on',
  lineNumbersMinChars: 3,
  glyphMargin: false,
  folding: true,
  tabSize: 2,
  insertSpaces: true,
  automaticLayout: true,
  suggestOnTriggerCharacters: true,
  quickSuggestions: true,
  wordBasedSuggestions: 'off',
  overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true,
  fixedOverflowWidgets: true,
  scrollbar: {
    verticalScrollbarSize: 6,
    horizontalScrollbarSize: 6,
  },
})

// ── Real-time validation (debounced) ──
let validateTimer: ReturnType<typeof setTimeout> | null = null
editor.onDidChangeModelContent(() => {
  if (validateTimer) clearTimeout(validateTimer)
  validateTimer = setTimeout(() => {
    validateSource(editor.getModel()!)
  }, 300)
})

// ── Ctrl+Enter to Run ──
editor.addAction({
  id: 'xgis-run',
  label: 'Run X-GIS Source',
  keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
  run: () => runSource(editor.getValue(), 'Custom'),
})

// ── Build selector ──
for (let i = 0; i < demoIds.length; i++) {
  const opt = document.createElement('option')
  opt.value = String(i)
  opt.textContent = DEMOS[demoIds[i]].name
  selectEl.appendChild(opt)
}

// ── Run source code ──
async function runSource(source: string, label: string) {
  errorDiv.style.display = 'none'
  currentMap?.stop()

  try {
    status.textContent = `Loading ${label}...`
    status.style.opacity = '1'

    currentMap = new XGISMap(canvas)
    await currentMap.run(source, '/data/')

    status.textContent = `${label} · scroll to zoom, drag to pan`
    setTimeout(() => { status.style.opacity = '0.4' }, 3000)
  } catch (err) {
    console.error('[X-GIS]', err)
    errorDiv.style.display = 'block'
    errorMsg.textContent = String(err)
    status.textContent = 'Error'
  }
}

// ── Load demo ──
async function loadDemo(idx: number) {
  currentIdx = idx
  const id = demoIds[idx]
  const demo = DEMOS[id]

  document.title = `${demo.name} — X-GIS`
  tagEl.textContent = demo.tag
  selectEl.value = String(idx)
  prevBtn.disabled = idx === 0
  nextBtn.disabled = idx === demoIds.length - 1

  editor.setValue(demo.source.trim())
  history.replaceState(null, '', `demo.html?id=${id}`)

  // Discover fields from GeoJSON URLs in source (async, non-blocking)
  discoverFields(demo.source, '/data/')

  await runSource(demo.source, demo.name)
}

// ── Run button ──
runBtn.addEventListener('click', () => {
  const src = editor.getValue()
  discoverFields(src, '/data/')
  runSource(src, 'Custom')
})

// ── Navigation ──
prevBtn.addEventListener('click', () => { if (currentIdx > 0) loadDemo(currentIdx - 1) })
nextBtn.addEventListener('click', () => { if (currentIdx < demoIds.length - 1) loadDemo(currentIdx + 1) })
selectEl.addEventListener('change', () => loadDemo(parseInt(selectEl.value)))

document.addEventListener('keydown', (e) => {
  if (monacoContainer.contains(e.target as Node) || e.target instanceof HTMLSelectElement) return
  if (e.key === 'ArrowLeft' && currentIdx > 0) { e.preventDefault(); loadDemo(currentIdx - 1) }
  else if (e.key === 'ArrowRight' && currentIdx < demoIds.length - 1) { e.preventDefault(); loadDemo(currentIdx + 1) }
})

// ── Resize handle ──
let resizing = false
resizeHandle.addEventListener('pointerdown', (e) => {
  resizing = true
  resizeHandle.classList.add('active')
  resizeHandle.setPointerCapture(e.pointerId)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
})
document.addEventListener('pointermove', (e) => {
  if (!resizing) return
  const width = window.innerWidth - e.clientX
  editorPane.style.width = `${Math.max(280, Math.min(window.innerWidth * 0.6, width))}px`
})
document.addEventListener('pointerup', () => {
  if (!resizing) return
  resizing = false
  resizeHandle.classList.remove('active')
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
})

// ── Init ──
loadDemo(currentIdx)
