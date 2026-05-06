// ═══ X-GIS Inspector ═══
//
// Production-grade live inspector. Activated by `?profile=1` (heat
// debugging on real devices) — combine with `?gpuprof=1` to also
// surface WebGPU timestamp-query GPU pass timings.
//
// All data is read-only off the running map: window.__xgisMap is the
// XGISMap instance; vtSources have renderer + source; runtime caches
// (catalog dataCache, backend abortControllers, etc.) are reached
// through the same TS-private fields the e2e specs already use.
//
// UI: fixed top-right collapsible panel, six tabs. Vanilla DOM, no
// build dependency. Runs at 4 Hz so the inspector itself doesn't
// load the GPU it's measuring.

interface XGISCamera {
  zoom: number; centerX: number; centerY: number
  pitch?: number; bearing?: number
}
interface VTRStats {
  drawCalls: number; vertices: number; triangles: number; lines: number
  tilesVisible: number; missedTiles: number
}
interface VTRDiag {
  getDrawStats?: () => VTRStats
  getCacheSize?: () => number
  getPendingUploadCount?: () => number
  source?: unknown
  _hysteresisZ?: number
  _czPendingAdvance?: { target: number; since: number } | null
  _lastCamMoveAt?: number
  _bufferPool?: Map<string, GPUBuffer[]>
  gpuCache?: Map<string, Map<number, unknown>>
}
interface XGISMap {
  vtSources?: Map<string, { renderer: VTRDiag }>
  camera?: XGISCamera
  ctx?: { adapter?: GPUAdapter; device?: GPUDevice; timestampQuerySupported?: boolean }
  gpuTimer?: { enabled: boolean; getTimings?: () => number[] }
}

interface CacheStats {
  hasTileDataHits: number
  hasTileDataMisses: number
  bufferPoolHits: number
  bufferPoolMisses: number
  gpuCacheUploadHits: number
  gpuCacheUploadMisses: number
  fetchStarts: number
  fetchAborts: number
}

const TAB_NAMES = ['Frame', 'Tiles', 'GPU', 'Cache', 'Camera', 'Net'] as const
type TabName = typeof TAB_NAMES[number]

interface InspectorState {
  el: HTMLDivElement
  body: HTMLDivElement
  activeTab: TabName
  visible: boolean
  // frame-time ring
  ftRing: Float64Array
  ftHead: number
  ftFilled: number
  totalSlowFrames: number
  // peaks
  peaks: {
    tilesVisible: number; drawCalls: number; missedTiles: number
    heapMB: number; gpuPassMs: number
  }
  cache: CacheStats
  startMs: number
}

let installed = false

export function installXGISInspector(): void {
  if (installed) return
  installed = true

  const state: InspectorState = {
    el: document.createElement('div'),
    body: document.createElement('div'),
    activeTab: 'Frame',
    visible: true,
    ftRing: new Float64Array(60 * 30),
    ftHead: 0,
    ftFilled: 0,
    totalSlowFrames: 0,
    peaks: { tilesVisible: 0, drawCalls: 0, missedTiles: 0, heapMB: 0, gpuPassMs: 0 },
    cache: zeroCacheStats(),
    startMs: performance.now(),
  }

  buildShell(state)
  installCacheTelemetry(state.cache)
  // Per-frame fps tick + 250ms UI update.
  let lastFrame = performance.now()
  let lastUpdate = lastFrame
  function tick(): void {
    requestAnimationFrame(tick)
    const now = performance.now()
    const dt = now - lastFrame
    lastFrame = now
    state.ftRing[state.ftHead] = dt
    state.ftHead = (state.ftHead + 1) % state.ftRing.length
    if (state.ftFilled < state.ftRing.length) state.ftFilled++
    if (dt > 33) state.totalSlowFrames++
    if (now - lastUpdate >= 250) {
      lastUpdate = now
      renderActiveTab(state)
    }
  }
  requestAnimationFrame(tick)
}

function zeroCacheStats(): CacheStats {
  return {
    hasTileDataHits: 0, hasTileDataMisses: 0,
    bufferPoolHits: 0, bufferPoolMisses: 0,
    gpuCacheUploadHits: 0, gpuCacheUploadMisses: 0,
    fetchStarts: 0, fetchAborts: 0,
  }
}

