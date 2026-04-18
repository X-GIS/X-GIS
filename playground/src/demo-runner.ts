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

// ── In-page log overlay (mobile-friendly error reporting) ──
// Captures console.error / console.warn / window.error / unhandledrejection
// and any [WebGPU validation] messages routed by the runtime's
// uncapturederror handler. Shown as a collapsible badge pinned to the
// bottom-right of the screen so you can read errors on phones without
// needing chrome://inspect or remote debugging.
;(() => {
  const ENTRIES: { kind: 'error' | 'warn' | 'log'; ts: number; msg: string }[] = []
  const MAX = 200

  const wrap = document.createElement('div')
  wrap.id = 'log-overlay'
  wrap.style.cssText = [
    'position:fixed', 'right:8px', 'bottom:8px', 'z-index:2000',
    'max-width:min(96vw,520px)', 'max-height:60vh',
    'font:11px/1.4 "DM Mono",monospace', 'color:#dde',
    'background:rgba(10,12,20,0.92)', 'backdrop-filter:blur(6px)',
    'border:1px solid rgba(255,255,255,0.18)', 'border-radius:6px',
    'display:none', 'flex-direction:column', 'overflow:hidden',
  ].join(';')

  const header = document.createElement('div')
  header.style.cssText = 'display:flex;gap:8px;align-items:center;padding:6px 10px;background:rgba(255,80,80,0.18);cursor:pointer;user-select:none'
  header.innerHTML = '<strong style="flex:1">⚠ Errors</strong><span id="log-count">0</span><button id="log-safe" style="font:inherit;padding:2px 8px;border:1px solid #555;background:#222;color:#dde;border-radius:4px;cursor:pointer">Safe</button><button id="log-copy" style="font:inherit;padding:2px 8px;border:1px solid #555;background:#222;color:#dde;border-radius:4px;cursor:pointer">Copy</button><button id="log-clear" style="font:inherit;padding:2px 8px;border:1px solid #555;background:#222;color:#dde;border-radius:4px;cursor:pointer">×</button>'
  wrap.appendChild(header)

  const body = document.createElement('div')
  body.id = 'log-body'
  body.style.cssText = 'overflow-y:auto;padding:8px 10px;white-space:pre-wrap;word-break:break-word;flex:1'
  wrap.appendChild(body)

  document.body.appendChild(wrap)

  const fmtRow = (e: { kind: string; ts: number; msg: string }) => {
    const t = new Date(e.ts).toLocaleTimeString()
    const tag = e.kind === 'error' ? '🛑' : e.kind === 'warn' ? '⚠️' : '·'
    return `[${t}] ${tag} ${e.msg}`
  }
  const repaint = () => {
    body.textContent = ENTRIES.map(fmtRow).join('\n\n')
    body.scrollTop = body.scrollHeight
    ;(document.getElementById('log-count') as HTMLElement).textContent = String(ENTRIES.length)
    wrap.style.display = ENTRIES.length > 0 ? 'flex' : 'none'
  }
  // Benign third-party noise we don't want cluttering the mobile overlay.
  // Monaco's GlobalTouchMoveMonitor logs "end/move of an UNKNOWN touch"
  // whenever iOS dispatches touch events it didn't see the start for —
  // a Monaco-internal bookkeeping warning that is not actionable for us.
  const NOISE_RE = /UNKNOWN touch/
  const push = (kind: 'error' | 'warn' | 'log', ...args: unknown[]) => {
    const msg = args.map(a => {
      if (a instanceof Error) return a.stack || a.message
      if (typeof a === 'object') { try { return JSON.stringify(a) } catch { return String(a) } }
      return String(a)
    }).join(' ')
    if (NOISE_RE.test(msg)) return
    ENTRIES.push({ kind, ts: Date.now(), msg })
    if (ENTRIES.length > MAX) ENTRIES.splice(0, ENTRIES.length - MAX)
    repaint()
  }

  // Hook console
  const origError = console.error.bind(console)
  const origWarn  = console.warn.bind(console)
  console.error = (...args: unknown[]) => { push('error', ...args); origError(...args) }
  console.warn  = (...args: unknown[]) => { push('warn',  ...args); origWarn(...args) }

  // Hook window errors + unhandled promise rejections.
  // iOS WebKit replaces e.message with "Script error." for cross-origin
  // scripts, but e.error is sometimes a real Error instance with stack —
  // log everything so we don't lose context.
  window.addEventListener('error', (e) => {
    const parts: string[] = []
    if (e.message && e.message !== 'Script error.') parts.push(e.message)
    if (e.error) {
      const err = e.error as Error
      parts.push(err.stack || err.message || String(err))
    }
    if (e.filename) parts.push(`@ ${e.filename}:${e.lineno}:${e.colno}`)
    if (parts.length === 0) parts.push('(opaque cross-origin error — try `taskkill /PID port:3001` and reload via localhost)')
    push('error', parts.join('\n'))
  })
  window.addEventListener('unhandledrejection', (e) => {
    const r = (e as PromiseRejectionEvent).reason
    if (r instanceof Error) push('error', 'Unhandled promise rejection:\n' + (r.stack || r.message))
    else push('error', 'Unhandled promise rejection:', r)
  })

  // Header actions
  let collapsed = false
  header.addEventListener('click', (e) => {
    const id = (e.target as HTMLElement).id
    if (id === 'log-copy' || id === 'log-clear' || id === 'log-safe') return
    collapsed = !collapsed
    body.style.display = collapsed ? 'none' : 'block'
  })
  document.getElementById('log-safe')!.addEventListener('click', () => {
    // Toggle ?safe=1 on the URL and reload — disables MSAA + translucent
    // offscreen path so the user can bisect rendering bugs.
    const url = new URL(location.href)
    if (url.searchParams.get('safe') === '1') url.searchParams.delete('safe')
    else url.searchParams.set('safe', '1')
    location.href = url.toString()
  })
  document.getElementById('log-copy')!.addEventListener('click', async () => {
    const text = ENTRIES.map(fmtRow).join('\n\n') + '\n\n--\n' + location.href + '\n' + navigator.userAgent
    try {
      await navigator.clipboard.writeText(text)
      const btn = document.getElementById('log-copy')! as HTMLButtonElement
      const orig = btn.textContent
      btn.textContent = 'Copied'
      setTimeout(() => { btn.textContent = orig }, 1200)
    } catch { /* clipboard might be blocked over plain http */ }
  })
  document.getElementById('log-clear')!.addEventListener('click', () => {
    ENTRIES.length = 0
    repaint()
  })

  // Expose for runtime hooks
  ;(window as unknown as { __xgisLog: typeof push }).__xgisLog = push
})()

