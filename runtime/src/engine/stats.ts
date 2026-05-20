// ═══ Rendering Stats Inspector ═══
// Tracks per-frame GPU rendering metrics, similar to Three.js stats panel.

export interface RenderStats {
  fps: number
  frameTime: number       // ms
  drawCalls: number
  vertices: number
  triangles: number
  lines: number
  tilesVisible: number
  tilesLoaded: number
  tilesCached: number
  gpuBuffers: number
  zoom: number
  /** iter-222 — RenderBundle cache stats (Phase RB.B follow-up).
   *  Aggregated across all BundleCache instances (VTR + bg).
   *  hits = `executeBundles` replay of a previously-encoded
   *  bundle; misses = encode required because cache key changed
   *  or first encounter. At idle camera with stable tile set,
   *  hits dominate (cache key includes tile-keys hash +
   *  _gpuCacheCount — no churn means same key). */
  bundleHits: number
  bundleMisses: number
  /** Hit rate over the lifetime of the BundleCache instances (NOT
   *  per-frame). Use as a steady-state indicator. */
  bundleHitRate: number
  /** iter-228 — Lifetime count of LRU evictions across all
   *  BundleCache instances. Bumps when the cap (default 1024) is
   *  hit on a miss-insert; a stable `> 0` value with hitRate still
   *  high indicates a healthy cache + cap pair. A run-away
   *  increase under pan/zoom flags cap pressure (consider raising
   *  the cap). */
  bundleEvictions: number
  /** iter-229 — `pass.executeBundles([b])` calls this frame
   *  (delta of lifetime bundleHits + bundleMisses). The actual
   *  GPU API-call count for the bundle path; pair with the
   *  logical `drawCalls` field to see the reduction ratio
   *  (e.g. drawCalls=270, bundleReplays=5 → 54× CPU reduction
   *  on this axis). */
  bundleReplaysThisFrame: number
}

export class StatsTracker {
  // Accumulate per frame
  drawCalls = 0
  vertices = 0
  triangles = 0
  lines = 0
  tilesVisible = 0
  tilesLoaded = 0
  tilesCached = 0
  gpuBuffers = 0
  zoom = 0
  /** iter-222 — bundle stats. Lifetime counters (NOT per-frame
   *  reset). Aggregated across all BundleCache instances. */
  bundleHits = 0
  bundleMisses = 0
  /** iter-228 — LRU evictions (lifetime). See `RenderStats.bundleEvictions`. */
  bundleEvictions = 0
  /** iter-229 — Bundle replays during the most recent frame.
   *  Computed as the delta of (bundleHits + bundleMisses) at
   *  `endFrame()`, which gives the exact number of `executeBundles`
   *  calls that fired this frame. Every cache hit AND miss path
   *  calls `executeBundles([b])` (the miss path encodes + then
   *  replays), so the sum delta is the per-frame API-call count
   *  without any new bumps at the render sites. */
  bundleReplaysThisFrame = 0
  private _prevBundleTotal = 0

  // FPS tracking
  private frames = 0
  private lastTime = performance.now()
  private fps = 0
  private frameTime = 0
  private lastFrameStart = 0

  /** Call at the start of each frame */
  beginFrame(): void {
    this.lastFrameStart = performance.now()
    this.drawCalls = 0
    this.vertices = 0
    this.triangles = 0
    this.lines = 0
    this.tilesVisible = 0
    this.tilesLoaded = 0
    this.tilesCached = 0
    this.gpuBuffers = 0
  }

  /** Call at the end of each frame */
  endFrame(): void {
    this.frameTime = performance.now() - this.lastFrameStart
    this.frames++
    const now = performance.now()
    if (now - this.lastTime >= 1000) {
      this.fps = Math.round(this.frames * 1000 / (now - this.lastTime))
      this.frames = 0
      this.lastTime = now
    }
    // iter-229 — per-frame `executeBundles` call count, derived
    // from the lifetime hits + misses delta. map.ts populates
    // bundleHits + bundleMisses just before calling endFrame.
    const total = this.bundleHits + this.bundleMisses
    this.bundleReplaysThisFrame = total - this._prevBundleTotal
    this._prevBundleTotal = total
  }

  /** Record a draw call */
  addDraw(vertexCount: number, isTriangles: boolean): void {
    this.drawCalls++
    this.vertices += vertexCount
    if (isTriangles) {
      this.triangles += Math.floor(vertexCount / 3)
    } else {
      this.lines += Math.floor(vertexCount / 2)
    }
  }

  /** Get current snapshot */
  get(): RenderStats {
    const total = this.bundleHits + this.bundleMisses
    return {
      fps: this.fps,
      frameTime: this.frameTime,
      drawCalls: this.drawCalls,
      vertices: this.vertices,
      triangles: this.triangles,
      lines: this.lines,
      tilesVisible: this.tilesVisible,
      tilesLoaded: this.tilesLoaded,
      tilesCached: this.tilesCached,
      gpuBuffers: this.gpuBuffers,
      zoom: this.zoom,
      bundleHits: this.bundleHits,
      bundleMisses: this.bundleMisses,
      bundleHitRate: total > 0 ? this.bundleHits / total : 0,
      bundleEvictions: this.bundleEvictions,
      bundleReplaysThisFrame: this.bundleReplaysThisFrame,
    }
  }
}