// ─── Shell + tabs ───────────────────────────────────────────────

function buildShell(state: InspectorState): void {
  state.el.id = 'xgis-inspector'
  state.el.style.cssText = [
    'position:fixed', 'top:8px', 'right:8px', 'z-index:99999',
    'background:rgba(15,15,18,0.92)', 'color:#d4d4d8',
    'font:11px/1.4 ui-monospace,Menlo,monospace',
    'border:1px solid #3f3f46', 'border-radius:6px',
    'min-width:240px', 'max-width:320px', 'max-height:60vh',
    'box-shadow:0 4px 16px rgba(0,0,0,0.4)',
    'overflow:hidden', 'user-select:none',
  ].join(';')

  const header = document.createElement('div')
  header.style.cssText = [
    'display:flex', 'align-items:center', 'justify-content:space-between',
    'gap:6px',
    'padding:5px 8px', 'background:#27272a',
    'font-weight:600', 'color:#fafafa', 'border-bottom:1px solid #3f3f46',
  ].join(';')

  const title = document.createElement('span')
  title.textContent = 'X-GIS Inspector'
  title.style.cursor = 'pointer'
  title.style.flex = '1'
  header.appendChild(title)

  // Copy button — dumps every tab's content + a short metadata
  // header into the clipboard as plain text. Cheaper than image
  // captures for sharing perf reports.
  const copyBtn = document.createElement('button')
  copyBtn.textContent = 'Copy'
  copyBtn.style.cssText = [
    'background:#3f3f46', 'color:#fafafa', 'border:none', 'border-radius:3px',
    'padding:2px 8px', 'font:inherit', 'font-size:10px', 'cursor:pointer',
  ].join(';')
  copyBtn.addEventListener('click', async (e) => {
    e.stopPropagation()
    const text = collectAllTabsAsText(state)
    try {
      await navigator.clipboard.writeText(text)
      const orig = copyBtn.textContent
      copyBtn.textContent = '✓ Copied'
      copyBtn.style.background = '#16a34a'
      setTimeout(() => {
        copyBtn.textContent = orig
        copyBtn.style.background = '#3f3f46'
      }, 1200)
    } catch {
      // navigator.clipboard fails on insecure contexts. Fallback:
      // fill a hidden textarea + select + execCommand('copy'). Some
      // older mobile browsers (and iOS Safari without HTTPS) need
      // this path; on https GitHub Pages it'll be the first branch.
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;'
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy') } finally { ta.remove() }
      copyBtn.textContent = '✓ Copied (fallback)'
      copyBtn.style.background = '#16a34a'
      setTimeout(() => {
        copyBtn.textContent = 'Copy'
        copyBtn.style.background = '#3f3f46'
      }, 1500)
    }
  })
  header.appendChild(copyBtn)

  const minBtn = document.createElement('span')
  minBtn.id = 'xgis-insp-min'
  minBtn.textContent = '▾'
  minBtn.style.cssText = 'opacity:0.6;cursor:pointer;padding:0 4px'
  header.appendChild(minBtn)

  const toggleVisible = (): void => {
    state.visible = !state.visible
    state.body.style.display = state.visible ? '' : 'none'
    tabBar.style.display = state.visible ? '' : 'none'
    minBtn.textContent = state.visible ? '▾' : '▸'
  }
  title.addEventListener('click', toggleVisible)
  minBtn.addEventListener('click', e => { e.stopPropagation(); toggleVisible() })
  state.el.appendChild(header)

  const tabBar = document.createElement('div')
  tabBar.style.cssText = [
    'display:flex', 'background:#18181b', 'border-bottom:1px solid #3f3f46',
  ].join(';')
  for (const name of TAB_NAMES) {
    const btn = document.createElement('button')
    btn.textContent = name
    btn.style.cssText = [
      'flex:1', 'padding:5px 4px', 'background:transparent',
      'border:none', 'border-right:1px solid #27272a', 'color:#a1a1aa',
      'font:inherit', 'cursor:pointer',
    ].join(';')
    btn.addEventListener('click', e => {
      e.stopPropagation()
      state.activeTab = name
      updateTabHighlight(tabBar, state.activeTab)
      renderActiveTab(state)
    })
    btn.dataset.tab = name
    tabBar.appendChild(btn)
  }
  state.el.appendChild(tabBar)
  updateTabHighlight(tabBar, state.activeTab)

  state.body.style.cssText = [
    'padding:8px', 'white-space:pre-wrap', 'overflow-y:auto',
    'max-height:50vh', 'font:11px/1.45 ui-monospace,Menlo,monospace',
  ].join(';')
  state.body.textContent = '…'
  state.el.appendChild(state.body)

  document.body.appendChild(state.el)
}