// ── iOS opaque-error mitigation: wrap async callback primitives so any
// thrown error is captured in SAME-origin context (preserving .stack)
// before it can reach window.onerror, where iOS WebKit would strip it to
// "Script error." because the dev server is a self-signed LAN IP. Without
// this, errors from rAF / timer / event-listener callbacks surface as the
// opaque "(opaque cross-origin error)" fallback and we lose the stack.
;(() => {
  type LogFn = (k: 'error' | 'warn' | 'log', ...a: unknown[]) => void
  const log = (label: string, err: unknown) => {
    const stack = err instanceof Error ? (err.stack || err.message) : String(err)
    const push = (window as unknown as { __xgisLog?: LogFn }).__xgisLog
    if (push) push('error', `[async ${label}]`, stack)
    else console.error(`[async ${label}]`, stack)
  }
  const wrap = <F extends (...a: never[]) => unknown>(label: string, fn: F): F =>
    ((...args: never[]) => {
      try { return fn(...args) }
      catch (e) { log(label, e); throw e }
    }) as F

  // requestAnimationFrame
  const rafOrig = window.requestAnimationFrame.bind(window)
  window.requestAnimationFrame = (cb: FrameRequestCallback) =>
    rafOrig(wrap('rAF', cb as never) as FrameRequestCallback)

  // setTimeout / setInterval (only wrap function callbacks, not string eval)
  const stOrig = window.setTimeout
  window.setTimeout = ((cb: TimerHandler, ms?: number, ...rest: unknown[]) =>
    typeof cb === 'function'
      ? stOrig(wrap('setTimeout', cb as never) as TimerHandler, ms, ...rest)
      : stOrig(cb, ms, ...rest)
  ) as typeof window.setTimeout
  const siOrig = window.setInterval
  window.setInterval = ((cb: TimerHandler, ms?: number, ...rest: unknown[]) =>
    typeof cb === 'function'
      ? siOrig(wrap('setInterval', cb as never) as TimerHandler, ms, ...rest)
      : siOrig(cb, ms, ...rest)
  ) as typeof window.setInterval

  // queueMicrotask
  if (typeof window.queueMicrotask === 'function') {
    const qmtOrig = window.queueMicrotask.bind(window)
    window.queueMicrotask = (cb: VoidFunction) => qmtOrig(wrap('microtask', cb as never) as VoidFunction)
  }

  // addEventListener — skip self-referential error/unhandledrejection
  // listeners (would recurse on throw). Track wrapped fn via WeakMap so
  // removeEventListener(fn) still finds the right entry.
  const wrappedMap = new WeakMap<object, EventListener>()
  const addOrig = EventTarget.prototype.addEventListener
  const removeOrig = EventTarget.prototype.removeEventListener
  EventTarget.prototype.addEventListener = function (type, listener, opts) {
    if (typeof listener === 'function' && type !== 'error' && type !== 'unhandledrejection') {
      let w = wrappedMap.get(listener as unknown as object)
      if (!w) {
        w = wrap(`evt:${type}`, listener as never) as EventListener
        wrappedMap.set(listener as unknown as object, w)
      }
      return addOrig.call(this, type, w, opts)
    }
    return addOrig.call(this, type, listener, opts)
  }
  EventTarget.prototype.removeEventListener = function (type, listener, opts) {
    if (typeof listener === 'function') {
      const w = wrappedMap.get(listener as unknown as object)
      if (w) return removeOrig.call(this, type, w, opts)
    }
    return removeOrig.call(this, type, listener, opts)
  }
})()

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
// Group by tag via <optgroup> so the 100+ entry dropdown is browseable
// instead of an unsorted wall. Tag order mirrors the gallery page's
// TAG_ORDER; options inside each group sort alphabetically by name.
// The `<option value>` still carries the `demoIds` index, so the
// existing `selectEl.value = String(idx)` path keeps working.
const TAG_ORDER_DROPDOWN: string[] = [
  'basic', 'style', 'raster', 'zoom', 'layer',
  'line', 'point', 'per-feature', 'data-driven',
  'xgvt', 'natural-earth', '10m', 'thematic',
  'fixture',
]
const TAG_LABELS_DROPDOWN: Record<string, string> = {
  basic: 'Basic', style: 'Style & Filter', raster: 'Raster',
  zoom: 'Zoom', layer: 'Multi-Layer', 'per-feature': 'Per-Feature',
  xgvt: 'Vector Tiles (XGVT)', 'natural-earth': 'Natural Earth',
  'data-driven': 'Data-Driven', point: 'Points & Shapes',
  line: 'SDF Lines', '10m': 'High Detail (10m)',
  thematic: 'Thematic', fixture: 'Fixtures',
}
{
  const byTag = new Map<string, { idx: number; name: string }[]>()
  for (let i = 0; i < demoIds.length; i++) {
    const d = DEMOS[demoIds[i]]
    const list = byTag.get(d.tag) ?? []
    list.push({ idx: i, name: d.name })
    byTag.set(d.tag, list)
  }
  const seen = new Set<string>()
  const addGroup = (tag: string): void => {
    const list = byTag.get(tag)
    if (!list || seen.has(tag)) return
    seen.add(tag)
    list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    const og = document.createElement('optgroup')
    og.label = TAG_LABELS_DROPDOWN[tag] ?? tag
    for (const { idx, name } of list) {
      const opt = document.createElement('option')
      opt.value = String(idx)
      opt.textContent = name
      og.appendChild(opt)
    }
    selectEl.appendChild(og)
  }
  for (const tag of TAG_ORDER_DROPDOWN) addGroup(tag)
  for (const tag of [...byTag.keys()].filter(t => !seen.has(t)).sort()) addGroup(tag)
}

