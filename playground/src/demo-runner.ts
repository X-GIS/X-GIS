// ═══ Demo Runner — Monaco Editor ═══

import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

import { XGISMap, lonLatToMercator } from '@xgis/runtime'
import { SCENE_BUILDER_TWINS } from '@xgis/compiler/builder/twin-corpus'
// Raw text of the SAME module — the JS tab (#1194 A3b) extracts each twin's
// construction from it, so the displayed code IS the code the parity gate
// pins (single authority; survives minification, unlike Function.toString).
import twinCorpusRaw from '@xgis/compiler/builder/twin-corpus?raw'
import { DEMOS } from './demos'
import { extractMapboxProjectionName, extractMapboxLight } from './mapbox-projection'
import {
  registerXGISLanguage,
  registerXGISTheme,
  validateSource,
  discoverFields,
} from './monaco-xgis'

// Monaco web worker setup. The ts worker exists for the JS tab's
// 'typescript' models (#1194 A3b) — without it the typescript contribution
// routes inlay-hint/outline requests to the generic worker, which throws
// "Missing requestHandler". Vite splits it into its own chunk, fetched only
// when the first typescript model is created.
self.MonacoEnvironment = {
  getWorker: (_id: string, label: string) =>
    label === 'typescript' || label === 'javascript' ? new tsWorker() : new editorWorker(),
}

const demoIds = Object.keys(DEMOS)
const params = new URLSearchParams(location.search)
let currentIdx = Math.max(0, demoIds.indexOf(params.get('id') ?? 'minimal'))
let currentMap: XGISMap | null = null

// Module-scope sprite / glyphs URL stash for the Mapbox-import flows
// (`__xgisImportMapbox` direct call AND `__xgisImportSource` session-
// Storage / hash channel from the site /convert page). The XGISMap
// constructor inside runSource consumes them so the IconStage's
// first-frame construction gate sees a non-null URL. Iter 105 +
// the convert-page sprite/glyphs path fix.
let pendingSpriteUrl: string | null = null
let pendingGlyphsUrl: string | null = null

// `let` — replaced with a fresh node on backend switch: a canvas's drawing-
// context type is STICKY once acquired (a WebGPU canvas can never open a
// webgl2 context and vice versa), so toggling backends needs a virgin canvas.
let canvas = document.getElementById('map') as HTMLCanvasElement
function replaceMapCanvas(): void {
  const fresh = canvas.cloneNode(false) as HTMLCanvasElement // attrs only, no context
  canvas.replaceWith(fresh)
  canvas = fresh
}
const status = document.getElementById('status')!
const statusMain = document.getElementById('status-main')!
const statusDescEl = document.getElementById('status-desc') as HTMLButtonElement | null
const statusPopoverEl = document.getElementById('status-popover')!
const errorDiv = document.getElementById('error')!
const errorMsg = document.getElementById('error-msg')!
const runBtn = document.getElementById('run-btn') as HTMLButtonElement
const tagEl = document.getElementById('demo-tag')!
const selectEl = document.getElementById('demo-select') as HTMLSelectElement
const projSelectEl = document.getElementById('proj-select') as HTMLSelectElement
const backendSelectEl = document.getElementById('backend-select') as HTMLSelectElement
const backendTagEl = document.getElementById('backend-tag') as HTMLSpanElement
const prevBtn = document.getElementById('prev-btn') as HTMLButtonElement
const nextBtn = document.getElementById('next-btn') as HTMLButtonElement
const editorPane = document.getElementById('editor-pane')!
const resizeHandle = document.getElementById('resize-handle')!
const monacoContainer = document.getElementById('monaco-container')!
const editorToggle = document.getElementById('editor-toggle') as HTMLButtonElement | null

// ── Mobile editor toggle ──
// On touch-primary devices (`pointer: coarse` or width ≤ 740px) the
// editor pane is collapsed by default — the source view is hidden and
// the map gets the whole viewport. Tapping the gear icon expands the
// editor pane to read/edit the source; tapping again collapses back.
// Desktop callers never see the button (CSS .mobile-only hides it).
if (editorToggle) {
  editorToggle.addEventListener('click', () => {
    const expanded = editorPane.classList.toggle('expanded')
    editorToggle.setAttribute('aria-label', expanded ? 'Hide source' : 'Show source')
    editorToggle.title = expanded ? 'Hide source' : 'Show source'
  })
}

// ── Desktop editor collapse ──
// On desktop the editor is always visible, so the .mobile-only gear
// toggle above never shows. This slim chevron tab (pinned to the map's
// right edge) collapses the editor pane to zero width for a map-first
// view and restores it — the state is persisted in localStorage. The
// collapse is a `.collapsed` class on #editor-pane that drives width→0;
// the map's ResizeObserver reacts exactly as it does to a handle drag.
{
  const collapseBtn = document.getElementById('editor-collapse-btn') as HTMLButtonElement | null
  if (collapseBtn) {
    const KEY = 'demo.editorCollapsed'
    const apply = (collapsed: boolean): void => {
      editorPane.classList.toggle('collapsed', collapsed)
      collapseBtn.classList.toggle('collapsed', collapsed)
      const label = collapsed ? 'Show editor' : 'Collapse editor'
      collapseBtn.title = label
      collapseBtn.setAttribute('aria-label', label)
    }
    apply(localStorage.getItem(KEY) === '1')
    collapseBtn.addEventListener('click', () => {
      const collapsed = !editorPane.classList.contains('collapsed')
      apply(collapsed)
      localStorage.setItem(KEY, collapsed ? '1' : '0')
    })
  }
}

// ── Map tool buttons: snapshot + copy-link ──
// Both share the same confirmation-flash idiom (swap data-state + label,
// auto-reset). The clipboard payloads differ — snapshot captures the full
// scene JSON via __xgisSnapshot(); copy-link just grabs location.href (the
// #z/lat/lon/bearing/pitch hash is live-synced) — so only the flash is
// shared, not the clipboard call.
{
  const makeFlash = (btn: HTMLButtonElement, label: HTMLElement | null, idle: string) => {
    let resetTimer: ReturnType<typeof setTimeout> | null = null
    return (state: 'busy' | 'ok' | 'err', text: string, ms = 1500): void => {
      btn.dataset.state = state
      if (label) label.textContent = text
      if (resetTimer) clearTimeout(resetTimer)
      resetTimer = setTimeout(() => {
        btn.removeAttribute('data-state')
        if (label) label.textContent = idle
      }, ms)
    }
  }

  // Snapshot copy button — captures the current scene via __xgisSnapshot(),
  // writes the JSON to the clipboard for a bug repro (camera + viewport +
  // DPR + GPU tile cache + render-order trace + pixel hash). Schema in
  // `runtime/src/engine/map.ts captureSnapshot`.
  const snapBtn = document.getElementById('snapshot-btn') as HTMLButtonElement | null
  const snapLabel = document.getElementById('snapshot-btn-label') as HTMLSpanElement | null
  if (snapBtn) {
    const flash = makeFlash(snapBtn, snapLabel, 'Copy snapshot')
    snapBtn.addEventListener('click', async () => {
      const w = window as unknown as {
        __xgisSnapshot?: () => Promise<unknown>
        __xgisStartDrawOrderTrace?: () => void
        __xgisMap?: { invalidate?: () => void }
      }
      if (!w.__xgisSnapshot) {
        flash('err', 'No map loaded', 2000)
        return
      }
      flash('busy', 'Capturing…', 60_000)
      try {
        // Arm the draw-order trace + invalidate so the snapshot's
        // renderOrder field captures per-tile pipeline routing /
        // hasZBuffer for the next render frame — those are the
        // diagnostic fields that pinpoint why a scene rendered the
        // way it did. ~80 ms gives the rAF loop a turn.
        w.__xgisStartDrawOrderTrace?.()
        w.__xgisMap?.invalidate?.()
        await new Promise<void>((res) => setTimeout(res, 80))
        const snap = await w.__xgisSnapshot()
        const json = JSON.stringify(snap, null, 2)
        await navigator.clipboard.writeText(json)
        const sizeKb = Math.ceil(json.length / 1024)
        flash('ok', `Copied ${sizeKb} KB`, 2000)
      } catch (err) {
        // navigator.clipboard requires a secure context (https or
        // localhost). Surface the underlying error so the user can
        // diagnose: missing __xgisSnapshot, clipboard permission, etc.
        const msg = (err as Error).message ?? String(err)
        flash('err', `Failed: ${msg}`.slice(0, 40), 4000)
        console.error('[snapshot copy]', err)
      }
    })
  }

  // Copy-link button — copies the current URL (deep-links to this exact
  // view; the camera hash is kept in sync by the camera loop).
  const linkBtn = document.getElementById('copy-link-btn') as HTMLButtonElement | null
  const linkLabel = document.getElementById('copy-link-btn-label') as HTMLSpanElement | null
  if (linkBtn) {
    const flash = makeFlash(linkBtn, linkLabel, 'Copy link')
    linkBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(location.href)
        flash('ok', 'Copied', 1500)
      } catch (err) {
        const msg = (err as Error).message ?? String(err)
        flash('err', `Failed: ${msg}`.slice(0, 40), 4000)
        console.error('[copy link]', err)
      }
    })
  }
}