function updateTabHighlight(tabBar: HTMLElement, active: TabName): void {
  for (const btn of Array.from(tabBar.querySelectorAll<HTMLButtonElement>('button'))) {
    const isActive = btn.dataset.tab === active
    btn.style.color = isActive ? '#fafafa' : '#a1a1aa'
    btn.style.background = isActive ? '#27272a' : 'transparent'
    btn.style.borderBottom = isActive ? '2px solid #4ade80' : '2px solid transparent'
  }
}

// ─── Active-tab content ────────────────────────────────────────

function renderActiveTab(state: InspectorState): void {
  const map = (window as unknown as { __xgisMap?: XGISMap }).__xgisMap
  switch (state.activeTab) {
    case 'Frame':  state.body.textContent = renderFrame(state, map);  break
    case 'Tiles':  state.body.textContent = renderTiles(state, map);  break
    case 'GPU':    state.body.textContent = renderGPU(state, map);    break
    case 'Cache':  state.body.textContent = renderCache(state);       break
    case 'Camera': state.body.textContent = renderCamera(state, map); break
    case 'Net':    state.body.textContent = renderNet(state);         break
  }
}

function frameStats(state: InspectorState, samples: number): { avg: number; max: number; p95: number; fps: number } {
  const n = Math.min(state.ftFilled, samples)
  if (n === 0) return { avg: 0, max: 0, p95: 0, fps: 0 }
  const arr: number[] = []
  let sum = 0, max = 0
  for (let i = 0; i < n; i++) {
    const idx = (state.ftHead - 1 - i + state.ftRing.length) % state.ftRing.length
    const v = state.ftRing[idx]
    arr.push(v); sum += v
    if (v > max) max = v
  }
  arr.sort((a, b) => a - b)
  return {
    avg: sum / n,
    max,
    p95: arr[Math.floor(arr.length * 0.95)],
    fps: sum > 0 ? Math.round((n * 1000) / sum) : 0,
  }
}

function renderFrame(state: InspectorState, map: XGISMap | undefined): string {
  const s1 = frameStats(state, 60)
  const s30 = frameStats(state, 60 * 30)
  const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
  const heapMB = heap ? Math.round(heap.usedJSHeapSize / 1048576) : 0
  if (heapMB > state.peaks.heapMB) state.peaks.heapMB = heapMB

  const gpuTimer = map?.gpuTimer
  let gpuLine = 'gpuTimer    : disabled (use ?gpuprof=1)'
  if (gpuTimer?.enabled && gpuTimer.getTimings) {
    const t = gpuTimer.getTimings()
    if (t.length) {
      const last10 = t.slice(-10)
      const avg = last10.reduce((a, b) => a + b, 0) / last10.length / 1e6
      const max = Math.max(...last10) / 1e6
      if (avg > state.peaks.gpuPassMs) state.peaks.gpuPassMs = avg
      gpuLine = `gpu pass    : avg ${avg.toFixed(2)} ms  max ${max.toFixed(2)} ms  peak ${state.peaks.gpuPassMs.toFixed(2)} ms`
    } else {
      gpuLine = 'gpu pass    : (warming up)'
    }
  }

  return [
    `fps         : ${s1.fps} (1s)   ${s30.fps} (30s)`,
    `frame ms    : avg ${s1.avg.toFixed(1)} max ${s1.max.toFixed(1)} p95 ${s1.p95.toFixed(1)}`,
    `slow >33ms  : ${state.totalSlowFrames}`,
    gpuLine,
    `heap MB     : ${heapMB} (peak ${state.peaks.heapMB})`,
    `runtime     : ${((performance.now() - state.startMs) / 1000).toFixed(1)} s`,
  ].join('\n')
}

