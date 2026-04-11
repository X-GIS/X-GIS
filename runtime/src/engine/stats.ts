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
  }

  destroy(): void {
    this.el.remove()
  }
}