// ── Demo description in the status pill + popover ──
// The pill's first line is the demo name + pan hint (statusMain); the
// description sits beneath it, single-line-clamped, and clicking it opens
// a popover with the full text (dismiss on outside click / Escape). For
// Demo.actions demos this is the only surface that can carry the "click
// the buttons" guidance to the user.
function setStatusDescription(desc: string | null): void {
  if (!statusDescEl) return
  const text = desc?.trim() ?? ''
  if (text) {
    statusDescEl.textContent = text
    statusDescEl.hidden = false
    statusPopoverEl.textContent = text
  } else {
    statusDescEl.hidden = true
    statusPopoverEl.hidden = true
  }
}
if (statusDescEl) {
  statusDescEl.addEventListener('click', (e) => {
    e.stopPropagation()
    statusPopoverEl.hidden = !statusPopoverEl.hidden
  })
  document.addEventListener('click', (e) => {
    if (statusPopoverEl.hidden) return
    const t = e.target as Node
    if (t === statusDescEl || statusPopoverEl.contains(t)) return
    statusPopoverEl.hidden = true
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !statusPopoverEl.hidden) statusPopoverEl.hidden = true
  })
}

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
    'position:fixed',
    'right:8px',
    'bottom:8px',
    'z-index:2000',
    'max-width:min(96vw,520px)',
    'max-height:60vh',
    'font:11px/1.4 "DM Mono",monospace',
    'color:#dde',
    'background:rgba(10,12,20,0.92)',
    'backdrop-filter:blur(6px)',
    'border:1px solid rgba(255,255,255,0.18)',
    'border-radius:6px',
    'display:none',
    'flex-direction:column',
    'overflow:hidden',
  ].join(';')

  const header = document.createElement('div')
  header.style.cssText =
    'display:flex;gap:8px;align-items:center;padding:6px 10px;background:rgba(255,80,80,0.18);cursor:pointer;user-select:none'
  header.innerHTML =
    '<strong style="flex:1">⚠ Errors</strong><span id="log-count">0</span><button id="log-safe" style="font:inherit;padding:2px 8px;border:1px solid #555;background:#222;color:#dde;border-radius:4px;cursor:pointer">Safe</button><button id="log-copy" style="font:inherit;padding:2px 8px;border:1px solid #555;background:#222;color:#dde;border-radius:4px;cursor:pointer">Copy</button><button id="log-clear" style="font:inherit;padding:2px 8px;border:1px solid #555;background:#222;color:#dde;border-radius:4px;cursor:pointer">×</button>'
  wrap.appendChild(header)

  const body = document.createElement('div')
  body.id = 'log-body'
  body.style.cssText =
    'overflow-y:auto;padding:8px 10px;white-space:pre-wrap;word-break:break-word;flex:1'
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
    const msg = args
      .map((a) => {
        if (a instanceof Error) return a.stack || a.message
        if (typeof a === 'object') {
          try {
            return JSON.stringify(a)
          } catch {
            return String(a)
          }
        }
        return String(a)
      })
      .join(' ')
    if (NOISE_RE.test(msg)) return
    ENTRIES.push({ kind, ts: Date.now(), msg })
    if (ENTRIES.length > MAX) ENTRIES.splice(0, ENTRIES.length - MAX)
    repaint()
  }

  // Hook console
  const origError = console.error.bind(console)
  const origWarn = console.warn.bind(console)
  console.error = (...args: unknown[]) => {
    push('error', ...args)
    origError(...args)
  }
  console.warn = (...args: unknown[]) => {
    push('warn', ...args)
    origWarn(...args)
  }

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
    if (parts.length === 0)
      parts.push(
        '(opaque cross-origin error — try `taskkill /PID port:3001` and reload via localhost)',
      )
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
    const text =
      ENTRIES.map(fmtRow).join('\n\n') + '\n\n--\n' + location.href + '\n' + navigator.userAgent
    try {
      await navigator.clipboard.writeText(text)
      const btn = document.getElementById('log-copy')! as HTMLButtonElement
      const orig = btn.textContent
      btn.textContent = 'Copied'
      setTimeout(() => {
        btn.textContent = orig
      }, 1200)
    } catch {
      /* clipboard might be blocked over plain http */
    }
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
    const stack = err instanceof Error ? err.stack || err.message : String(err)
    const push = (window as unknown as { __xgisLog?: LogFn }).__xgisLog
    if (push) push('error', `[async ${label}]`, stack)
    else console.error(`[async ${label}]`, stack)
  }
  const wrap = <F extends (...a: never[]) => unknown>(label: string, fn: F): F =>
    ((...args: never[]) => {
      try {
        return fn(...args)
      } catch (e) {
        log(label, e)
        throw e
      }
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
      : stOrig(cb, ms, ...rest)) as typeof window.setTimeout
  const siOrig = window.setInterval
  window.setInterval = ((cb: TimerHandler, ms?: number, ...rest: unknown[]) =>
    typeof cb === 'function'
      ? siOrig(wrap('setInterval', cb as never) as TimerHandler, ms, ...rest)
      : siOrig(cb, ms, ...rest)) as typeof window.setInterval

  // queueMicrotask
  if (typeof window.queueMicrotask === 'function') {
    const qmtOrig = window.queueMicrotask.bind(window)
    window.queueMicrotask = (cb: VoidFunction) =>
      qmtOrig(wrap('microtask', cb as never) as VoidFunction)
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

// ── XGIS/JS source tabs (#1194 A3b) ──
// For demos with a SceneBuilder twin, the JS tab shows the equivalent
// builder construction — read-only (Run stays on the XGIS view; the parity
// gate guarantees both forms mount the same scene).
const langTabs = document.getElementById('lang-tabs') as HTMLDivElement | null
const tabXgis = document.getElementById('tab-xgis') as HTMLButtonElement | null
const tabJs = document.getElementById('tab-js') as HTMLButtonElement | null

// The corpus model is 'typescript' for colorization only — no language
// service (the generic editor worker is the only one registered).
monaco.typescript.typescriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: true,
})

const TWIN_HELPERS = [
  'call',
  'colorToken',
  'compare',
  'field',
  'ident',
  'interpolateZoom',
  'matchOn',
  'num',
  'str',
]

/** Extract a twin's `new SceneBuilder()….build()` chain from the corpus RAW
 *  source and wrap it as a host-runnable snippet. Null when the demo has no
 *  twin (or the corpus formatting drifted — then the tab simply hides). */
function twinSnippet(id: string): string | null {
  if (!SCENE_BUILDER_TWINS[id]) return null
  const entry = new RegExp(`^  ${id}: \\{\\n([\\s\\S]*?)\\n  \\},`, 'm').exec(twinCorpusRaw)
  const body = entry?.[1]
  if (!body) return null
  const start = body.indexOf('new SceneBuilder()')
  const end = body.lastIndexOf('.build()')
  if (start < 0 || end < 0) return null
  const chain = body
    .slice(start, end + '.build()'.length)
    .split('\n')
    .map((l, i) => (i === 0 ? l : l.replace(/^ {6}/, '')))
    .join('\n')
  const used = TWIN_HELPERS.filter((h) => new RegExp(`\\b${h}\\(`).test(chain))
  return [
    `import { SceneBuilder${used.map((h) => `, ${h}`).join('')} } from '@xgis/compiler'`,
    '',
    `const scene = ${chain}`,
    '',
    'await map.runScene(scene)',
    '',
  ].join('\n')
}

// Explicit model: the model `create({ value })` makes implicitly is
// editor-OWNED and gets disposed on the first setModel swap — an explicitly
// created pair survives tab switches.
const xgisModel = monaco.editor.createModel('', 'xgis')
editor.setModel(xgisModel)
let jsModel: monaco.editor.ITextModel | null = null

function showLangTab(js: boolean): void {
  tabXgis?.classList.toggle('active', !js)
  tabJs?.classList.toggle('active', js)
  if (js) {
    jsModel ??= monaco.editor.createModel('', 'typescript')
    jsModel.setValue(twinSnippet(demoIds[currentIdx]) ?? '')
    editor.setModel(jsModel)
    editor.updateOptions({ readOnly: true })
    runBtn.disabled = true
  } else {
    editor.setModel(xgisModel)
    editor.updateOptions({ readOnly: false })
    runBtn.disabled = false
  }
}
tabXgis?.addEventListener('click', () => showLangTab(false))
tabJs?.addEventListener('click', () => showLangTab(true))

