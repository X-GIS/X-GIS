// ═══ X-GIS Map — 전체를 연결하는 엔트리포인트 ═══

import { Lexer, Parser, lower, optimize, emitCommands, evaluate, compileGeoJSONToTiles, decomposeFeatures } from '@xgis/compiler'
import { deserializeXGB } from '../../../compiler/src/binary/format'
import { initGPU, resizeCanvas, type GPUContext } from './gpu'
import { Camera } from './camera'
import { MapRenderer } from './renderer'
import { interpret, type SceneCommands } from './interpreter'
import { loadGeoJSON, lonLatToMercator, type GeoJSONFeatureCollection } from '../loader/geojson'
import { isTileTemplate } from '../loader/tiles'
import { RasterRenderer } from './raster-renderer'
import { PanZoomController, type Controller } from './controller'
import { CanvasRenderer } from './canvas-renderer'
import { VectorTileRenderer } from './vector-tile-renderer'
import { XGVTSource } from '../data/xgvt-source'
import { StatsTracker, StatsPanel, type RenderStats } from './stats'
// reprojector.ts preserved for future tile-coordinate RTT approach

export class XGISMap {
  private ctx!: GPUContext
  private camera: Camera
  private renderer!: MapRenderer
  private rasterRenderer!: RasterRenderer
  private running = false
  private projectionName = 'mercator'
  private controller: Controller | null = null

  // Canvas 2D fallback
  private canvasRenderer: CanvasRenderer | null = null
  private useCanvas2D = false

  // Vector tile sources + renderers (per .xgvt source)
  private vtSources = new Map<string, { source: XGVTSource; renderer: VectorTileRenderer }>()
  private vectorTileShows: { sourceName: string; show: SceneCommands['shows'][0]; pipelines: { fillPipeline: GPURenderPipeline; linePipeline: GPURenderPipeline; fillPipelineFallback: GPURenderPipeline; linePipelineFallback: GPURenderPipeline } | null; layout: GPUBindGroupLayout | null }[] = []
  private vtVariantPipelines: { fillPipeline: GPURenderPipeline; linePipeline: GPURenderPipeline } | null = null
  private vtVariantLayout: GPUBindGroupLayout | null = null

  // Raw data for re-projection
  private rawDatasets = new Map<string, GeoJSONFeatureCollection>()
  private showCommands: SceneCommands['shows'] = []

  // Stencil buffer for tile overlap masking
  private stencilTexture: GPUTexture | null = null
  private stencilWidth = 0
  private stencilHeight = 0

  // MSAA 4x render target
  private msaaTexture: GPUTexture | null = null
  private msaaWidth = 0
  private msaaHeight = 0


  private _frameCount = 0
  private _vtDebugLogged = false

  // Stats inspector
  private _stats = new StatsTracker()
  private _statsPanel: StatsPanel | null = null

  constructor(private canvas: HTMLCanvasElement) {
    this.camera = new Camera(0, 20, 2)
  }

  /** Get current rendering stats */
  get stats(): RenderStats { return this._stats.get() }

  /** Show/hide the stats inspector panel */
  showInspector(show = true): void {
    if (show && !this._statsPanel) {
      this._statsPanel = new StatsPanel()
    } else if (!show && this._statsPanel) {
      this._statsPanel.destroy()
      this._statsPanel = null
    }
  }

  /** Change projection at runtime — GPU uniform only, no re-tessellation! */
  setProjection(name: string): void {
    const prevProj = this.projectionName
    this.projectionName = name

    // Adjust zoom for different projection scale
    // Globe projections (ortho/azimuthal/stereo) need wider view
    const isGlobe = (n: string) => ['orthographic', 'azimuthal_equidistant', 'stereographic'].includes(n)
    if (!isGlobe(prevProj) && isGlobe(name)) {
      this.camera.zoom = Math.min(this.camera.zoom, 1.5)
    } else if (isGlobe(prevProj) && !isGlobe(name)) {
      this.camera.zoom = Math.max(this.camera.zoom, 1.5)
    }
  }

  getProjectionName(): string {
    return this.projectionName
  }

  private switchController(): void {
    this.controller?.detach()
    // Always PanZoom — panning moves camera = projection center moves
    // All projections center on camera position via GPU shader
    this.controller = new PanZoomController()
    this.controller.attach(this.canvas, this.camera, () => ({
      projectionName: this.projectionName,
    }))
  }