function renderTiles(state: InspectorState, map: XGISMap | undefined): string {
  if (!map?.vtSources) return '(no map)'
  const lines: string[] = []
  for (const [name, { renderer }] of map.vtSources) {
    const r = renderer as VTRDiag
    const ds = r.getDrawStats?.() ?? { tilesVisible: 0, drawCalls: 0, missedTiles: 0 } as VTRStats
    if (ds.tilesVisible > state.peaks.tilesVisible) state.peaks.tilesVisible = ds.tilesVisible
    if (ds.drawCalls > state.peaks.drawCalls) state.peaks.drawCalls = ds.drawCalls
    if (ds.missedTiles > state.peaks.missedTiles) state.peaks.missedTiles = ds.missedTiles
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cat = r.source as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const backend = cat?.backends?.[0] as any
    lines.push(`── ${name} ──`)
    lines.push(`tilesVis     : ${ds.tilesVisible} (peak ${state.peaks.tilesVisible})`)
    lines.push(`drawCalls    : ${ds.drawCalls} (peak ${state.peaks.drawCalls})`)
    lines.push(`missed       : ${ds.missedTiles} (peak ${state.peaks.missedTiles})`)
    lines.push(`triangles    : ${ds.triangles ?? 0}`)
    lines.push(`lines        : ${ds.lines ?? 0}`)
    lines.push(`gpu cache    : ${r.getCacheSize?.() ?? '?'}`)
    lines.push(`pending up   : ${r.getPendingUploadCount?.() ?? 0}`)
    if (cat) {
      lines.push(`catalog cache: ${cat.dataCache?.size ?? 0}  bytes ${fmtMB(cat._cachedBytes ?? 0)}`)
      lines.push(`loadingTiles : ${cat.loadingTiles?.size ?? 0}`)
      lines.push(`prefetchKeys : ${cat._prefetchKeys?.size ?? 0}  age ${cat._prefetchAge ?? 0}`)
      lines.push(`evictShield  : ${cat._evictShield?.size ?? 0}`)
    }
    if (backend) {
      lines.push(`abort ctrls  : ${backend.abortControllers?.size ?? 0}`)
      lines.push(`pendingMvt   : ${backend.pendingMvt?.length ?? 0}`)
      lines.push(`failedKeys   : ${backend.failedKeys?.size ?? 0}`)
    }
  }
  return lines.join('\n')
}

function renderGPU(_state: InspectorState, map: XGISMap | undefined): string {
  if (!map?.vtSources) return '(no map)'
  const lines: string[] = []
  const ctx = map.ctx
  if (ctx?.adapter || ctx?.device) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ad = ctx.adapter as any
    const features: string[] = []
    if (ctx.device?.features) {
      for (const f of ctx.device.features as Set<string>) features.push(f)
    }
    lines.push(`adapter      : ${ad?.info?.vendor ?? '?'} / ${ad?.info?.device ?? ad?.info?.architecture ?? '?'}`)
    lines.push(`timestamp-q  : ${ctx.timestampQuerySupported ? 'yes' : 'no'}`)
    lines.push(`features     : ${features.length ? features.slice(0, 4).join(', ') + (features.length > 4 ? '…' : '') : '(none enabled)'}`)
    lines.push('')
  }
  for (const [name, { renderer }] of map.vtSources) {
    const r = renderer as VTRDiag
    lines.push(`── ${name} ──`)
    if (r._bufferPool) {
      let totalPooled = 0, totalBytes = 0
      const buckets: { key: string; n: number; bytes: number }[] = []
      for (const [key, arr] of r._bufferPool) {
        let bytes = 0
        for (const b of arr) bytes += b.size
        totalPooled += arr.length
        totalBytes += bytes
        buckets.push({ key, n: arr.length, bytes })
      }
      buckets.sort((a, b) => b.bytes - a.bytes)
      lines.push(`buffer pool  : ${totalPooled} bufs  ${fmtMB(totalBytes)}`)
      for (const b of buckets.slice(0, 4)) {
        const [size, usage] = b.key.split(':')
        lines.push(`  bucket ${parseInt(size, 10) >= 1048576 ? (parseInt(size, 10) / 1048576).toFixed(1) + 'M' : (parseInt(size, 10) / 1024).toFixed(0) + 'K'} usage=${usage} : ${b.n} bufs  ${fmtMB(b.bytes)}`)
      }
    }
    if (r.gpuCache) {
      let total = 0, layers = 0
      for (const inner of r.gpuCache.values()) { total += inner.size; layers++ }
      lines.push(`gpu tiles    : ${total} across ${layers} layers`)
    }
  }
  return lines.join('\n')
}