// ── Build selector ──
// Group by tag via <optgroup> so the 100+ entry dropdown is browseable
// instead of an unsorted wall. Tag order mirrors the gallery page's
// TAG_ORDER; options inside each group sort alphabetically by name.
// The `<option value>` still carries the `demoIds` index, so the
// existing `selectEl.value = String(idx)` path keeps working.
const TAG_ORDER_DROPDOWN: string[] = [
  'basic',
  'style',
  'raster',
  'zoom',
  'layer',
  'line',
  'point',
  'per-feature',
  'data-driven',
  'vector-tiles',
  'natural-earth',
  '10m',
  'thematic',
  'fixture',
]
const TAG_LABELS_DROPDOWN: Record<string, string> = {
  basic: 'Basic',
  style: 'Style & Filter',
  raster: 'Raster',
  zoom: 'Zoom',
  layer: 'Multi-Layer',
  'per-feature': 'Per-Feature',
  'vector-tiles': 'Vector Tiles',
  'natural-earth': 'Natural Earth',
  'data-driven': 'Data-Driven',
  point: 'Points & Shapes',
  line: 'SDF Lines',
  '10m': 'High Detail (10m)',
  thematic: 'Thematic',
  fixture: 'Fixtures',
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
    list.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
    )
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
  for (const tag of [...byTag.keys()].filter((t) => !seen.has(t)).sort()) addGroup(tag)
}

// ── ?debug=labels overlay ───────────────────────────────────────────
//
// Mobile-friendly diagnostic: install a DOM overlay that visualises
// every label submitted to the text stage. Each addLabel /
// addCurvedLineLabel fires a hook with (text, anchorX, anchorY, kind);
// we accumulate ~200ms windows and group submissions whose anchors
// land within 5 px of each other to expose stacking. Each cluster
// renders as a colored dot + a small text box showing the unique text
// values and submission count.
//
// This is the on-device equivalent of monkey-patching addLabel in the
// browser console — useful when iOS/Android lack devtools. Pure
// overlay; no rendering pipeline changes. Activated by `?debug=labels`
// in the playground URL so it's opt-in and stays out of normal runs.
function installLabelDebugOverlay(map: XGISMap): void {
  // Reuse a previously-injected overlay if the demo is being
  // reloaded — prevents stacked z-index ghosts across demo swaps.
  let overlay = document.getElementById('xgis-labels-debug')
  if (!overlay) {
    overlay = document.createElement('div')
    overlay.id = 'xgis-labels-debug'
    overlay.style.cssText =
      'position:fixed;top:0;left:0;right:0;bottom:0;' +
      'pointer-events:none;z-index:9999;overflow:hidden;'
    document.body.appendChild(overlay)
  }
  // Recent submissions buffer. The text stage fires the hook from
  // map.ts → addLabel for every feature in every visible label
  // layer, every frame. Capping at 600 across both `kind`s keeps
  // DOM updates cheap on mobile.
  const recent: Array<{ text: string; ax: number; ay: number; kind: 'point' | 'curve' }> = []
  const MAX_RECENT = 600
  map.setLabelDebugHook((text, ax, ay, kind) => {
    recent.push({ text, ax, ay, kind })
    if (recent.length > MAX_RECENT) recent.shift()
  })
  const dpr = window.devicePixelRatio || 1

  // ── On-device camera + projection diagnostic ─────────────────────
  //
  // Mobile testers can't open devtools. This panel exposes the
  // numbers that would normally be `console.log`'d so projection
  // anomalies (a label landing on screen despite ndcX > 1.5, or the
  // matrix differing from what code review predicts) are visible
  // without leaving the page.
  //
  // The panel shows: canvas physical / CSS dims, DPR, the four mvp
  // matrix corners that drive ndcX/cw, and the projected ndcX of a
  // canonical test point (Sweden, lon=18, lat=60). The user can
  // cross-check the panel reading against the actual screen
  // position of the Sweden label.
  const diagPanel = document.createElement('div')
  diagPanel.style.cssText =
    'position:fixed;top:6px;right:6px;' +
    'z-index:10000;pointer-events:none;' +
    'background:rgba(0,0,0,0.78);color:#fff;' +
    'font:9px/1.25 monospace;padding:4px 6px;' +
    'border-radius:3px;max-width:240px;white-space:pre;'
  document.body.appendChild(diagPanel)

  // Approximate the same projection math map.ts uses, so the panel
  // reads correspond 1:1 to the runtime call.
  const DEG2RAD = Math.PI / 180
  const EARTH_R = 6378137
  function lonLatToMerc(lon: number, lat: number): [number, number] {
    const clampedLat = Math.max(-85.0511, Math.min(85.0511, lat))
    return [
      lon * DEG2RAD * EARTH_R,
      Math.log(Math.tan(Math.PI / 4 + (clampedLat * DEG2RAD) / 2)) * EARTH_R,
    ]
  }
  const WORLD_MERC_M = 40075016.686
  function projectAllCopies(
    mvp: Float32Array,
    ccx: number,
    ccy: number,
    lon: number,
    lat: number,
  ): { ndcX: number; visible: boolean }[] {
    const [mx, my] = lonLatToMerc(lon, lat)
    const out: { ndcX: number; visible: boolean }[] = []
    for (const w of [-2, -1, 0, 1, 2]) {
      const rtcX = mx + w * WORLD_MERC_M - ccx
      const rtcY = my - ccy
      const cw = mvp[3]! * rtcX + mvp[7]! * rtcY + mvp[15]!
      const ccx_ = mvp[0]! * rtcX + mvp[4]! * rtcY + mvp[12]!
      const ccy_ = mvp[1]! * rtcX + mvp[5]! * rtcY + mvp[13]!
      const ndcX = ccx_ / cw
      const ndcY = ccy_ / cw
      out.push({
        ndcX,
        visible: cw > 0 && ndcX >= -1.5 && ndcX <= 1.5 && ndcY >= -1.5 && ndcY <= 1.5,
      })
    }
    return out
  }
  // Test points: features whose label the user reports clustering.
  // Now testing ALL 5 world copies (matching projectLonLatCopies in
  // map.ts) so we can see if any world-copy projection accepts them.
  const TEST_POINTS = [
    { name: 'Sweden', lon: 18, lat: 60 },
    { name: 'Mexico', lon: -100, lat: 23 },
    { name: 'Brazil', lon: -55, lat: -10 },
    { name: 'Vietnam', lon: 108, lat: 16 },
    { name: 'Korea-N', lon: 127, lat: 40 },
  ]
  setInterval(() => {
    const mapAny = map as unknown as {
      ctx?: { canvas?: HTMLCanvasElement }
      camera?: {
        centerX: number
        centerY: number
        getRTCMatrix?: (w: number, h: number, dpr: number) => Float32Array
      }
    }
    const canvas = mapAny.ctx?.canvas
    const cam = mapAny.camera
    if (!canvas || !cam || !cam.getRTCMatrix) {
      diagPanel.textContent = 'diag: camera/canvas not ready'
      return
    }
    const w = canvas.width,
      h = canvas.height
    const mvp = cam.getRTCMatrix(w, h, dpr)
    const ccx = cam.centerX,
      ccy = cam.centerY
    const lines: string[] = []
    lines.push(`canvas: ${w}×${h} phys / ${(w / dpr) | 0}×${(h / dpr) | 0} css (dpr=${dpr})`)
    lines.push(`mvp[0]=${mvp[0]!.toFixed(3)} mvp[5]=${mvp[5]!.toFixed(3)}`)
    lines.push(`mvp[3]=${mvp[3]!.toFixed(3)} mvp[15]=${mvp[15]!.toExponential(2)}`)
    lines.push(`ccx=${(ccx / 1e6).toFixed(2)}e6 ccy=${(ccy / 1e6).toFixed(2)}e6`)
    for (const p of TEST_POINTS) {
      const results = projectAllCopies(mvp, ccx, ccy, p.lon, p.lat)
      // Compact summary: for each of [-2..+2], show ✓ or ✗.
      const marks = results.map((r) => (r.visible ? '✓' : '✗')).join('')
      // Visible projection's ndcX if any, else canonical's ndcX.
      const visible = results.find((r) => r.visible)
      const shown = visible ?? results[2]!
      lines.push(`${p.name}: [${marks}] ndc=${shown.ndcX.toFixed(2)}`)
    }
    diagPanel.textContent = lines.join('\n')
  }, 500)

  // Render the overlay periodically rather than per-frame — DOM
  // mutation per label is too expensive even on desktop, and the
  // user is comparing across a few seconds anyway.
  setInterval(() => {
    if (!overlay) return
    if (recent.length === 0) {
      if (overlay.childElementCount > 0) overlay.replaceChildren()
      return
    }
    // Cluster by 5-CSS-px proximity AND DEDUPE by text within the
    // window. Without text-dedup the count counts FRAME re-submissions
    // (each frame at ~60 fps re-submits every label), so a static
    // single-feature anchor reads as "60× per second" instead of "1
    // unique feature". The user-visible signal is the count of
    // DISTINCT features piling at an anchor — that's what
    // unique-text gives us.
    interface Group {
      ax: number
      ay: number
      texts: Set<string>
      uniqueSubmits: number
      kind: 'point' | 'curve'
    }
    const groups = new Map<string, Group>()
    for (const l of recent) {
      const cssX = l.ax / dpr
      const cssY = l.ay / dpr
      const k = `${l.kind}|${Math.round(cssX / 5) * 5},${Math.round(cssY / 5) * 5}`
      let g = groups.get(k)
      if (!g) {
        g = { ax: cssX, ay: cssY, texts: new Set<string>(), uniqueSubmits: 0, kind: l.kind }
        groups.set(k, g)
      }
      // Dedupe identical (anchor, text) within the window — that's
      // the per-frame re-submission. Distinct texts at the same anchor
      // still count separately (= multiple features overlapping).
      const before = g.texts.size
      g.texts.add(l.text)
      if (g.texts.size > before) g.uniqueSubmits++
    }
    overlay.replaceChildren()
    for (const g of groups.values()) {
      const color = g.kind === 'curve' ? '#0078ff' : '#e23030'
      const dot = document.createElement('div')
      dot.style.cssText =
        `position:absolute;left:${g.ax}px;top:${g.ay}px;` +
        'width:6px;height:6px;border-radius:50%;' +
        `background:${color};transform:translate(-50%,-50%);` +
        'box-shadow:0 0 0 1px #fff;'
      overlay.appendChild(dot)
      const box = document.createElement('div')
      const uniqueTexts = [...g.texts]
      const headline =
        uniqueTexts.length > 1
          ? `[${uniqueTexts.length} texts] ${uniqueTexts.slice(0, 2).join(' · ').slice(0, 50)}…`
          : (uniqueTexts[0] ?? '').slice(0, 60)
      box.style.cssText =
        `position:absolute;left:${g.ax + 8}px;top:${g.ay - 8}px;` +
        'font:10px/1.2 -apple-system,monospace;' +
        'background:rgba(255,255,255,0.92);' +
        `color:${color};border:1px solid ${color};` +
        'padding:2px 4px;border-radius:3px;' +
        'white-space:pre;max-width:240px;overflow:hidden;'
      // Show DISTINCT-feature count, not raw submission count. Distinct
      // texts at the same anchor → genuine multi-feature pile-up;
      // single-feature anchors read 1× regardless of frame rate.
      box.textContent = `${g.uniqueSubmits}× ${headline}`
      overlay.appendChild(box)
    }
    recent.length = 0
  }, 250)
}

