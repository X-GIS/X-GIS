// ═══ X-GIS Map — 전체를 연결하는 엔트리포인트 ═══

import { Lexer, Parser, lower, optimize, emitCommands, evaluate, compileGeoJSONToTiles, decomposeFeatures, deserializeXGB, resolveImportsAsync } from '@xgis/compiler'
import { initGPU, resizeCanvas, MAX_DPR, SAMPLE_COUNT, SAFE_MODE, type GPUContext } from './gpu'
import { Camera } from './camera'
import { MapRenderer, interpolateZoom } from './renderer'
import { interpret, type SceneCommands } from './interpreter'
import { lonLatToMercator, type GeoJSONFeatureCollection } from '../loader/geojson'
import { isTileTemplate } from '../loader/tiles'
import { RasterRenderer } from './raster-renderer'
import { PointRenderer } from './point-renderer'
import { ShapeRegistry } from './sdf-shape'
import { LineRenderer } from './line-renderer'
import { PanZoomController, type Controller } from './controller'
import { CanvasRenderer } from './canvas-renderer'
import { VectorTileRenderer } from './vector-tile-renderer'
import { XGVTSource } from '../data/xgvt-source'
import { StatsTracker, StatsPanel, type RenderStats } from './stats'
// reprojector.ts preserved for future tile-coordinate RTT approach

interface VariantPipelines {
  fillPipeline: GPURenderPipeline
  linePipeline: GPURenderPipeline
  fillPipelineFallback?: GPURenderPipeline
  linePipelineFallback?: GPURenderPipeline
}

export class XGISMap {
  private ctx!: GPUContext
  private camera: Camera
  private renderer!: MapRenderer
  private rasterRenderer!: RasterRenderer
  private pointRenderer!: PointRenderer
  private shapeRegistry: ShapeRegistry | null = null
  private lineRenderer: LineRenderer | null = null
  private running = false
  private projectionName = 'mercator'
  private controller: Controller | null = null

  // Canvas 2D fallback
  private canvasRenderer: CanvasRenderer | null = null
  private useCanvas2D = false

  // Vector tile sources + renderers (per .xgvt source)
  private vtSources = new Map<string, { source: XGVTSource; renderer: VectorTileRenderer }>()
  private vectorTileShows: { sourceName: string; show: SceneCommands['shows'][0]; pipelines: VariantPipelines | null; layout: GPUBindGroupLayout | null }[] = []
  private vtVariantPipelines: VariantPipelines | null = null

  // Raw data for re-projection
  private rawDatasets = new Map<string, GeoJSONFeatureCollection>()
  private showCommands: SceneCommands['shows'] = []

  // Stencil buffer for tile overlap masking
  private stencilTexture: GPUTexture | null = null

  // MSAA 4x render target
  private msaaTexture: GPUTexture | null = null
  private msaaWidth = 0
  private msaaHeight = 0

  // Stats inspector
  private _stats = new StatsTracker()
  private _statsPanel: StatsPanel | null = null

  constructor(private canvas: HTMLCanvasElement) {
    this.camera = new Camera(0, 20, 2)
  }

  /** Get current rendering stats */
  get stats(): RenderStats { return this._stats.get() }

  /** Public read/write access to the camera (for URL hash, etc). */
  getCamera(): Camera { return this.camera }

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
    // Promote baseUrl to an absolute URL. `new URL(path, base)` requires
    // `base` to be absolute — passing a bare path like '/data/' throws
    // TypeError: Invalid base URL. Accepts '', '/data/', relative URLs, or
    // fully-qualified URLs.
    const absBase = (() => {
      if (typeof window === 'undefined') return baseUrl  // SSR / tests
      if (!baseUrl) return window.location.href
      try { return new URL(baseUrl, window.location.href).href }
      catch { return window.location.href }
    })()

    // 1. Parse → resolve imports (async fetch) → IR → Commands
    const tokens = new Lexer(source).tokenize()
    let ast = new Parser(tokens).parse()