  /** Load and run an X-GIS program */
  async run(source: string, baseUrl = ''): Promise<void> {
    // 1. Parse → IR → Commands
    const tokens = new Lexer(source).tokenize()
    const ast = new Parser(tokens).parse()

    // Use IR pipeline for new syntax, fallback to legacy interpreter
    const hasNewSyntax = ast.body.some(s => s.kind === 'SourceStatement' || s.kind === 'LayerStatement')
    const commands = hasNewSyntax
      ? emitCommands(optimize(lower(ast), ast))
      : interpret(ast)

    console.log('[X-GIS] Parsed:', commands.loads.length, 'loads,', commands.shows.length, 'shows')


    // 2. Init GPU (fallback to Canvas 2D)
    try {
      this.ctx = await initGPU(this.canvas)
      this.renderer = new MapRenderer(this.ctx)
      this.rasterRenderer = new RasterRenderer(this.ctx)
      // VT sources/renderers created per .xgvt file in the load loop
      this.useCanvas2D = false
    } catch (err) {
      console.warn('[X-GIS] WebGPU unavailable, falling back to Canvas 2D:', (err as Error).message)
      this.canvasRenderer = new CanvasRenderer(this.canvas)
      this.useCanvas2D = true
    }


    // 3. Load data
    for (const load of commands.loads) {
      const url = load.url.startsWith('http') || load.url.startsWith('/') ? load.url : baseUrl + load.url
      console.log(`[X-GIS] Loading: ${load.name} from ${url}`)

      if (isTileTemplate(url)) {
        this.rawDatasets.set(load.name, { _tileUrl: url } as unknown as GeoJSONFeatureCollection)
        if (!this.useCanvas2D) {
          this.rasterRenderer.setUrlTemplate(url)
        }
      } else if (url.endsWith('.xgvt') && !this.useCanvas2D) {
        // Vector tile file — create per-source XGVTSource + VectorTileRenderer
        const source = new XGVTSource()
        const vtRenderer = new VectorTileRenderer(this.ctx)
        vtRenderer.setBindGroupLayout(this.renderer.bindGroupLayout) // must be set before any tile uploads
        vtRenderer.setSource(source) // connect before load so preloaded tiles auto-upload
        const fullUrl = url.startsWith('http') ? url : new URL(url, location.href).href
        try {
          await source.loadFromURL(fullUrl)
        } catch {
          const vtResponse = await fetch(url)
          const vtBuf = await vtResponse.arrayBuffer()
          await source.loadFromBuffer(vtBuf)
        }
        this.vtSources.set(load.name, { source, renderer: vtRenderer })
        this.rawDatasets.set(load.name, { _vectorTile: true } as unknown as GeoJSONFeatureCollection)

        // Fit camera to vector tile bounds
        const vtBounds = vtRenderer.getBounds()
        if (vtBounds) {
          const [minLon, minLat, maxLon, maxLat] = vtBounds
          const clampedLat = Math.max(-85, Math.min(85, (minLat + maxLat) / 2))
          const [cx, cy] = lonLatToMercator((minLon + maxLon) / 2, clampedLat)
          this.camera.centerX = cx
          this.camera.centerY = cy
          const lonSpan = maxLon - minLon
          const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
          const cssW = this.canvas.width / dpr
          const degPerPx = lonSpan / cssW
          this.camera.zoom = Math.max(0.5, Math.log2(360 / (degPerPx * 256)) - 1)
        }
      } else {
        const response = await fetch(url)
        const data = await response.json() as GeoJSONFeatureCollection
        this.rawDatasets.set(load.name, data)
      }
    }

    this.showCommands = commands.shows


    // 4. Build render layers + fit camera
    if (this.useCanvas2D) {
      this.rebuildLayersCanvas2D()
    } else {
      this.rebuildLayers()
    }

    // 5. Setup controller
    this.switchController()

    // 6. Start render loop
    this.running = true
    if (this.useCanvas2D) {
      this.renderLoopCanvas2D()
    } else {
      this.renderLoop()
    }

    console.log(`[X-GIS] Map running (${this.useCanvas2D ? 'Canvas 2D fallback' : 'WebGPU'})`)
  }