// ── URL hash sync (MapLibre style: #zoom/lat/lon/bearing/pitch) ──
const R_EARTH = 6378137
const DEG = 180 / Math.PI
const RAD = Math.PI / 180

function parseHash(): {
  zoom: number
  lat: number
  lon: number
  bearing: number
  pitch: number
} | null {
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
  cam.centerY = Math.log(Math.tan(Math.PI / 4 + (clampLat * RAD) / 2)) * R_EARTH
  // The globe/sphere family renders (and selects tiles) from the TRUE centre
  // latitude camera.centerLatDeg, which a direct centerY write leaves STALE.
  // Without this resync a hash camera silently drove the globe at lat≈0 —
  // wrong hemisphere / labels off the disc / a blank land view (#799/#800/#803).
  // This honours the SAME contract the library's own external centerY writers
  // (CameraController pan/zoom, SourceManager) already follow; flat projections
  // ignore centerLatDeg, so it is inert off the globe.
  cam.syncCenterLat()
  cam.bearing = h.bearing
  cam.pitch = h.pitch
  // Tell the map this is an explicit positioning so the post-compile
  // bounds-fit doesn't snap us back to whole-world view when the
  // worker tile compile lands.
  map.markCameraPositioned()
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
  const tail = cam.bearing || cam.pitch ? `/${b}/${p}` : ''
  return `#${z}/${la}/${lo}${tail}`
}

let hashSyncRaf = 0
let lastHash = ''
let lastBadgeText = ''
let lastHashWriteMs = 0
// iOS Safari throttles history.replaceState to 100 calls per 10 seconds and
// throws SecurityError past that. Writing every rAF (~60Hz) during a pan
// tripped the limit instantly, so we rate-limit URL writes to ~5Hz. The
// on-screen badge text update is folded into the same RAF loop and only
// touched when the formatted string actually changes — touching textContent
// every frame during a pan was a measured 4.6 ms / pan-window in the
// profile (osm_style z=15) for what's effectively cosmetic feedback.
const HASH_WRITE_INTERVAL_MS = 200
function startHashSync(map: XGISMap): void {
  cancelAnimationFrame(hashSyncRaf)
  const tick = () => {
    const h = formatHash(map)
    if (h !== lastBadgeText) {
      hashBadge.textContent = h
      lastBadgeText = h
    }
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

// Live hash readout pinned to the top-left of the map pane for quick copy/paste.
// Was viewport-fixed top-right but that overlapped the editor pane header on
// desktop (covering the demo / projection selectors). Top-left of map-pane
// mirrors #status (bottom-left), the traditional map-attribution corner —
// stays away from the editor and from the picking overlay (top-right).
const hashBadge = document.createElement('div')
hashBadge.id = 'hash-badge'
hashBadge.title = 'Click to copy map state (zoom/lat/lon/bearing/pitch)'
hashBadge.style.cssText = [
  'position:absolute',
  'top:12px',
  'left:12px',
  'z-index:20',
  'font:11px/1.4 "DM Mono",monospace',
  'color:#dde',
  'background:rgba(10,10,10,0.75)',
  'backdrop-filter:blur(6px)',
  'padding:6px 10px',
  'border:1px solid rgba(255,255,255,0.12)',
  'border-radius:6px',
  'cursor:pointer',
  'user-select:all',
].join(';')
document.getElementById('map-pane')!.appendChild(hashBadge)
hashBadge.addEventListener('click', () => {
  navigator.clipboard?.writeText(location.href).then(() => {
    hashBadge.style.color = '#8f8'
    setTimeout(() => {
      hashBadge.style.color = '#dde'
    }, 600)
  })
})

window.addEventListener('hashchange', () => {
  if (currentMap) applyHashToCamera(currentMap)
})

// ── Run source code ──
// ── Picking overlay ────────────────────────────────────────────────
// Activated by demos with `picking: true`. Shows a small panel pinned
// over the map with the most recent hover + click hits. Mobile-friendly:
// touch events route through Pointer Events so tap fires `click` and
// updates the panel even without hover. Hover lines are hidden when
// only touch input has been observed.

let pickingOverlayCleanup: (() => void) | null = null

function setupPickingOverlay(map: InstanceType<typeof XGISMap>): void {
  teardownPickingOverlay()

  // Boot picking on. The demo's URL doesn't need `?picking=1` because
  // we flip it programmatically here.
  ;(map as unknown as { setQuality(p: { picking: boolean }): void }).setQuality({ picking: true })

  const panel = document.createElement('div')
  panel.id = 'picking-overlay'
  panel.style.cssText = [
    'position:absolute',
    'top:12px',
    'right:12px',
    'min-width:200px',
    'max-width:min(80vw,300px)',
    'padding:10px 12px',
    'background:rgba(10,10,10,0.85)',
    'backdrop-filter:blur(8px)',
    'border:1px solid rgba(255,255,255,0.2)',
    'border-radius:8px',
    'font:11px/1.5 "Geist Mono Variable","Geist Mono",monospace',
    'color:#dadbdf',
    'pointer-events:none',
    'z-index:25',
    'box-shadow:0 4px 12px rgba(0,0,0,0.3)',
  ].join(';')
  panel.innerHTML = `
    <div style="font-weight:500;color:#ffffff;margin-bottom:6px">Picking</div>
    <div id="po-hover" style="color:#7d8187">Hover a country…</div>
    <div id="po-click" style="margin-top:6px;padding-top:6px;border-top:1px solid #212327;color:#7d8187">Tap or click to lock</div>
  `
  const mapPane = document.getElementById('map-pane')!
  mapPane.appendChild(panel)
  const hoverEl = panel.querySelector('#po-hover') as HTMLDivElement
  const clickEl = panel.querySelector('#po-click') as HTMLDivElement

  // Detect touch-primary devices so we don't keep showing a stale "Hover…"
  // line on phones. Coarse pointer is the standard signal — covers
  // touchscreens and game controllers but excludes hybrid laptops with
  // a precise mouse attached.
  const isTouchPrimary = window.matchMedia?.('(pointer: coarse)').matches ?? false
  if (isTouchPrimary) hoverEl.style.display = 'none'

  type Ev = {
    target: { name: string }
    feature: { id: number; layer: string; properties: Record<string, unknown> }
    coordinate: readonly [number, number]
  }
  const fmtCoord = (c: readonly [number, number]) => `${c[0].toFixed(2)}°, ${c[1].toFixed(2)}°`
  const fmtFeature = (e: Ev) => {
    const name = (e.feature.properties.name as string | undefined) ?? `feature ${e.feature.id}`
    return `<span style="color:#c8d3e0">${name}</span> <span style="color:#5a6a7e">(${e.feature.layer} #${e.feature.id})</span>`
  }

  const ac = new AbortController()
  const m = map as unknown as {
    getLayer(n: string): {
      addEventListener(t: string, h: (e: unknown) => void, opt?: { signal: AbortSignal }): void
    } | null
    addEventListener(t: string, h: (e: unknown) => void, opt?: { signal: AbortSignal }): void
  }

  // Map-level delegation — fires for any pickable layer hit, so the
  // panel shows whatever's on top regardless of which layer was added.
  m.addEventListener(
    'mousemove',
    (raw) => {
      const e = raw as Ev
      hoverEl.innerHTML = `${fmtFeature(e)}<br><span style="color:#5a6a7e">${fmtCoord(e.coordinate)}</span>`
    },
    { signal: ac.signal },
  )
  m.addEventListener(
    'mouseleave',
    () => {
      hoverEl.textContent = 'Hover a country…'
      hoverEl.style.color = '#5a6a7e'
    },
    { signal: ac.signal },
  )
  m.addEventListener(
    'click',
    (raw) => {
      const e = raw as Ev
      clickEl.innerHTML = `<span style="color:#4ade80">▸</span> ${fmtFeature(e)}<br><span style="color:#5a6a7e">${fmtCoord(e.coordinate)}</span>`
    },
    { signal: ac.signal },
  )

  pickingOverlayCleanup = () => {
    ac.abort()
    panel.remove()
    pickingOverlayCleanup = null
  }
}

function teardownPickingOverlay(): void {
  pickingOverlayCleanup?.()
}

// ── Mouse-position readout (#1192) ───────────────────────────────────
// Activated by demos with `mousePosition: true`. Shows a small badge
// pinned over the map with the live lon/lat under the cursor, updated
// on every pointermove over the canvas via map.unproject() — MapLibre's
// "Get coordinates of the mouse pointer" example. Unlike the picking
// overlay's hover line (fires only over a hit feature), this tracks the
// cursor everywhere over the map, matching the original example.

let mousePositionCleanup: (() => void) | null = null

function setupMousePositionOverlay(map: InstanceType<typeof XGISMap>): void {
  teardownMousePositionOverlay()

  const badge = document.createElement('div')
  badge.id = 'mouse-position-badge'
  badge.style.cssText = [
    'position:absolute',
    'right:12px',
    'bottom:12px',
    'z-index:20',
    'font:11px/1.4 "DM Mono",monospace',
    'color:#dde',
    'background:rgba(10,10,10,0.75)',
    'backdrop-filter:blur(6px)',
    'padding:6px 10px',
    'border:1px solid rgba(255,255,255,0.12)',
    'border-radius:6px',
    'pointer-events:none',
  ].join(';')
  badge.textContent = 'Move the mouse over the map…'
  const mapPane = document.getElementById('map-pane')!
  mapPane.appendChild(badge)

  const canvasEl = map.getCanvas()
  const onMove = (e: PointerEvent): void => {
    const rect = canvasEl.getBoundingClientRect()
    const lonLat = map.unproject([e.clientX - rect.left, e.clientY - rect.top])
    badge.textContent = lonLat
      ? `Longitude: ${lonLat[0].toFixed(4)}, Latitude: ${lonLat[1].toFixed(4)}`
      : 'Move the mouse over the map…'
  }
  canvasEl.addEventListener('pointermove', onMove)

  mousePositionCleanup = () => {
    canvasEl.removeEventListener('pointermove', onMove)
    badge.remove()
    mousePositionCleanup = null
  }
}

function teardownMousePositionOverlay(): void {
  mousePositionCleanup?.()
}

// Expose for tests / inspector — pass a modified source string and
// the demo reloads with it (same path as Run button + Ctrl+Enter).
;(window as unknown as { __xgisRunSource?: (s: string) => Promise<unknown> }).__xgisRunSource =
  async (s: string) => runSource(s, 'TestInjected')

/** Push inline GeoJSON captured from an imported Mapbox style onto the
 *  current map. Keyed by sanitized source id — matching the empty
 *  geojson sources the converter emitted — so setSourceData() fills
 *  them in. Used by both the in-app Import-Mapbox hook and the
 *  /convert page hand-off (`__import`). No-op when there's nothing to
 *  push or the map failed to build. */
function pushImportedInlineGeoJSON(inline: Record<string, unknown> | null | undefined) {
  if (!inline || !currentMap) return
  for (const [id, fc] of Object.entries(inline)) {
    try {
      currentMap.setSourceData(id, fc as any)
    } catch (e) {
      console.warn(`[X-GIS] inline GeoJSON push failed for source "${id}"`, e)
    }
  }
}

// base64 → UTF-8 (the modern equivalent of the deprecated
// `decodeURIComponent(escape(atob(x)))` trick: decode the base64 to raw bytes,
// then let TextDecoder interpret them as UTF-8).
const b64ToUtf8 = (b64: string): string =>
  new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))