    // Resolve any `import { ... } from "..."` statements via fetch.
    // Errors are logged (via console.error → in-page overlay) so future
    // module-resolution failures aren't opaque on iOS.
    const resolver = async (path: string): Promise<string | null> => {
      let url: string
      try { url = new URL(path, absBase).href }
      catch (e) {
        console.error(`[X-GIS import] cannot build URL for "${path}" against base "${absBase}":`, (e as Error).message)
        return null
      }
      try {
        const resp = await fetch(url)
        if (!resp.ok) {
          console.error(`[X-GIS import] fetch ${url} failed: ${resp.status} ${resp.statusText}`)
          return null
        }
        return await resp.text()
      } catch (e) {
        console.error(`[X-GIS import] fetch ${url} threw:`, (e as Error).message)
        return null
      }
    }
    if (ast.body.some(s => s.kind === 'ImportStatement')) {
      ast = await resolveImportsAsync(ast, absBase, resolver)
    }

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
      try {
        this.pointRenderer = new PointRenderer(this.ctx)
        this.shapeRegistry = new ShapeRegistry(this.ctx.device)
        // Register user-defined symbols from DSL
        for (const sym of commands.symbols ?? []) {
          for (const path of sym.paths) {
            this.shapeRegistry.addShape(sym.name, path)
          }
        }
        this.shapeRegistry.uploadToGPU()
        this.pointRenderer.setShapeRegistry(this.shapeRegistry)
      } catch (e) { console.warn('[X-GIS] PointRenderer init failed:', e) }