/**
 * Stats panel UI overlay.
 * Attach to a container element to display real-time rendering stats.
 */
export class StatsPanel {
  private el: HTMLDivElement
  private rows: Map<string, HTMLSpanElement> = new Map()
  private visible = true

  constructor(container: HTMLElement = document.body) {
    this.el = document.createElement('div')
    this.el.style.cssText = `
      position:fixed; top:48px; left:12px; z-index:100;
      background:rgba(0,0,0,0.82); backdrop-filter:blur(8px);
      border:1px solid #1e1e2e; border-radius:8px;
      padding:8px 12px; min-width:180px;
      font:11px/1.6 'SF Mono','Fira Code',monospace;
      color:#aaa; user-select:none;
      transition: opacity 0.2s;
    `

    const header = document.createElement('div')
    header.style.cssText = 'font-size:10px;color:#555;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;cursor:pointer;'
    header.textContent = 'Inspector'
    header.addEventListener('click', () => this.toggle())
    this.el.appendChild(header)

    const fields = [
      ['fps', 'FPS'],
      ['frameTime', 'Frame'],
      ['drawCalls', 'Draws'],
      ['vertices', 'Vertices'],
      ['triangles', 'Triangles'],
      ['lines', 'Lines'],
      ['zoom', 'Zoom'],
      ['tilesVisible', 'Tiles Vis'],
      ['tilesCached', 'Tiles Cache'],
      // iter-223 — RenderBundle cache visibility. `Bundle` shows
      // hits + hit-rate so users see when the bundle path is paying
      // off (idle camera → rate → 1.0) vs invalidating (pan/zoom →
      // rate dropping).
      ['bundle', 'Bundle'],
      // iter-229 — Per-frame `pass.executeBundles` call count.
      // Paired with `drawCalls` for ratio inspection: drawCalls
      // is logical-per-axis; bundleCalls is actual-API. At idle
      // bundleCalls collapses to the (slice × phase) count.
      ['bundleCalls', 'Bundle/f'],
    ]

    for (const [key, label] of fields) {
      const row = document.createElement('div')
      row.style.cssText = 'display:flex;justify-content:space-between;gap:16px;'

      const labelEl = document.createElement('span')
      labelEl.style.color = '#666'
      labelEl.textContent = label

      const valueEl = document.createElement('span')
      valueEl.style.color = '#ccc'
      valueEl.textContent = '—'

      row.appendChild(labelEl)
      row.appendChild(valueEl)
      this.el.appendChild(row)
      this.rows.set(key, valueEl)
    }

    container.appendChild(this.el)
  }

  toggle(): void {
    this.visible = !this.visible
    const content = this.el.querySelectorAll('div:not(:first-child)') as NodeListOf<HTMLDivElement>
    content.forEach(el => el.style.display = this.visible ? '' : 'none')
  }

  update(stats: RenderStats): void {
    this.rows.get('fps')!.textContent = String(stats.fps)
    this.rows.get('fps')!.style.color = stats.fps >= 55 ? '#4ade80' : stats.fps >= 30 ? '#facc15' : '#ef4444'
    this.rows.get('frameTime')!.textContent = stats.frameTime.toFixed(1) + ' ms'
    this.rows.get('drawCalls')!.textContent = String(stats.drawCalls)
    this.rows.get('vertices')!.textContent = stats.vertices.toLocaleString()
    this.rows.get('triangles')!.textContent = stats.triangles.toLocaleString()
    this.rows.get('lines')!.textContent = stats.lines.toLocaleString()
    this.rows.get('zoom')!.textContent = stats.zoom.toFixed(1)
    this.rows.get('tilesVisible')!.textContent = String(stats.tilesVisible)
    this.rows.get('tilesCached')!.textContent = String(stats.tilesCached)
    // iter-223 — `bundle` row: "hits (rate%)" format. At idle the
    // hit-rate should approach 100 %; pan/zoom drops it.
    // iter-228 — append " ev:N" when LRU evictions have fired so
    // users can see cap pressure without needing a separate row.
    const bundleRow = this.rows.get('bundle')
    if (bundleRow) {
      const total = stats.bundleHits + stats.bundleMisses
      if (total === 0) {
        bundleRow.textContent = '—'
      } else {
        const ratePct = (stats.bundleHitRate * 100).toFixed(0)
        const ev = stats.bundleEvictions
        bundleRow.textContent = ev > 0
          ? `${stats.bundleHits} (${ratePct}%) ev:${ev}`
          : `${stats.bundleHits} (${ratePct}%)`
        bundleRow.style.color = stats.bundleHitRate >= 0.8 ? '#4ade80'
          : stats.bundleHitRate >= 0.5 ? '#facc15' : '#ef4444'
      }
    }
    // iter-229 — Bundle calls per frame. At idle on the bundled
    // path this should be small (1 per phase per slice) regardless
    // of how many logical draws each replays.
    const bundleCallsRow = this.rows.get('bundleCalls')
    if (bundleCallsRow) {
      bundleCallsRow.textContent = String(stats.bundleReplaysThisFrame)
    }
  }

  destroy(): void {
    this.el.remove()
  }
}