// Legacy-source migration shim (#1064/#1115 aftermath): sources converted or
// stored BEFORE the mandatory `xgis 1` version pragma (2026-07-14) hard-fail
// the parser with X-GIS0008 when re-run from sessionStorage/#src= hand-offs,
// bookmarks, or a surviving editor buffer. The LIBRARY parser stays strict —
// the pragma is the deliberate language-versioning gate — but the playground
// is a dev harness: auto-prepend the v1 pragma for pragma-less sources so
// pre-#1115 converter outputs keep running, with a console breadcrumb.
// (Pre-#1138 sources using PRUNED constructs still fail with their own
// specific errors — that break is intentional, #1072.)
function ensureVersionPragma(source: string): string {
  // Strip leading blank lines, // line comments and /* */ block comments to
  // find the first significant token (comments may legally precede a pragma).
  let rest = source
  for (;;) {
    const trimmed = rest.replace(/^\s+/, '')
    if (trimmed.startsWith('//')) {
      const nl = trimmed.indexOf('\n')
      if (nl === -1) return source // comment-only source — let the parser speak
      rest = trimmed.slice(nl + 1)
    } else if (trimmed.startsWith('/*')) {
      const end = trimmed.indexOf('*/')
      if (end === -1) return source // unterminated — let the parser speak
      rest = trimmed.slice(end + 2)
    } else {
      rest = trimmed
      break
    }
  }
  if (/^xgis\s+\d/.test(rest)) return source
  console.warn(
    '[X-GIS playground] legacy source without a version pragma — prepending "xgis 1" ' +
      '(pre-2026-07-14 conversion; re-convert on /convert for a clean copy)',
  )
  return 'xgis 1\n\n' + source
}