  /** Rebuild GPU layers from raw data with current projection */
  private rebuildLayers(): void {
    // Now projection-agnostic: vertices are raw lon/lat degrees
    // GPU vertex shader applies projection via uniform
    this.renderer.clearLayers()
    this.vectorTileShows = []

    for (const show of this.showCommands) {
      const data = this.rawDatasets.get(show.targetName)
      if (!data) continue

      // Skip raster tile sources (handled by rasterRenderer)
      if ((data as unknown as { _tileUrl?: string })._tileUrl) continue

      // Skip vector tile sources loaded from .xgvt files
      if ((data as unknown as { _vectorTile?: boolean })._vectorTile) {
        const vtEntry = this.vtSources.get(show.targetName)
        if (!vtEntry) continue

        let pipelines: typeof this.vtVariantPipelines = null
        let layout: GPUBindGroupLayout | null = null

        const variant = show.shaderVariant
        if (variant && (variant.preamble || variant.needsFeatureBuffer)) {
          try {
            pipelines = this.renderer.getOrCreateVariantPipelines(variant as any)
            layout = variant.needsFeatureBuffer
              ? this.renderer.featureBindGroupLayout
              : this.renderer.bindGroupLayout
            if (variant.needsFeatureBuffer && !vtEntry.renderer.hasFeatureData()) {
              vtEntry.renderer.buildFeatureDataBuffer(variant as any, layout)
            }
          } catch (e) {
            console.warn('[X-GIS] VT variant pipeline failed:', e)
          }
        }

        this.vectorTileShows.push({ sourceName: show.targetName, show, pipelines, layout })
        continue
      }

      // GeoJSON → in-memory tiling → VectorTileRenderer
      // Each layer gets its own key: reuse source if no filter, separate if filtered
      const hasFilter = !!show.filterExpr
      const vtKey = hasFilter ? `${show.targetName}__${this.vectorTileShows.length}` : show.targetName

      // Reuse existing VT source if same key (same source, no filter)
      if (this.vtSources.has(vtKey)) {
        const vtEntry = this.vtSources.get(vtKey)!
        let pipelines: typeof this.vtVariantPipelines = null
        let layout: GPUBindGroupLayout | null = null
        const variant = show.shaderVariant
        if (variant && (variant.preamble || variant.needsFeatureBuffer)) {
          try {
            pipelines = this.renderer.getOrCreateVariantPipelines(variant as any)
            layout = variant.needsFeatureBuffer
              ? this.renderer.featureBindGroupLayout : this.renderer.bindGroupLayout
            if (variant.needsFeatureBuffer && !vtEntry.renderer.hasFeatureData()) {
              vtEntry.renderer.buildFeatureDataBuffer(variant as any, layout)
            }
          } catch (e) { console.warn('[X-GIS] VT variant pipeline failed:', e) }
        }
        this.vectorTileShows.push({ sourceName: vtKey, show, pipelines, layout })
        continue
      }

      const filtered = applyFilter(data, show.filterExpr)

      const source = new XGVTSource()
      const vtRenderer = new VectorTileRenderer(this.ctx)
      vtRenderer.setBindGroupLayout(this.renderer.bindGroupLayout)
      vtRenderer.setSource(source)
      this.vtSources.set(vtKey, { source, renderer: vtRenderer })

      // On-demand tiling: compile z0 immediately, higher zooms on demand
      // when the renderer requests visible tiles
      const parts = decomposeFeatures(filtered.features)
      const z0Set = compileGeoJSONToTiles(filtered, { minZoom: 0, maxZoom: 0 })
      source.addTileLevel(z0Set.levels[0], z0Set.bounds, z0Set.propertyTable)
      source.setRawParts(parts, z0Set.levels.length > 0 ? 7 : 0)

      // Fit camera
      const [minLon, minLat, maxLon, maxLat] = z0Set.bounds
      if (minLon < Infinity) {
        const clampedLat = Math.max(-85, Math.min(85, (minLat + maxLat) / 2))
        const [cx, cy] = lonLatToMercator((minLon + maxLon) / 2, clampedLat)
        this.camera.centerX = cx
        this.camera.centerY = cy
        const lonSpan = maxLon - minLon
        const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
        const cssW = this.canvas.width / dpr
        const degPerPx = lonSpan / cssW
        this.camera.zoom = Math.max(0.5, Math.log2(360 / (degPerPx * 256)) - 1)
      }

      // Setup shader variant if needed
      let pipelines: typeof this.vtVariantPipelines = null
      let layout: GPUBindGroupLayout | null = null
      const variant = show.shaderVariant
      if (variant && (variant.preamble || variant.needsFeatureBuffer)) {
        try {
          pipelines = this.renderer.getOrCreateVariantPipelines(variant as any)
          layout = variant.needsFeatureBuffer
            ? this.renderer.featureBindGroupLayout
            : this.renderer.bindGroupLayout
          if (variant.needsFeatureBuffer && !vtRenderer.hasFeatureData()) {
            vtRenderer.buildFeatureDataBuffer(variant as any, layout)
          }
        } catch (e) {
          console.warn('[X-GIS] GeoJSON VT variant pipeline failed:', e)
        }
      }
      this.vectorTileShows.push({ sourceName: vtKey, show, pipelines, layout })
    }

    console.log(`[X-GIS] Rebuilt layers (GPU projection: ${this.projectionName})`)
  }