// ── URL hash sync (MapLibre style: #zoom/lat/lon/bearing/pitch) ──
const R_EARTH = 6378137
const DEG = 180 / Math.PI
const RAD = Math.PI / 180

function parseHash(): { zoom: number; lat: number; lon: number; bearing: number; pitch: number } | null {
  const h = location.hash.replace(/^#/, '')
  if (!h) return null
  const parts = h.split('/').map(parseFloat)
  if (parts.length < 3 || parts.some(Number.isNaN)) return null
  const [zoom, lat, lon, bearing = 0, pitch = 0] = parts
  return { zoom, lat, lon, bearing, pitch }
}

function applyHashToCamera(map: XGISMap): void {
  const h = parseHash()
  if (!h) return
  const cam = map.getCamera()
  // Respect the camera's maxZoom cap (set by Map based on source.maxLevel)
  // so hash URLs like #22.0/... don't jam us into a precision-lossy state
  // on low-detail sources.
  cam.zoom = Math.max(0, Math.min(cam.maxZoom, h.zoom))
  cam.centerX = h.lon * RAD * R_EARTH
  const clampLat = Math.max(-85.051129, Math.min(85.051129, h.lat))
  cam.centerY = Math.log(Math.tan(Math.PI / 4 + clampLat * RAD / 2)) * R_EARTH
  cam.bearing = h.bearing
  cam.pitch = h.pitch
}

function formatHash(map: XGISMap): string {
  const cam = map.getCamera()
  const lon = (cam.centerX / R_EARTH) * DEG
  const lat = (2 * Math.atan(Math.exp(cam.centerY / R_EARTH)) - Math.PI / 2) * DEG
  const z = cam.zoom.toFixed(2)
  const la = lat.toFixed(5)
  const lo = lon.toFixed(5)
  const b = cam.bearing.toFixed(1)
  const p = cam.pitch.toFixed(1)
  const tail = (cam.bearing || cam.pitch) ? `/${b}/${p}` : ''
  return `#${z}/${la}/${lo}${tail}`
}

let hashSyncRaf = 0
let lastHash = ''
let lastHashWriteMs = 0
// iOS Safari throttles history.replaceState to 100 calls per 10 seconds and
// throws SecurityError past that. Writing every rAF (~60Hz) during a pan
// tripped the limit instantly, so we rate-limit writes to ~5Hz. The badge
// readout (updateHashBadge) still updates every frame; only the URL mutation
// is throttled.
const HASH_WRITE_INTERVAL_MS = 200
function startHashSync(map: XGISMap): void {
  cancelAnimationFrame(hashSyncRaf)
  const tick = () => {
    const h = formatHash(map)
    if (h !== lastHash) {
      const now = performance.now()
      if (now - lastHashWriteMs >= HASH_WRITE_INTERVAL_MS) {
        lastHash = h
        lastHashWriteMs = now
        // replaceState instead of location.hash = — avoids triggering hashchange
        history.replaceState(null, '', location.pathname + location.search + h)
      }
    }
    hashSyncRaf = requestAnimationFrame(tick)
  }
  hashSyncRaf = requestAnimationFrame(tick)
}

// Live hash readout pinned to the top-right of the canvas for quick copy/paste.
const hashBadge = document.createElement('div')
hashBadge.id = 'hash-badge'
hashBadge.title = 'Click to copy map state (zoom/lat/lon/bearing/pitch)'
hashBadge.style.cssText = [
  'position:fixed', 'top:12px', 'right:12px', 'z-index:1000',
  'font:11px/1.4 "DM Mono",monospace', 'color:#dde',
  'background:rgba(10,12,20,0.75)', 'backdrop-filter:blur(6px)',
  'padding:6px 10px', 'border:1px solid rgba(255,255,255,0.12)',
  'border-radius:6px', 'cursor:pointer', 'user-select:all',
].join(';')
document.body.appendChild(hashBadge)
hashBadge.addEventListener('click', () => {
  navigator.clipboard?.writeText(location.href).then(() => {
    hashBadge.style.color = '#8f8'
    setTimeout(() => { hashBadge.style.color = '#dde' }, 600)
  })
})

function updateHashBadge(): void {
  if (!currentMap) return
  hashBadge.textContent = formatHash(currentMap)
  requestAnimationFrame(updateHashBadge)
}

window.addEventListener('hashchange', () => {
  if (currentMap) applyHashToCamera(currentMap)
})

// ── Run source code ──
async function runSource(source: string, label: string) {
  errorDiv.style.display = 'none'
  currentMap?.stop()

  try {
    status.textContent = `Loading ${label}...`
    status.style.opacity = '1'

    currentMap = new XGISMap(canvas)
    // Debug hook — Playwright tests + DevTools console can poke at
    // map._elapsedMs, map.vectorTileShows, etc. without re-wiring the
    // demo runner. Keep it lightweight; not part of the public API.
    ;(window as unknown as { __xgisMap?: unknown }).__xgisMap = currentMap
    await currentMap.run(source, import.meta.env.BASE_URL + 'data/')

    // Apply pre-existing hash AFTER data is loaded (so bounds-fit ran first).
    applyHashToCamera(currentMap)
    startHashSync(currentMap)
    updateHashBadge()

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
  history.replaceState(null, '', `demo.html?id=${id}${location.hash}`)

  // Discover fields from GeoJSON URLs in source (async, non-blocking)
  discoverFields(demo.source, import.meta.env.BASE_URL + 'data/')

  await runSource(demo.source, demo.name)

  // Post-run hook: inline-source fixtures need the host to push
  // data — without this, gallery visitors see an empty canvas.
  // E2E tests that drive these fixtures themselves pass `?e2e=1`
  // to opt out so the test controls the push cadence.
  if (currentMap && !params.has('e2e')) {
    applyFixtureAutoPush(id, currentMap)
  }
}

/** Auto-inject sample data for inline-source fixtures so they
 *  render something when opened manually from the gallery. */
function applyFixtureAutoPush(id: string, map: InstanceType<typeof XGISMap>): void {
  if (id === 'fixture_inline_push') {
    map.setSourceData('tracks', {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', id: 1, geometry: { type: 'Point', coordinates: [-30, 0] },  properties: {} },
        { type: 'Feature', id: 2, geometry: { type: 'Point', coordinates: [0, 0] },    properties: {} },
        { type: 'Feature', id: 3, geometry: { type: 'Point', coordinates: [30, 0] },   properties: {} },
        { type: 'Feature', id: 4, geometry: { type: 'Point', coordinates: [0, 30] },   properties: {} },
        { type: 'Feature', id: 5, geometry: { type: 'Point', coordinates: [0, -30] },  properties: {} },
      ],
    })
  } else if (id === 'fixture_typed_array_points') {
    map.setSourcePoints('tracks', {
      lon: new Float32Array([-40, -20, 0, 20, 40]),
      lat: new Float32Array([-20, 20, -20, 20, -20]),
      ids: new Uint32Array([201, 202, 203, 204, 205]),
    })
  }
}

// ── Run button ──
runBtn.addEventListener('click', () => {
  const src = editor.getValue()
  discoverFields(src, import.meta.env.BASE_URL + 'data/')
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