function renderCache(state: InspectorState): string {
  const c = state.cache
  const ratio = (h: number, m: number): string =>
    h + m === 0 ? '   n/a' : `${(100 * h / (h + m)).toFixed(1).padStart(5)}%`
  return [
    'hasTileData  : ' + ratio(c.hasTileDataHits, c.hasTileDataMisses) +
      `  (${c.hasTileDataHits} h / ${c.hasTileDataMisses} m)`,
    'bufferPool   : ' + ratio(c.bufferPoolHits, c.bufferPoolMisses) +
      `  (${c.bufferPoolHits} h / ${c.bufferPoolMisses} m)`,
    'gpuUpload    : ' + ratio(c.gpuCacheUploadHits, c.gpuCacheUploadMisses) +
      `  (${c.gpuCacheUploadHits} h / ${c.gpuCacheUploadMisses} m)`,
    '',
    `fetch starts : ${c.fetchStarts}`,
    `fetch aborts : ${c.fetchAborts}`,
    `abort ratio  : ${c.fetchStarts > 0 ? (100 * c.fetchAborts / c.fetchStarts).toFixed(1) + '%' : 'n/a'}`,
  ].join('\n')
}

function renderCamera(_state: InspectorState, map: XGISMap | undefined): string {
  if (!map?.camera) return '(no map)'
  const cam = map.camera
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = cam as any
  // mercator → lat/lon
  const R = 6378137
  const lon = (cam.centerX / R) * (180 / Math.PI)
  const lat = (2 * Math.atan(Math.exp(cam.centerY / R)) - Math.PI / 2) * (180 / Math.PI)

  const lines: string[] = [
    `zoom        : ${cam.zoom.toFixed(3)}`,
    `lat / lon   : ${lat.toFixed(5)}, ${lon.toFixed(5)}`,
    `pitch       : ${(c.pitch ?? 0).toFixed(1)}°`,
    `bearing     : ${(c.bearing ?? 0).toFixed(1)}°`,
    `centerX/Y   : ${cam.centerX.toFixed(0)} / ${cam.centerY.toFixed(0)} m`,
  ]
  if (map.vtSources) {
    for (const [name, { renderer }] of map.vtSources) {
      const r = renderer as VTRDiag
      lines.push(`── ${name} ──`)
      lines.push(`hysteresisZ : ${r._hysteresisZ ?? '?'}`)
      const pa = r._czPendingAdvance
      if (pa) {
        const elapsed = performance.now() - pa.since
        lines.push(`pending adv : target=${pa.target} elapsed=${elapsed.toFixed(0)}ms`)
      } else {
        lines.push('pending adv : (none)')
      }
      const moveAt = r._lastCamMoveAt
      if (moveAt !== undefined) {
        const sinceMove = performance.now() - moveAt
        lines.push(`idle        : ${sinceMove > 200 ? 'yes' : 'no'} (${sinceMove.toFixed(0)}ms since move)`)
      }
    }
  }
  return lines.join('\n')
}

function renderNet(state: InspectorState): string {
  return [
    `fetch starts : ${state.cache.fetchStarts}`,
    `fetch aborts : ${state.cache.fetchAborts}`,
    `abort ratio  : ${state.cache.fetchStarts > 0
      ? (100 * state.cache.fetchAborts / state.cache.fetchStarts).toFixed(1) + '%'
      : 'n/a'}`,
    '',
    'Tip: a high abort ratio during gestures means the gate /',
    'cancelStale is doing its job — but lots of fetch starts +',
    'lots of aborts means the work isn\'t free even if it never',
    'completes. Reduce fetch starts to actually drop the load.',
  ].join('\n')
}