  /** Build layers for Canvas 2D fallback */
  private rebuildLayersCanvas2D(): void {
    if (!this.canvasRenderer) return

    for (const show of this.showCommands) {
      const data = this.rawDatasets.get(show.targetName)
      if (!data) continue

      const isTile = (data as unknown as { _tileUrl?: string })._tileUrl
      if (isTile) {
        this.canvasRenderer.addLayer(show, null, isTile as string)
      } else {
        const filtered = applyFilter(data, show.filterExpr)
        this.canvasRenderer.addLayer(show, filtered, null)

        // Fit camera to data bounds
        if (data.features?.length) {
          let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
          for (const f of data.features) {
            if (!f.geometry) continue
            const coords = JSON.stringify(f.geometry.coordinates)
            const nums = coords.match(/-?\d+\.?\d*/g)?.map(Number) ?? []
            for (let i = 0; i < nums.length - 1; i += 2) {
              const lon = nums[i], lat = nums[i + 1]
              if (Math.abs(lon) <= 180 && Math.abs(lat) <= 90) {
                minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon)
                minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat)
              }
            }
          }
          if (minLon < Infinity) {
            const [cx, cy] = lonLatToMercator((minLon + maxLon) / 2, (minLat + maxLat) / 2)
            this.camera.centerX = cx
            this.camera.centerY = cy
            const lonSpan = maxLon - minLon
            const degPerPixel = lonSpan / this.canvas.clientWidth
            this.camera.zoom = Math.max(0.5, Math.log2(360 / (degPerPixel * 256)) - 1)
          }
        }
      }
    }
  }

  /** Canvas 2D render loop */
  private renderLoopCanvas2D = (): void => {
    if (!this.running || !this.canvasRenderer) return
    this.canvasRenderer.render(this.camera, this.projectionName)
    requestAnimationFrame(this.renderLoopCanvas2D)
  }

  /** Load and run a pre-compiled .xgb binary */
  async runBinary(buffer: ArrayBuffer, baseUrl = ''): Promise<void> {
    const scene = deserializeXGB(buffer)
    const commands: SceneCommands = { loads: scene.loads, shows: scene.shows }

    console.log('[X-GIS] Binary loaded:', commands.loads.length, 'loads,', commands.shows.length, 'shows')

    this.ctx = await initGPU(this.canvas)
    this.renderer = new MapRenderer(this.ctx)
    this.rasterRenderer = new RasterRenderer(this.ctx)

    for (const load of commands.loads) {
      const url = load.url.startsWith('http') || load.url.startsWith('/') ? load.url : baseUrl + load.url
      const response = await fetch(url)
      const data = await response.json() as GeoJSONFeatureCollection
      this.rawDatasets.set(load.name, data)
    }

    this.showCommands = commands.shows
    this.rebuildLayers()

    this.switchController()
    this.running = true
    this.renderLoop()
    console.log('[X-GIS] Map running (from binary)')
  }

  /** Auto-detect: .xgb binary or .xgis source */
  async load(url: string): Promise<void> {
    const response = await fetch(url)
    const baseUrl = url.substring(0, url.lastIndexOf('/') + 1)

    if (url.endsWith('.xgb')) {
      const buffer = await response.arrayBuffer()
      await this.runBinary(buffer, baseUrl)
    } else {
      const source = await response.text()
      await this.run(source, baseUrl)
    }
  }

  private renderLoop = (): void => {
    if (!this.running) return
    this._stats.beginFrame()
    resizeCanvas(this.ctx)

    const projType = {
      mercator: 0, equirectangular: 1, natural_earth: 2,
      orthographic: 3, azimuthal_equidistant: 4, stereographic: 5,
      oblique_mercator: 6,
    }[this.projectionName] ?? 0
    const { device, context, canvas } = this.ctx
    const w = canvas.width, h = canvas.height
    if (w === 0 || h === 0) { requestAnimationFrame(this.renderLoop); return }

    // Clamp camera Y (latitude bounded), X wraps freely (world repeat)
    const MAX_MERC = 20037508.34
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
    const mpp = (40075016.686 / 256) / Math.pow(2, this.camera.zoom)
    const visHalfY = (h / dpr) * mpp / 2
    const maxY = Math.max(0, MAX_MERC - visHalfY)
    // X: free movement (world wrapping) — no clamping
    this.camera.centerY = Math.max(-maxY, Math.min(maxY, this.camera.centerY))

    // RTC: Camera center IS projection center. Always.
    const R = 6378137
    const centerLon = (this.camera.centerX / R) * (180 / Math.PI)
    const centerLat = Math.max(-85, Math.min(85,
      (2 * Math.atan(Math.exp(this.camera.centerY / R)) - Math.PI / 2) * (180 / Math.PI)
    ))

    const encoder = device.createCommandEncoder()
    const screenView = context.getCurrentTexture().createView()

    {
      // ═══ Direct rendering: vertex shader handles all projections ═══
      // MSAA + stencil texture management (recreate on resize)
      const sc = 4 // MSAA 4x (WebGPU spec guarantees support)
      if (!this.msaaTexture || this.msaaWidth !== w || this.msaaHeight !== h) {
        this.msaaTexture?.destroy()
        this.stencilTexture?.destroy()
        this.msaaTexture = device.createTexture({
          size: { width: w, height: h },
          format: this.ctx.format,
          sampleCount: sc,
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
        })
        this.stencilTexture = device.createTexture({
          size: { width: w, height: h },
          format: 'stencil8',
          sampleCount: sc,
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
        })
        this.msaaWidth = w
        this.msaaHeight = h
        this.stencilWidth = w
        this.stencilHeight = h
      }

      const msaaView = this.msaaTexture!.createView()
      const hasMultiSource = this.vectorTileShows.length > 1
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: msaaView,
          resolveTarget: hasMultiSource ? undefined : screenView, // resolve only on last pass
          clearValue: { r: 0.039, g: 0.039, b: 0.063, a: 1 },
          loadOp: 'clear',
          storeOp: 'store', // keep MSAA data for subsequent VT passes
        }],
        depthStencilAttachment: {
          view: this.stencilTexture!.createView(),
          stencilClearValue: 0,
          stencilLoadOp: 'clear',
          stencilStoreOp: 'discard',
        },
      })

      this.rasterRenderer.render(pass, this.camera, projType, centerLon, centerLat, w, h)
      this.renderer.renderToPass(pass, this.camera, projType, centerLon, centerLat)

      // Render vector tile sources
      if (this.vectorTileShows.length === 1) {
        // Single source: render in existing pass (shared stencil)
        for (const { sourceName, show, pipelines, layout } of this.vectorTileShows) {
          const vtEntry = this.vtSources.get(sourceName)
          if (!vtEntry || !vtEntry.renderer.hasData()) continue
          const fp = pipelines?.fillPipeline ?? this.renderer.fillPipeline
          const lp = pipelines?.linePipeline ?? this.renderer.linePipeline
          const bgl = layout ?? this.renderer.bindGroupLayout
          vtEntry.renderer.render(pass, this.camera, projType, centerLon, centerLat, w, h,
            show, fp, lp, this.renderer.uniformBuffer, bgl,
            pipelines?.fillPipelineFallback ?? this.renderer.fillPipelineFallback,
            pipelines?.linePipelineFallback ?? this.renderer.linePipelineFallback)
        }
      }
      pass.end()

      // Multi-source: separate pass per source (independent stencil clear)
      if (this.vectorTileShows.length > 1) {
        for (let si = 0; si < this.vectorTileShows.length; si++) {
          const { sourceName, show, pipelines, layout } = this.vectorTileShows[si]
          const vtEntry = this.vtSources.get(sourceName)
          if (!vtEntry || !vtEntry.renderer.hasData()) continue
          const fp = pipelines?.fillPipeline ?? this.renderer.fillPipeline
          const lp = pipelines?.linePipeline ?? this.renderer.linePipeline
          const bgl = layout ?? this.renderer.bindGroupLayout
          const isLast = si === this.vectorTileShows.length - 1
          const vtPass = encoder.beginRenderPass({
            colorAttachments: [{
              view: msaaView,
              resolveTarget: isLast ? screenView : undefined, // resolve only on last pass
              loadOp: 'load',
              storeOp: 'store',
            }],
            depthStencilAttachment: {
              view: this.stencilTexture!.createView(),
              stencilClearValue: 0, stencilLoadOp: 'clear', stencilStoreOp: 'discard',
            },
          })
          vtEntry.renderer.render(vtPass, this.camera, projType, centerLon, centerLat, w, h,
            show, fp, lp, this.renderer.uniformBuffer, bgl,
            pipelines?.fillPipelineFallback ?? this.renderer.fillPipelineFallback,
            pipelines?.linePipelineFallback ?? this.renderer.linePipelineFallback)
          vtPass.end()
        }
      }
    }

    device.queue.submit([encoder.finish()])

    // Collect stats from renderers
    this._stats.zoom = this.camera.zoom
    const rs = this.renderer.getDrawStats()
    this._stats.drawCalls = rs.drawCalls
    this._stats.vertices = rs.vertices
    this._stats.triangles = rs.triangles
    this._stats.lines = rs.lines
    let totalTilesVis = 0, totalTilesCached = 0, totalMissed = 0
    for (const [name, { renderer: vtR }] of this.vtSources) {
      if (!vtR.hasData()) continue
      const vts = vtR.getDrawStats()
      this._stats.drawCalls += vts.drawCalls
      this._stats.vertices += vts.vertices
      this._stats.triangles += vts.triangles
      this._stats.lines += vts.lines
      totalTilesVis += vts.tilesVisible
      totalTilesCached += vtR.getCacheSize()
      totalMissed += vts.missedTiles
      if (vts.missedTiles > 0) {
        console.warn(`[FLICKER] ${name}: ${vts.missedTiles} tiles without fallback (z=${Math.round(this.camera.zoom)} gpuCache=${vtR.getCacheSize()})`)
      }
    }
    this._stats.tilesVisible = totalTilesVis
    this._stats.tilesCached = totalTilesCached
    this._stats.endFrame()
    this._statsPanel?.update(this._stats.get())

    requestAnimationFrame(this.renderLoop)
  }

  // ═══ Dynamic Property API ═══

  /** Set a layer property at runtime. Changes apply immediately (next frame). */
  set(path: string, value: unknown): void {
    // path format: "layerName.property" e.g. "world.fill", "world.opacity"
    const dot = path.indexOf('.')
    if (dot < 0) return

    const layerName = path.substring(0, dot)
    const prop = path.substring(dot + 1)
    const layer = this.renderer.getLayer(layerName)
    if (layer) {
      layer.props.set(prop, value)
    }
  }

  /** Get a layer property (current value, including overrides) */
  get(path: string): unknown {
    const dot = path.indexOf('.')
    if (dot < 0) return undefined

    const layerName = path.substring(0, dot)
    const prop = path.substring(dot + 1)
    const layer = this.renderer.getLayer(layerName)
    return layer?.props.get(prop)
  }

  /** Reset a property to its compiled default */
  reset(path: string): void {
    const dot = path.indexOf('.')
    if (dot < 0) return

    const layerName = path.substring(0, dot)
    const prop = path.substring(dot + 1)
    const layer = this.renderer.getLayer(layerName)
    layer?.props.reset(prop)
  }

  /** List all settable properties */
  listProperties(): Record<string, string[]> {
    return this.renderer.listProperties()
  }

  stop(): void {
    this.controller?.detach()
    this.running = false
  }
}

/**
 * Filter GeoJSON features using a compiled filter expression.
 * Returns the original data if no filter is set.
 */
function applyFilter(
  data: GeoJSONFeatureCollection,
  filterExpr?: { ast: unknown } | null,
): GeoJSONFeatureCollection {
  if (!filterExpr?.ast || !data.features) return data

  const ast = filterExpr.ast as import('@xgis/compiler').Expr
  const filtered = data.features.filter(f => {
    const result = evaluate(ast, f.properties ?? {})
    // Truthy check: non-zero numbers, true booleans, non-empty strings
    if (typeof result === 'boolean') return result
    if (typeof result === 'number') return result !== 0
    return !!result
  })

  if (filtered.length === data.features.length) return data
  return { ...data, features: filtered }
}