async function runSource(source: string, label: string) {
  source = ensureVersionPragma(source)
  errorDiv.style.display = 'none'
  // #1153 P1 (#2) — destroy() (not stop()): a fresh XGISMap is constructed below,
  // so the old map's device, catalogs, renderers, palette atlases and its
  // ResizeObserver/matchMedia pins must be fully released, not just paused.
  // Idempotent on an already-destroyed map (the _destroyed latch).
  currentMap?.destroy()

  try {
    statusMain.textContent = `Loading ${label}...`
    status.style.opacity = '1'
    // A direct (custom / imported) run has no demo metadata — clear any
    // description left over from the previously mounted demo. loadDemo
    // re-populates it after runSource returns for gallery demos.
    setStatusDescription(null)

    // Wait for any @font-face declarations (map-fonts.css → Open Sans,
    // Noto Sans Variable) to finish loading BEFORE we let the engine
    // rasterise its first glyph. Without this, the atlas caches glyphs
    // drawn with the host's system fallback, and the loaded WOFF2 never
    // takes effect for that codepoint until the slot is evicted. Cheap
    // in practice: <link rel="preload"> kicks the fetch off at parse
    // time, so by the time we get here the promise typically resolves
    // immediately. Try/catch covers browsers without the FontFaceSet API.
    try {
      await document.fonts?.ready
    } catch {
      /* no-op */
    }
    // ?compute=1 — opt into Plan P4 GPU compute paint evaluation.
    // Threads through XGISMapOptions.enableComputePath → compiler
    // emit flag → variant.computeBindings → ComputeLayerRegistry
    // → per-frame dispatch. Default off; demos that don't pass the
    // flag render through the legacy fragment-shader path unchanged.
    const computeOptIn = new URL(window.location.href).searchParams.get('compute') === '1'
    // Pre-runSource sprite / glyphs URL seeding. The Mapbox-import flows
    // (__xgisImportMapbox + convert-page __xgisImportSource via session-
    // Storage) stash the original style's sprite + glyphs URLs in
    // module-scope `pendingSpriteUrl` / `pendingGlyphsUrl` BEFORE
    // calling runSource. Threading them into the XGISMap constructor
    // (vs the late setSpriteUrl call) guarantees the IconStage's first-
    // frame construction gate sees a non-null URL — pre-fix the gate
    // fired with `spriteUrl === null` and the atlas was never built,
    // so icon-image layers rendered nothing (iter 56 deploy-bug repro).
    const ctorOpts: {
      enableComputePath: boolean
      backend?: 'auto' | 'webgpu' | 'webgl2'
      spriteUrl?: string
      glyphs?: { url?: string }
      preserveDrawingBuffer?: boolean
    } = {
      enableComputePath: computeOptIn,
    }
    // ?backend=webgpu|webgl2 — hard-pin the boot backend (the toolbar toggle
    // writes this param). Absent = 'auto': WebGPU with WebGL2 fallback, still
    // honouring the legacy ?forcegl2=1 override. WebGL2 also runs under
    // SOFTWARE rasterisation (SwiftShader), so a GPU-less machine can pin
    // webgl2 and still render every demo.
    const backendParam = new URL(window.location.href).searchParams.get('backend')
    if (backendParam === 'webgpu' || backendParam === 'webgl2') ctorOpts.backend = backendParam
    if (pendingSpriteUrl) ctorOpts.spriteUrl = pendingSpriteUrl
    if (pendingGlyphsUrl) ctorOpts.glyphs = { url: pendingGlyphsUrl }
    // #1153 M2: the WebGL2 gl2 gates capture via readPixels-after-present, which
    // needs a preserved drawing buffer (off by default now). ?e2e=1 opts back in.
    // ?preserve=1 is the standalone knob for gates that need the preserved buffer
    // but NOT ?e2e=1's fixture-auto-push suppression (the points gate deliberately
    // omits e2e so its fixture data still auto-pushes — #1172 merge reconciliation).
    if (params.has('e2e') || params.has('preserve')) ctorOpts.preserveDrawingBuffer = true
    currentMap = new XGISMap(canvas, ctorOpts)
    // Debug hook — Playwright tests + DevTools console can poke at
    // map._elapsedMs, map.vectorTileShows, etc. without re-wiring the
    // demo runner. Keep it lightweight; not part of the public API.
    ;(window as unknown as { __xgisMap?: unknown }).__xgisMap = currentMap
    // #1194 e2e hook — lazy SceneBuilder access for the run()↔runScene
    // twin-render gate (_scene-builder-twin.spec.ts) + future gallery JS
    // tabs (A3). Loader, not instance: the spec builds its own scene.
    ;(window as unknown as { __xgisSceneBuilder?: unknown }).__xgisSceneBuilder = () =>
      import('@xgis/compiler').then((m) => ({ SceneBuilder: m.SceneBuilder, ident: m.ident }))
    // ?debug=labels — mobile-friendly label diagnostic overlay (no
    // dev tools required). Renders a colored dot + small text snippet
    // at every submitted label anchor, with per-anchor submission
    // count. Lets users SEE which labels are firing where on mobile
    // where console scripts aren't an option.
    if (new URL(window.location.href).searchParams.get('debug') === 'labels') {
      installLabelDebugOverlay(currentMap)
    }
    // ?profile=1 — render the X-GIS Inspector (tabbed live diag panel).
    // Pair with ?gpuprof=1 for WebGPU timestamp-query GPU-pass timing.
    if (new URL(window.location.href).searchParams.get('profile') === '1') {
      const { installXGISInspector } = await import('./xgis-inspector')
      installXGISInspector()
    }
    // ?perf=1 — on-screen mobile performance scoreboard (tap to run, tap to
    // copy). The no-devtools way to capture frame percentiles + per-pass CPU
    // encode + draw stats on a real phone. Pair with ?gpuprof=1 for GPU times.
    if (new URL(window.location.href).searchParams.get('perf') === '1') {
      const { installPerfOverlay } = await import('./perf-overlay')
      installPerfOverlay(currentMap)
    }
    // ?debug=overdraw — on-screen overdraw capture: one tap measures pitch 0°
    // and 70°, inverts the heatmap colormap to real overdraw COUNTS, and prints
    // copyable stats (mean/p95/max/distribution). The runtime already turns the
    // scene into the heatmap for this flag; this just adds the capture button.
    if (new URL(window.location.href).searchParams.get('debug') === 'overdraw') {
      const { installOverdrawCapture } = await import('./overdraw-capture')
      installOverdrawCapture(currentMap)
    }
    // Expose tileKeyUnpack for e2e diagnostic — lets tests decode
    // packed tileKeys back to (z, x, y) without re-importing the
    // helper through Playwright's evaluate-evaluate boundary.
    const { tileKeyUnpack } = await import('@xgis/compiler')
    ;(window as unknown as { __xgisInternals?: unknown }).__xgisInternals = { tileKeyUnpack }
    // #1194 A1b — `?runscene=1`: mount via the demo's SceneBuilder twin
    // (map.runScene) instead of the .xgis text, when a twin is registered.
    // First-mount path for the twin-render gate; falls through to run()
    // for demos without a twin so the flag is always safe. Post-run wiring
    // below (proj override / hash sync / host hooks) is shared by both paths.
    const runsceneUrl = new URL(window.location.href)
    const twin =
      runsceneUrl.searchParams.get('runscene') === '1'
        ? SCENE_BUILDER_TWINS[runsceneUrl.searchParams.get('id') ?? '']
        : undefined
    if (twin) await currentMap.runScene(twin.build(), import.meta.env.BASE_URL + 'data/')
    else await currentMap.run(source, import.meta.env.BASE_URL + 'data/')

    // URL `?proj=X` overrides whatever projection the source declared.
    // Empty / absent means: keep the source's default.
    const projOverride = new URLSearchParams(location.search).get('proj')
    if (projOverride) currentMap.setProjection(projOverride)

    // Apply pre-existing hash AFTER data is loaded (so bounds-fit ran first).
    applyHashToCamera(currentMap)
    startHashSync(currentMap)

    // #797 P2a — retained-circle scale hook for the real-GPU p95 benchmark.
    // `?hostcircles=N` packs N geo-spread discs through map.graphics.add({ type:
    // 'circle' }) ONCE, so a headed capture can drive the retained circle path at
    // scale under pan/zoom (a camera move re-runs zero host JS — the retained
    // N-independence contract). Absent / 0 → nothing added (byte-identical demo).
    const hostCircles = Number(new URLSearchParams(location.search).get('hostcircles') ?? '0')
    if (Number.isFinite(hostCircles) && hostCircles > 0) {
      const pts: Array<[number, number]> = []
      for (let i = 0; i < hostCircles; i++) {
        pts.push([((i * 137.508) % 360) - 180, ((i * 61.803) % 140) - 70])
      }
      currentMap.graphics.add({
        type: 'circle',
        data: pts,
        getPosition: (d: [number, number]) => d,
        getRadius: 4,
        getColor: '#ff3311',
        getStrokeColor: '#ffffff',
        getStrokeWidth: 1,
        updateTriggers: { color: 1 },
      })
      currentMap.invalidate()
    }

    statusMain.textContent = `${label} · scroll to zoom, drag to pan`
    // Identity badge — show the backend that ACTUALLY booted. 'auto' can fall
    // back (WebGPU adapter-null → WebGL2), and a pinned boot should visibly
    // confirm the pin took: a green frame must never be attributed to the
    // wrong backend. Also exported for e2e (the render gates assert identity
    // next to their pixel assertions).
    const liveBackend = currentMap.getBackend()
    ;(window as unknown as { __xgisActiveBackend?: string | null }).__xgisActiveBackend =
      liveBackend
    if (liveBackend) {
      backendTagEl.textContent = liveBackend === 'webgl2' ? 'WebGL2' : 'WebGPU'
      backendTagEl.hidden = false
    } else {
      backendTagEl.hidden = true
    }
    setTimeout(() => {
      status.style.opacity = '0.4'
    }, 3000)
  } catch (err) {
    console.error('[X-GIS]', err)
    errorDiv.style.display = 'block'
    errorMsg.textContent = String(err)
    statusMain.textContent = 'Error'
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

  // #1194 A3b — tab visibility; always land on the (editable) XGIS view so
  // setValue below targets the xgis model.
  if (langTabs) {
    langTabs.hidden = twinSnippet(id) === null
    showLangTab(false)
  }

  editor.setValue(demo.source.trim())
  // Preserve `?proj=` (and any other current query params) when switching
  // demos — the projection override is meant to persist across navigation.
  const navUrl = new URL(location.href)
  navUrl.pathname = navUrl.pathname.replace(/[^/]*$/, 'demo.html')
  navUrl.searchParams.set('id', id)
  history.replaceState(null, '', navUrl.toString())

  // Discover fields from GeoJSON URLs in source (async, non-blocking)
  discoverFields(demo.source, import.meta.env.BASE_URL + 'data/')

  await runSource(demo.source, demo.name)

  // Surface the demo's description in the status pill (runSource cleared it
  // on entry). For Demo.actions demos this carries the interaction guidance.
  setStatusDescription(demo.description)

  // #1192 P1 — demo-declared viewport projection (mirrors MapLibre examples
  // that call the projection API, e.g. globe). `?proj=` URL override wins —
  // runSource already applied it. Applied BEFORE the demo camera: switching
  // into a wide-view projection clamps zoom to ≤1.5 (viewport-mode-controller
  // "frame the whole earth" adjust), which silently stomped an authored
  // Demo.zoom — globe_extrusion authored 2.9, opened at 1.5.
  if (currentMap && demo.projection && !params.get('proj')) {
    currentMap.setProjection(demo.projection)
  }

  // Per-demo initial camera (loader.ts Demo.zoom/center/pitch/bearing): a
  // .xgis source carries no camera state, so a demo that only reads well at a
  // specific view sets it here. A URL `#z/lat/lon` hash (parsed at boot)
  // wins — markCameraPositioned shuts the auto-fit gate so the value sticks.
  const hasCameraPose =
    demo.zoom !== undefined ||
    demo.center !== undefined ||
    demo.pitch !== undefined ||
    demo.bearing !== undefined
  if (currentMap && hasCameraPose && !location.hash) {
    if (demo.center !== undefined) currentMap.setCenter(demo.center[0], demo.center[1])
    if (demo.zoom !== undefined) currentMap.setZoom(demo.zoom)
    if (demo.pitch !== undefined) currentMap.setPitch(demo.pitch)
    if (demo.bearing !== undefined) currentMap.setBearing(demo.bearing)
    currentMap.markCameraPositioned()
  }

  // Post-run hook: inline-source fixtures need the host to push
  // data — without this, gallery visitors see an empty canvas.
  // E2E tests that drive these fixtures themselves pass `?e2e=1`
  // to opt out so the test controls the push cadence.
  if (currentMap && !params.has('e2e')) {
    applyFixtureAutoPush(id, currentMap)
  }

  // Picking demos: enable runtime picking + install a hover/click
  // overlay so users can see the API in action without devtools.
  if (currentMap && demo.picking) {
    setupPickingOverlay(currentMap)
  } else {
    teardownPickingOverlay()
  }

  // Mouse-position demos (#1192): live lon/lat readout badge, independent
  // of picking (fires everywhere over the map, not just over a feature).
  if (currentMap && demo.mousePosition) {
    setupMousePositionOverlay(currentMap)
  } else {
    teardownMousePositionOverlay()
  }

  // #1192 interaction infra — Demo.actions → the #demo-actions button bar.
  // Rebuilt per demo switch; each click drives the LIVE map through the same
  // public API the MapLibre original wires to its <button>s.
  const actionsBar = document.getElementById('demo-actions')
  if (actionsBar) {
    actionsBar.replaceChildren()
    const actions = demo.actions ?? []
    actionsBar.hidden = actions.length === 0
    for (const action of actions) {
      const btn = document.createElement('button')
      btn.textContent = action.label
      btn.addEventListener('click', () => {
        if (!currentMap) return
        try {
          action.run(currentMap)
        } catch (e) {
          console.error(`[demo-actions] "${action.label}" threw:`, e)
        }
      })
      actionsBar.appendChild(btn)
    }
  }
}

/** Auto-inject sample data for inline-source fixtures so they
 *  render something when opened manually from the gallery. */
function applyFixtureAutoPush(id: string, map: InstanceType<typeof XGISMap>): void {
  if (id === 'fixture_inline_push') {
    map.setSourceData('tracks', {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 1,
          geometry: { type: 'Point', coordinates: [-30, 0] },
          properties: {},
        },
        {
          type: 'Feature',
          id: 2,
          geometry: { type: 'Point', coordinates: [0, 0] },
          properties: {},
        },
        {
          type: 'Feature',
          id: 3,
          geometry: { type: 'Point', coordinates: [30, 0] },
          properties: {},
        },
        {
          type: 'Feature',
          id: 4,
          geometry: { type: 'Point', coordinates: [0, 30] },
          properties: {},
        },
        {
          type: 'Feature',
          id: 5,
          geometry: { type: 'Point', coordinates: [0, -30] },
          properties: {},
        },
      ],
    })
  } else if (id === 'multiline_labels') {
    // Cities with long names that exceed label-max-width-7 (em),
    // forcing wrap. Demonstrates greedy word-break + line-height +
    // justify-center.
    map.setSourceData('cities', {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-74.006, 40.7128] },
          properties: { name: 'New York City' },
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-122.4194, 37.7749] },
          properties: { name: 'San Francisco' },
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-118.2437, 34.0522] },
          properties: { name: 'Los Angeles' },
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [151.2093, -33.8688] },
          properties: { name: 'Sydney Australia' },
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [-43.1729, -22.9068] },
          properties: { name: 'Rio de Janeiro' },
        },
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [126.978, 37.5665] },
          properties: { name: 'Seoul' },
        },
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