function collectAllTabsAsText(state: InspectorState): string {
  const map = (window as unknown as { __xgisMap?: XGISMap }).__xgisMap
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '?'
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1
  const url = typeof location !== 'undefined' ? location.href : '?'
  const ts = new Date().toISOString()

  const sections: string[] = []
  sections.push('═══ X-GIS Inspector report ═══')
  sections.push(`captured  : ${ts}`)
  sections.push(`url       : ${url}`)
  sections.push(`ua        : ${ua}`)
  sections.push(`viewport  : ${window.innerWidth}×${window.innerHeight}  dpr ${dpr}`)
  sections.push(`runtime   : ${((performance.now() - state.startMs) / 1000).toFixed(1)} s`)
  sections.push('')
  sections.push('── Frame ──')
  sections.push(renderFrame(state, map))
  sections.push('')
  sections.push('── Tiles ──')
  sections.push(renderTiles(state, map))
  sections.push('')
  sections.push('── GPU ──')
  sections.push(renderGPU(state, map))
  sections.push('')
  sections.push('── Cache ──')
  sections.push(renderCache(state))
  sections.push('')
  sections.push('── Camera ──')
  sections.push(renderCamera(state, map))
  sections.push('')
  sections.push('── Net ──')
  sections.push(renderNet(state))
  return sections.join('\n')
}

function fmtMB(bytes: number): string {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB'
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return bytes + ' B'
}

// ─── Telemetry: monkey-patch hot-path methods so the Cache + Net
//   tabs can show hit/miss ratios without modifying production code.
//   Patching is delayed by 1 s so the runtime has time to construct
//   its sources/backends; if the user never opens the inspector
//   tabs that show these numbers, the patches are still cheap (one
//   extra property access per call).

function installCacheTelemetry(stats: CacheStats): void {
  setTimeout(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = (window as any).__xgisMap as XGISMap | undefined
    if (!map?.vtSources) {
      // try again in 500 ms; the map might still be initialising.
      setTimeout(() => installCacheTelemetry(stats), 500)
      return
    }
    for (const { renderer } of map.vtSources.values()) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = renderer as any
      if (r.__xgisInspectorPatched) continue
      r.__xgisInspectorPatched = true

      // catalog.hasTileData
      const cat = r.source
      if (cat?.hasTileData) {
        const orig = cat.hasTileData.bind(cat)
        cat.hasTileData = (k: number, l?: string): boolean => {
          const v: boolean = orig(k, l)
          if (v) stats.hasTileDataHits++; else stats.hasTileDataMisses++
          return v
        }
      }
      // VTR.acquireBuffer
      if (typeof r.acquireBuffer === 'function') {
        const orig = r.acquireBuffer.bind(r)
        r.acquireBuffer = (size: number, usage: number, label: string): GPUBuffer => {
          let bucket = 2048
          while (bucket < size) bucket *= 2
          const key = `${bucket}:${usage}`
          const pool = r._bufferPool?.get?.(key) as GPUBuffer[] | undefined
          if (pool && pool.length > 0) stats.bufferPoolHits++
          else stats.bufferPoolMisses++
          return orig(size, usage, label)
        }
      }
      // VTR.doUploadTile — counts hits when the gpu cache already has
      // the (key, layer) pair (a re-upload skip).
      if (typeof r.doUploadTile === 'function') {
        const orig = r.doUploadTile.bind(r)
        r.doUploadTile = (key: number, data: unknown, sourceLayer = ''): unknown => {
          const inner = r.gpuCache?.get?.(sourceLayer) as Map<number, unknown> | undefined
          if (inner?.has?.(key)) stats.gpuCacheUploadHits++
          else stats.gpuCacheUploadMisses++
          return orig(key, data, sourceLayer)
        }
      }
      // PMTilesBackend.loadTile + abortControllers — count fetch
      // starts / aborts.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const backend = cat?.backends?.[0] as any
      if (backend?.loadTile) {
        const orig = backend.loadTile.bind(backend)
        backend.loadTile = (key: number): void => {
          const before = backend.abortControllers?.size ?? 0
          orig(key)
          const after = backend.abortControllers?.size ?? 0
          if (after > before) stats.fetchStarts++
        }
      }
      if (backend?.cancelStale) {
        const orig = backend.cancelStale.bind(backend)
        backend.cancelStale = (active: Set<number>): void => {
          const before = backend.abortControllers?.size ?? 0
          // count aborts: anything in the map not in `active` whose
          // signal isn't already aborted.
          let willAbort = 0
          if (backend.abortControllers) {
            for (const [k, ac] of backend.abortControllers as Map<number, AbortController>) {
              if (!active.has(k) && !ac.signal.aborted) willAbort++
            }
          }
          stats.fetchAborts += willAbort
          orig(active)
          void before
        }
      }
    }
  }, 1000)
}