      // SDF line renderer (shared by all VTR instances)
      try {
        this.lineRenderer = new LineRenderer(this.ctx, this.renderer.bindGroupLayout)
        if (this.shapeRegistry) this.lineRenderer.setShapeRegistry(this.shapeRegistry)
      } catch (e) { console.warn('[X-GIS] LineRenderer init failed:', e) }
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
        // Store the URL — actual raster rendering is activated only when a
        // layer references this source (in rebuildLayers)
        this.rawDatasets.set(load.name, { _tileUrl: url } as unknown as GeoJSONFeatureCollection)
      } else if (url.endsWith('.xgvt') && !this.useCanvas2D) {
        // Vector tile file — create per-source XGVTSource + VectorTileRenderer
        const source = new XGVTSource()
        const vtRenderer = new VectorTileRenderer(this.ctx)
        vtRenderer.setBindGroupLayout(this.renderer.bindGroupLayout) // must be set before any tile uploads
        if (this.lineRenderer) vtRenderer.setLineRenderer(this.lineRenderer)
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
          const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, MAX_DPR) : 1
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
    this.pointRenderer?.clearLayers()
    this.vectorTileShows = []

    // Reset raster renderer — only activate if a layer references a raster source
    if (!this.useCanvas2D) this.rasterRenderer.setUrlTemplate('')

    for (const show of this.showCommands) {
      const data = this.rawDatasets.get(show.targetName)
      if (!data) continue

      // Raster tile source referenced by a layer → activate raster renderer
      const tileUrl = (data as unknown as { _tileUrl?: string })._tileUrl
      if (tileUrl) {
        if (!this.useCanvas2D) this.rasterRenderer.setUrlTemplate(tileUrl)
        continue
      }

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

      let filtered = applyFilter(data, show.filterExpr)

      // Procedural geometry: evaluate geometry expression per feature
      if (show.geometryExpr?.ast) {
        filtered = applyGeometry(filtered, show.geometryExpr)
      }

      // Point geometry → SDF point renderer (skip polygon tiling pipeline)
      const firstGeomType = filtered.features[0]?.geometry?.type
      if ((firstGeomType === 'Point' || firstGeomType === 'MultiPoint') && !show.geometryExpr && this.pointRenderer) {
        const fillHex = show.fill
        const strokeHex = show.stroke
        const fill = fillHex ? parseHexColor(fillHex) : null
        const stroke = strokeHex ? parseHexColor(strokeHex) : null

        // Evaluate per-feature size if data-driven
        let perFeatureSizes: number[] | null = null
        if (show.sizeExpr?.ast) {
          const ast = show.sizeExpr.ast as import('@xgis/compiler').Expr
          perFeatureSizes = filtered.features.map(f => {
            const r = evaluate(ast, f.properties ?? {})
            return typeof r === 'number' ? r : (show.size ?? 8)
          })
        }

        // Resolve shape name to GPU shape_id
        const shapeId = show.shape ? (this.shapeRegistry?.getShapeId(show.shape) ?? 0) : 0

        this.pointRenderer.addLayer(
          filtered.features as any,
          fill, stroke,
          show.strokeWidth,
          show.size ?? 8,
          show.opacity ?? 1.0,
          show.sizeUnit,
          perFeatureSizes,
          show.billboard,
          shapeId,
          show.anchor,
        )
        continue
      }

      const source = new XGVTSource()
      const vtRenderer = new VectorTileRenderer(this.ctx)
      vtRenderer.setBindGroupLayout(this.renderer.bindGroupLayout)
      if (this.lineRenderer) vtRenderer.setLineRenderer(this.lineRenderer)
      vtRenderer.setSource(source)
      this.vtSources.set(vtKey, { source, renderer: vtRenderer })

      // On-demand tiling: compile z0 immediately, higher zooms on demand
      // when the renderer requests visible tiles
      const parts = decomposeFeatures(filtered.features)
      const z0Set = compileGeoJSONToTiles(filtered, { minZoom: 0, maxZoom: 0 })
      if (z0Set.levels.length > 0) {
        source.addTileLevel(z0Set.levels[0], z0Set.bounds, z0Set.propertyTable)
      }
      source.setRawParts(parts, z0Set.levels.length > 0 ? 7 : 0)

      // Fit camera
      const [minLon, minLat, maxLon, maxLat] = z0Set.bounds
      if (minLon < Infinity) {
        const clampedLat = Math.max(-85, Math.min(85, (minLat + maxLat) / 2))
        const [cx, cy] = lonLatToMercator((minLon + maxLon) / 2, clampedLat)
        this.camera.centerX = cx
        this.camera.centerY = cy
        const lonSpan = maxLon - minLon
        const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, MAX_DPR) : 1
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
    const commands: SceneCommands = { loads: scene.loads, shows: scene.shows as unknown as SceneCommands['shows'] }

    console.log('[X-GIS] Binary loaded:', commands.loads.length, 'loads,', commands.shows.length, 'shows')

    this.ctx = await initGPU(this.canvas)
    this.renderer = new MapRenderer(this.ctx)
    this.rasterRenderer = new RasterRenderer(this.ctx)
      try { this.pointRenderer = new PointRenderer(this.ctx) } catch (e) { console.warn('[X-GIS] PointRenderer init failed:', e) }

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
    try {
      this.renderFrame()
    } catch (err) {
      // Surface frame errors to the console so the in-page log overlay
      // (and PC DevTools) can show the real message. Without this wrap,
      // requestAnimationFrame errors bubble to window.onerror as the
      // useless "Script error. @ :0:0" placeholder under iOS WebKit.
      console.error('[X-GIS frame]', (err as Error)?.stack ?? err)
      this.running = false  // stop the loop so the error doesn't repeat 60×/sec
    }
  }

  private renderFrame(): void {
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

    // Track the maximum useful zoom level based on loaded vector sources.
    // Tile vertices are stored in tile-local degrees (float32), losing
    // precision to ~30cm for a z=5 parent at zoom > ~18, and generateSubTile
    // is called for thousands of microscopic slices. maxSubTileZ =
    // source.maxLevel + 6 matches the tile selection clamp. We only
    // UPDATE camera.maxZoom here (not `camera.zoom` itself) so that
    // zoomAt and other input-side clamping use the current cap, while
    // avoiding per-frame tug-of-war with the controller's inertia/zoom
    // animations that would manifest as the map drifting by itself.
    let zoomCap = 22
    if (this.vtSources.size > 0) {
      let maxSrcLevel = 0
      for (const [, { renderer: vtR }] of this.vtSources) {
        if (vtR.sourceMaxLevel > maxSrcLevel) maxSrcLevel = vtR.sourceMaxLevel
      }
      zoomCap = Math.min(22, maxSrcLevel + 6)
    }
    this.camera.maxZoom = zoomCap

    // Clamp camera Y (latitude bounded), X wraps freely (world repeat)
    const MAX_MERC = 20037508.34
    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, MAX_DPR) : 1
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
    // Wrap the entire frame in a validation scope so any pass-creation or
    // draw-call validation error gets a unique log entry pointing to the
    // submit. Each block below also pushes its own scope for finer locality.
    device.pushErrorScope('validation')

    // Per-pass scope helper: pushes an error scope, runs `fn`, then pops and
    // logs any validation error tagged with `label`. Nested inside the
    // frame-level scope so both levels fire independently — the inner scope
    // pinpoints which pass failed, the outer one catches encoder-wide state.
    const passScope = (label: string, fn: () => void): void => {
      device.pushErrorScope('validation')
      try { fn() }
      finally {
        device.popErrorScope().then((err) => {
          if (err) console.error(`[X-GIS pass:${label}]`, err.message)
        }).catch(() => { /* scope stack mismatch — swallow */ })
      }
    }

    {
      // ═══ Direct rendering: vertex shader handles all projections ═══
      // MSAA + stencil texture management (recreate on resize).
      // sample count tracks the pipeline-time SAMPLE_COUNT (1 on mobile, 4 on desktop).
      const sc = SAMPLE_COUNT
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
          format: 'depth24plus-stencil8',
          sampleCount: sc,
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
        })
        this.msaaWidth = w
        this.msaaHeight = h
      }

      // When SAMPLE_COUNT === 1 (mobile / no MSAA), render DIRECTLY to the
      // swapchain texture and never set a resolveTarget — single-sample
      // attachments cannot have a resolve target per WebGPU spec.
      const msaaView = this.msaaTexture!.createView()
      const hasMultiSource = this.vectorTileShows.length > 1
      const useResolve = sc > 1
      const colorView = useResolve ? msaaView : screenView
      const colorResolve = useResolve && !hasMultiSource ? screenView : undefined
      // Per-pass scope so a validation error in the main pass is labelled
      // before the frame-level scope catches the poisoned-encoder aftermath.
      device.pushErrorScope('validation')
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: colorView,
          resolveTarget: colorResolve,
          clearValue: { r: 0.039, g: 0.039, b: 0.063, a: 1 },
          loadOp: 'clear',
          storeOp: 'store', // keep MSAA data for subsequent VT passes
        }],
        depthStencilAttachment: {
          view: this.stencilTexture!.createView(),
          depthClearValue: 1.0,
          depthLoadOp: 'clear',
          depthStoreOp: 'discard',
          stencilClearValue: 0,
          stencilLoadOp: 'clear',
          stencilStoreOp: 'discard',
        },
      })

      // Reset per-frame uniform ring cursors (dynamic-offset slots).
      this.renderer.beginFrame()
      this.lineRenderer?.beginFrame()
      for (const [, { renderer: vtR }] of this.vtSources) vtR.beginFrame()

      this.rasterRenderer.render(pass, this.camera, projType, centerLon, centerLat, w, h)
      this.renderer.renderToPass(pass, this.camera, projType, centerLon, centerLat)

      // Track translucent line layers — they get a second pass after the
      // main pass: render to offscreen with MAX blend, then composite onto
      // the main framebuffer with alpha × layer opacity. This avoids
      // alpha accumulation at line self-intersections / corner overlap.
      const translucentLineLayers: { sourceName: string; show: SceneCommands['shows'][0]; pipelines: VariantPipelines | null; layout: GPUBindGroupLayout | null; opacity: number }[] = []

      // Render vector tile sources (polygons/lines — before points)
      if (this.vectorTileShows.length === 1) {
        // Single source: render in existing pass (shared stencil)
        for (const { sourceName, show, pipelines, layout } of this.vectorTileShows) {
          const vtEntry = this.vtSources.get(sourceName)
          if (!vtEntry || !vtEntry.renderer.hasData()) continue
          // Zoom-interpolated opacity: override per frame
          const effectiveShow = show.zoomOpacityStops
            ? { ...show, opacity: interpolateZoom(show.zoomOpacityStops, this.camera.zoom) }
            : show
          // Early skip: layers that interpolate to effectively-zero opacity
          // contribute nothing to the framebuffer but still cost tile
          // selection, GPU upload, and draw calls — and their transient
          // partial-draws during fade-in cause visible flicker at zoom
          // transitions. Dropping them entirely lets the pipeline focus on
          // visible layers only.
          if ((effectiveShow.opacity ?? 1) < 0.005) continue
          const isTranslucentStroke =
            !SAFE_MODE && (effectiveShow.opacity ?? 1) < 0.999 && !!effectiveShow.stroke

          const fp = pipelines?.fillPipeline ?? this.renderer.fillPipeline
          const lp = pipelines?.linePipeline ?? this.renderer.linePipeline
          const bgl = layout ?? this.renderer.bindGroupLayout
          const fpF = pipelines?.fillPipelineFallback ?? this.renderer.fillPipelineFallback
          const lpF = pipelines?.linePipelineFallback ?? this.renderer.linePipelineFallback

          // Translucent+stroke: draw fills in the main pass (baked opacity),
          // then defer strokes to the offscreen MAX-blend pass below.
          // Opaque: draw everything inline in one call.
          vtEntry.renderer.render(pass, this.camera, projType, centerLon, centerLat, w, h,
            effectiveShow, fp, lp, this.renderer.uniformBuffer, bgl,
            fpF, lpF,
            isTranslucentStroke ? null : this.pointRenderer,
            isTranslucentStroke ? 'fills' : 'all')

          if (isTranslucentStroke) {
            translucentLineLayers.push({ sourceName, show: effectiveShow, pipelines, layout, opacity: effectiveShow.opacity ?? 1 })
          }
        }
      }

      // Render SDF points (after polygons so points appear on top)
      if (this.pointRenderer?.hasLayers()) {
        this.pointRenderer.render(pass, this.camera, centerLon, centerLat, w, h)
      }

      pass.end()
      device.popErrorScope().then((err) => {
        if (err) console.error('[X-GIS pass:main]', err.message)
      }).catch(() => { /* scope stack mismatch — swallow */ })

      // ── Translucent line layers ──
      // For each translucent line layer: clear an offscreen RT, draw lines
      // with MAX blend (no within-layer accumulation), then composite the
      // offscreen onto the main framebuffer with the layer opacity.
      if (translucentLineLayers.length > 0 && this.lineRenderer) {
        this.lineRenderer.ensureOffscreen(w, h)
        for (let li = 0; li < translucentLineLayers.length; li++) {
          const { sourceName, show, pipelines, layout, opacity } = translucentLineLayers[li]
          const vtEntry = this.vtSources.get(sourceName)
          if (!vtEntry || !vtEntry.renderer.hasData()) continue
          const fp = pipelines?.fillPipeline ?? this.renderer.fillPipeline
          const lp = pipelines?.linePipeline ?? this.renderer.linePipeline
          const bgl = layout ?? this.renderer.bindGroupLayout

          // 1. Offscreen pass: lines with MAX blend
          passScope(`ss-offscreen[${li}]`, () => {
            const offPass = this.lineRenderer!.beginTranslucentPass(encoder)
            vtEntry.renderer.render(offPass, this.camera, projType, centerLon, centerLat, w, h,
              show, fp, lp, this.renderer.uniformBuffer, bgl,
              pipelines?.fillPipelineFallback ?? this.renderer.fillPipelineFallback,
              pipelines?.linePipelineFallback ?? this.renderer.linePipelineFallback,
              null,
              'strokes')
            offPass.end()
          })

          // 2. Composite pass: blend offscreen onto main RT.
          // The composite pipeline has no depth/stencil so the attachment
          // is omitted. Use direct screenView writes when MSAA is off.
          const isLastTranslucent = li === translucentLineLayers.length - 1
          passScope(`ss-composite[${li}]`, () => {
            const compPass = encoder.beginRenderPass({
              colorAttachments: [{
                view: useResolve ? msaaView : screenView,
                resolveTarget: useResolve && isLastTranslucent ? screenView : undefined,
                loadOp: 'load',
                storeOp: 'store',
              }],
            })
            this.lineRenderer!.composite(compPass, opacity)
            compPass.end()
          })
        }
      }

      // Multi-source: separate pass per source (independent stencil clear).
      // Each translucent+stroke layer gets the same offscreen MAX-blend +
      // composite treatment as the single-source path, so within-layer alpha
      // does not accumulate at line corners. The earlier "encoder state is
      // not valid" regression on iOS was caused by the composite uniform
      // buffer being half its true size (16 vs 32); once that was fixed the
      // offscreen path is safe to enable here too.
      if (this.vectorTileShows.length > 1) {
        const lr = this.lineRenderer
        if (lr) lr.ensureOffscreen(w, h)

        // Precompute the index of the last VISIBLE layer (opacity > 0.005
        // and backing source has data). MSAA resolveTarget must fire on
        // exactly the last pass that actually runs; otherwise skipped
        // layers would leave the last isLast=true layer un-rendered and
        // the screen would go blank on desktop.
        let lastVisibleSi = -1
        for (let si = 0; si < this.vectorTileShows.length; si++) {
          const { sourceName, show: rs } = this.vectorTileShows[si]
          const vte = this.vtSources.get(sourceName)
          if (!vte || !vte.renderer.hasData()) continue
          const eff = rs.zoomOpacityStops
            ? interpolateZoom(rs.zoomOpacityStops, this.camera.zoom)
            : (rs.opacity ?? 1)
          if (eff < 0.005) continue
          lastVisibleSi = si
        }

        for (let si = 0; si < this.vectorTileShows.length; si++) {
          const { sourceName, show: rawShow, pipelines, layout } = this.vectorTileShows[si]
          const vtEntry = this.vtSources.get(sourceName)
          if (!vtEntry || !vtEntry.renderer.hasData()) continue
          const show = rawShow.zoomOpacityStops
            ? { ...rawShow, opacity: interpolateZoom(rawShow.zoomOpacityStops, this.camera.zoom) }
            : rawShow
          // Skip layers whose zoom-interpolated opacity is effectively zero —
          // avoids wasted tile requests, uploads, and draw calls for the
          // invisible tail of a fade-out. See same-path comment in the
          // single-source branch above.
          if ((show.opacity ?? 1) < 0.005) continue
          const fp = pipelines?.fillPipeline ?? this.renderer.fillPipeline
          const lp = pipelines?.linePipeline ?? this.renderer.linePipeline
          const bgl = layout ?? this.renderer.bindGroupLayout
          const fpF = pipelines?.fillPipelineFallback ?? this.renderer.fillPipelineFallback
          const lpF = pipelines?.linePipelineFallback ?? this.renderer.linePipelineFallback
          const isLast = si === lastVisibleSi

          const isTranslucentStroke =
            !SAFE_MODE && lr !== null && (show.opacity ?? 1) < 0.999 && !!show.stroke

          passScope(`ms-vt[${si}]`, () => {
            const vtPass = encoder.beginRenderPass({
              colorAttachments: [{
                view: useResolve ? msaaView : screenView,
                resolveTarget: useResolve && isLast && !isTranslucentStroke ? screenView : undefined,
                loadOp: 'load',
                storeOp: 'store',
              }],
              depthStencilAttachment: {
                view: this.stencilTexture!.createView(),
                depthClearValue: 1.0, depthLoadOp: 'clear', depthStoreOp: 'discard',
                stencilClearValue: 0, stencilLoadOp: 'clear', stencilStoreOp: 'discard',
              },
            })
            vtEntry.renderer.render(vtPass, this.camera, projType, centerLon, centerLat, w, h,
              show, fp, lp, this.renderer.uniformBuffer, bgl,
              fpF, lpF,
              isTranslucentStroke ? null : this.pointRenderer,
              isTranslucentStroke ? 'fills' : 'all')
            vtPass.end()
          })

          if (isTranslucentStroke && lr) {
            // Offscreen line draw (MAX blend, α=1) — no within-layer accumulation.
            passScope(`ms-offscreen[${si}]`, () => {
              const offPass = lr.beginTranslucentPass(encoder)
              vtEntry.renderer.render(offPass, this.camera, projType, centerLon, centerLat, w, h,
                show, fp, lp, this.renderer.uniformBuffer, bgl, fpF, lpF,
                null, 'strokes')
              offPass.end()
            })

            // Composite offscreen → main framebuffer with layer opacity.
            passScope(`ms-composite[${si}]`, () => {
              const compPass = encoder.beginRenderPass({
                colorAttachments: [{
                  view: useResolve ? msaaView : screenView,
                  resolveTarget: useResolve && isLast ? screenView : undefined,
                  loadOp: 'load',
                  storeOp: 'store',
                }],
              })
              lr.composite(compPass, show.opacity ?? 1)
              compPass.end()
            })
          }
        }

        // Render SDF points after all VT passes
        if (this.pointRenderer?.hasLayers()) passScope('ms-points', () => {
          const ptPass = encoder.beginRenderPass({
            colorAttachments: [{
              view: useResolve ? msaaView : screenView,
              resolveTarget: useResolve ? screenView : undefined,
              loadOp: 'load',
              storeOp: 'store',
            }],
            depthStencilAttachment: {
              view: this.stencilTexture!.createView(),
              depthClearValue: 1.0, depthLoadOp: 'clear', depthStoreOp: 'discard',
              stencilClearValue: 0, stencilLoadOp: 'clear', stencilStoreOp: 'discard',
            },
          })
          this.pointRenderer!.render(ptPass, this.camera, centerLon, centerLat, w, h)
          ptPass.end()
        })
      }
    }

    // Outer scope catches the FRAME-level error (one entry per bad frame),
    // matching the inner scope opened right after createCommandEncoder().
    device.queue.submit([encoder.finish()])
    device.popErrorScope().then((err) => {
      if (err) console.error('[X-GIS frame-validation]', err.message)
    }).catch(() => { /* scope mismatch — ignore */ })

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