// ── Gallery back-link ──
// The footer "Gallery" link is authored as href="." (the playground's
// own index). But the deployed playground is reached by deep-link from
// the marketing site's /examples gallery — returning to the playground
// index (a separate, differently-shaped page) surprised users who
// expected to land back on the gallery they came from. In the deployed
// layout the playground lives under <site-base>/play/, so the examples
// gallery is one level up at <site-base>/examples. In standalone dev
// (BASE_URL === '/') there is no merged site, so keep the playground
// index as the fallback.
{
  const backLink = document.querySelector('.back-link') as HTMLAnchorElement | null
  const base = import.meta.env.BASE_URL
  if (backLink && base.endsWith('/play/')) {
    backLink.href = base.replace(/play\/$/, '') + 'examples'
  }
}

// ── Navigation ──
prevBtn.addEventListener('click', () => {
  if (currentIdx > 0) loadDemo(currentIdx - 1)
})
nextBtn.addEventListener('click', () => {
  if (currentIdx < demoIds.length - 1) loadDemo(currentIdx + 1)
})
selectEl.addEventListener('change', () => loadDemo(parseInt(selectEl.value)))

// ── Mapbox style import ─────────────────────────────────────────────
// Paste a Mapbox Style Spec JSON via clipboard / file picker; convert
// to xgis source via `convertMapboxStyle` from the compiler; load the
// result into the editor. Triggered by the "Import Mapbox" button if
// present in the markup, OR by `__xgisImportMapbox(jsonStr)` from the
// devtools console / a future test harness.
;(
  window as unknown as { __xgisImportMapbox?: (json: string | object) => void }
).__xgisImportMapbox = (json: string | object) => {
  import('@xgis/compiler').then(async ({ convertMapboxStyle }) => {
    try {
      // Parse once so we can read the top-level `glyphs` URL without
      // touching the xgis source. `glyphs` is a pure runtime concern
      // (SDF PBF fetch URL); the compiler doesn't encode it into the
      // xgis intermediate. We forward it to the map after the source
      // runs — TextStage builds lazily on the first label frame and
      // honours the URL the moment it's there.
      const styleObj = typeof json === 'string' ? JSON.parse(json) : json
      const glyphsUrl = (styleObj as { glyphs?: unknown }).glyphs
      const spriteUrl = (styleObj as { sprite?: unknown }).sprite
      // Style root camera (center / zoom / bearing / pitch). Applied
      // AFTER runSource so the bounds-fit gate inside Mapbox/runtime
      // doesn't fight us — markCameraPositioned shuts the gate. URL
      // hash camera still wins because demo-runner's hash parser ran
      // BEFORE this branch and already positioned the camera; we
      // re-check the flag here and skip when hash already won.
      const styleCenter = (styleObj as { center?: [number, number] }).center
      const styleZoom = (styleObj as { zoom?: number }).zoom
      const styleBearing = (styleObj as { bearing?: number }).bearing
      const stylePitch = (styleObj as { pitch?: number }).pitch
      // Capture inline GeoJSON `source.data` via the collector so it
      // renders instead of being dropped with a "call setSourceData()
      // manually" note. The converted xgis text can't embed inline
      // data (the DSL has no inline-data form), so we push each
      // captured FeatureCollection after runSource below.
      const inlineGeoJSON = new Map<string, unknown>()
      const xgis = convertMapboxStyle(styleObj, { inlineGeoJSON })
      editor.setValue(xgis)
      // Stash sprite + glyphs URLs in module-scope so the XGISMap
      // constructor inside runSource picks them up at build time
      // (vs the late setSpriteUrl call which fires AFTER IconStage's
      // first-frame construction gate has already seen
      // spriteUrl === null). Iter 105: the prior approach
      // (`currentMap?.setSpriteUrl(...)` before runSource) was a
      // no-op on first call because currentMap was null at that
      // point; the post-runSource re-apply hit after IconStage was
      // already built without the URL. Constructor-option seeding
      // is the canonical fix.
      pendingSpriteUrl = typeof spriteUrl === 'string' && spriteUrl.length > 0 ? spriteUrl : null
      pendingGlyphsUrl = typeof glyphsUrl === 'string' && glyphsUrl.length > 0 ? glyphsUrl : null
      await runSource(xgis, 'Imported (Mapbox)')
      // Seed inline GeoJSON captured above. setSourceData populates the
      // empty geojson sources the converter emitted (no-URL stubs) so
      // the features render on the first frame after the push.
      pushImportedInlineGeoJSON(Object.fromEntries(inlineGeoJSON))
      // WS-8 — honour the style's top-level `projection` field. Apply
      // BEFORE the camera block below so setProjection's zoom-clamp /
      // globeMode writes don't clobber the style-declared camera. URL
      // `?proj=` still wins: runSource() already applied it above, so
      // skip when the override is present.
      const styleProj = extractMapboxProjectionName(styleObj)
      if (styleProj && !new URLSearchParams(location.search).get('proj')) {
        currentMap?.setProjection(styleProj)
      }
      // WS-9 — honour the style's top-level `light` block (host-applied,
      // affects fill-extrusion shading). Default light is left untouched
      // when the style declares none.
      const styleLight = extractMapboxLight(styleObj)
      if (styleLight) currentMap?.setLight(styleLight)
      // Apply style-declared camera when nothing else (URL hash or
      // bounds-fit) explicitly positioned us yet. URL hash camera
      // (parseHash → markCameraPositioned at boot) wins because the
      // flag check below short-circuits.
      if (currentMap && !currentMap._cameraPositionedFlag) {
        const cam = currentMap.getCamera()
        let anyApplied = false
        if (Array.isArray(styleCenter) && styleCenter.length === 2) {
          const [lng, lat] = styleCenter
          const m = lonLatToMercator(lng, lat)
          cam.centerX = m[0]
          cam.centerY = m[1]
          // Resync the sphere-family true latitude — same contract as the hash
          // path above; a globe style `center` otherwise renders at lat≈0.
          cam.syncCenterLat()
          anyApplied = true
        }
        if (typeof styleZoom === 'number') {
          cam.zoom = Math.max(0, Math.min(cam.maxZoom, styleZoom))
          anyApplied = true
        }
        if (typeof styleBearing === 'number') {
          cam.bearing = styleBearing
          anyApplied = true
        }
        if (typeof stylePitch === 'number') {
          cam.pitch = stylePitch
          anyApplied = true
        }
        if (anyApplied) {
          currentMap.markCameraPositioned()
          currentMap.invalidate()
        }
      }
    } catch (e) {
      console.error('[X-GIS] Mapbox import failed:', e)
    }
  })
}
const importBtn = document.getElementById('import-mapbox-btn') as HTMLButtonElement | null
if (importBtn) {
  importBtn.addEventListener('click', async () => {
    // Two paths: file picker (recommended) or clipboard read fallback.
    const fileInput = document.createElement('input')
    fileInput.type = 'file'
    fileInput.accept = '.json,application/json'
    fileInput.style.display = 'none'
    document.body.appendChild(fileInput)
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0]
      if (!file) {
        fileInput.remove()
        return
      }
      const text = await file.text()
      ;(window as unknown as { __xgisImportMapbox: (j: string) => void }).__xgisImportMapbox(text)
      fileInput.remove()
    })
    fileInput.click()
  })
}

// ── Projection override ──
// Sync dropdown with URL state so reloads / shared links restore it.
projSelectEl.value = params.get('proj') ?? ''
projSelectEl.addEventListener('change', () => {
  const value = projSelectEl.value
  const url = new URL(location.href)
  if (value) url.searchParams.set('proj', value)
  else url.searchParams.delete('proj')
  history.replaceState(null, '', url.toString())
  // Empty value = reload demo to restore the source's declared projection.
  if (!value) loadDemo(currentIdx)
  else currentMap?.setProjection(value)
})

// ── Backend toggle ──
// Sync dropdown with URL state (?backend=), mirroring the projection override;
// the legacy ?forcegl2=1 shows as WebGL2 (the auto chain honours it anyway).
backendSelectEl.value = params.get('backend') ?? (params.get('forcegl2') === '1' ? 'webgl2' : '')
backendSelectEl.addEventListener('change', () => {
  const value = backendSelectEl.value
  const url = new URL(location.href)
  if (value) url.searchParams.set('backend', value)
  else url.searchParams.delete('backend')
  history.replaceState(null, '', url.toString())
  // Context types are sticky per canvas — boot the new backend on a fresh
  // node, re-running whatever source is in the editor (edits survive).
  // #1153 P1 (#2/A10) — destroy the old map BEFORE swapping its canvas out of the
  // DOM: destroy() detaches listeners/observers from the map's OWN old-canvas
  // reference, so destroy-then-replace is the clean order. runSource's own
  // destroy() on the same map below is then a no-op via the _destroyed latch.
  currentMap?.destroy()
  replaceMapCanvas()
  const label = selectEl.selectedOptions[0]?.textContent ?? 'Custom'
  void runSource(editor.getValue(), label)
})

document.addEventListener('keydown', (e) => {
  if (monacoContainer.contains(e.target as Node) || e.target instanceof HTMLSelectElement) return
  if (e.key === 'ArrowLeft' && currentIdx > 0) {
    e.preventDefault()
    loadDemo(currentIdx - 1)
  } else if (e.key === 'ArrowRight' && currentIdx < demoIds.length - 1) {
    e.preventDefault()
    loadDemo(currentIdx + 1)
  }
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
// `?sprite=<base>` / `?glyphs=<url>` query — seed the pending sprite/glyphs URL for ANY demo path
// (fixtures included, not only `__import`). runSource's XGISMap ctor consumes `pendingSpriteUrl`, so a
// local fixture (e.g. fixture_fill_pattern) can load its own sprite atlas via &sprite=/fixture-sprite.
{
  const qSprite = params.get('sprite')
  const qGlyphs = params.get('glyphs')
  if (qSprite) pendingSpriteUrl = qSprite
  if (qGlyphs) pendingGlyphsUrl = qGlyphs
}
// `?id=__import` → load whatever the /convert page handed off.
//
// Two transport channels:
//   1. URL hash `#src=<base64>`  (cross-origin dev path)
//      Used when the convert page on the Astro dev server
//      (localhost:4323) navigates to the playground dev server
//      (localhost:3000, separate origin). sessionStorage doesn't
//      cross origins, so the hash carries the source + a label
//      query param. Hash never hits the server, no length cost.
//   2. sessionStorage `__xgisImportSource`  (production path)
//      Same-origin under x-gis.github.io/X-GIS/play/... — large
//      payloads stay out of the URL on shareable links.
//
// Hash channel takes precedence: if both are present we honour the
// most recent intent (the navigation that just happened). Falls
// through to the regular demo loader on miss / decode errors.
if (params.get('id') === '__import') {
  let imported: string | null = null
  let label: string | null = null
  // Inline GeoJSON captured by the convert page (id → FeatureCollection),
  // pushed via setSourceData after runSource. Null when the style had none.
  let importInline: Record<string, unknown> | null = null
  // Channel 1: URL hash (dev cross-origin). The hash carries `src=` and
  // optionally `inline=`, both standard base64 (alphabet has no `&`), so
  // split on `&` to separate them unambiguously.
  if (location.hash.startsWith('#src=')) {
    try {
      let srcEnc = ''
      let inlineEnc = ''
      for (const part of location.hash.slice(1).split('&')) {
        if (part.startsWith('src=')) srcEnc = part.slice('src='.length)
        else if (part.startsWith('inline=')) inlineEnc = part.slice('inline='.length)
      }
      imported = b64ToUtf8(srcEnc)
      label = params.get('label') ?? 'Imported'
      if (inlineEnc) {
        try {
          importInline = JSON.parse(b64ToUtf8(inlineEnc))
        } catch {
          /* malformed inline blob — render without it */
        }
      }
    } catch {
      // Malformed base64 / utf-8 — fall through to sessionStorage.
      imported = null
    }
  }
  // Channel 2: sessionStorage (prod same-origin).
  if (!imported) {
    try {
      imported = sessionStorage.getItem('__xgisImportSource')
      label = sessionStorage.getItem('__xgisImportLabel')
    } catch {
      /* sessionStorage unavailable */
    }
  }
  if (!importInline) {
    try {
      const raw = sessionStorage.getItem('__xgisImportInline')
      if (raw) importInline = JSON.parse(raw)
    } catch {
      /* sessionStorage unavailable / malformed — render without it */
    }
  }
  // Sibling sprite + glyphs URLs from the convert page. Iter 105:
  // pre-fix the convert page sent only the converted xgis source, so
  // sprite/glyphs URLs from the original Mapbox JSON were lost and
  // icon-image layers rendered blank. Now the convert page stashes
  // both URLs alongside the source; this block reads them and
  // populates the pre-runSource pending vars so the XGISMap
  // constructor seeds the IconStage gate.
  try {
    const ss = sessionStorage.getItem('__xgisImportSprite')
    const gs = sessionStorage.getItem('__xgisImportGlyphs')
    if (typeof ss === 'string' && ss.length > 0) pendingSpriteUrl = ss
    if (typeof gs === 'string' && gs.length > 0) pendingGlyphsUrl = gs
  } catch {
    /* sessionStorage unavailable */
  }
  // Hash channel also supports sprite/glyphs query params (dev cross-
  // origin, sessionStorage doesn't survive the origin hop).
  const hashSprite = params.get('sprite')
  const hashGlyphs = params.get('glyphs')
  if (hashSprite) pendingSpriteUrl = hashSprite
  if (hashGlyphs) pendingGlyphsUrl = hashGlyphs
  if (imported) {
    document.title = (label ?? 'Imported') + ' — X-GIS'
    tagEl.textContent = 'imported'
    editor.setValue(imported.trim())
    discoverFields(imported, import.meta.env.BASE_URL + 'data/')
    runSource(imported, label ?? 'Imported').then(() => {
      // Seed inline GeoJSON handed off from the convert page once the
      // map (and its empty geojson source stubs) exist.
      pushImportedInlineGeoJSON(importInline)
    })
    // Don't clear yet — the user may want to reload. Cleared on next
    // demo navigation via the regular loadDemo path.
  } else {
    loadDemo(currentIdx)
  }
} else {
  loadDemo(currentIdx)
}

// (Old top-right overlay was here. Replaced by xgis-inspector.ts —
// activated via the same ?profile=1 URL param. The legacy code is
// intentionally not kept around: the inspector is a strict
// superset.)