/**
 * Generate procedural geometry for each feature.
 * Evaluates the geometry expression per-feature, replacing each feature's
 * geometry with the computed result (e.g., circle, arc, polygon from points).
 */
function applyGeometry(
  data: GeoJSONFeatureCollection,
  geometryExpr: { ast: unknown },
): GeoJSONFeatureCollection {
  const ast = geometryExpr.ast as import('@xgis/compiler').Expr
  const newFeatures = data.features.map(f => {
    const result = evaluate(ast, f.properties ?? {})
    if (!result) return f

    // Result is coordinate array → wrap as Polygon
    if (Array.isArray(result) && result.length > 0 && Array.isArray(result[0])) {
      return {
        ...f,
        geometry: { type: 'Polygon' as const, coordinates: [result as number[][]] },
      }
    }

    // Result is GeoJSON geometry object
    if (result && typeof result === 'object' && 'type' in result && 'coordinates' in result) {
      return { ...f, geometry: result as typeof f.geometry }
    }

    return f
  })

  return { ...data, features: newFeatures }
}

function parseHexColor(hex: string): [number, number, number, number] {
  let r = 0, g = 0, b = 0, a = 1
  if (hex.length === 4) {
    r = parseInt(hex[1] + hex[1], 16) / 255; g = parseInt(hex[2] + hex[2], 16) / 255; b = parseInt(hex[3] + hex[3], 16) / 255
  } else if (hex.length === 7) {
    r = parseInt(hex.slice(1, 3), 16) / 255; g = parseInt(hex.slice(3, 5), 16) / 255; b = parseInt(hex.slice(5, 7), 16) / 255
  } else if (hex.length === 9) {
    r = parseInt(hex.slice(1, 3), 16) / 255; g = parseInt(hex.slice(3, 5), 16) / 255; b = parseInt(hex.slice(5, 7), 16) / 255
    a = parseInt(hex.slice(7, 9), 16) / 255
  }
  return [r, g, b, a]
}
