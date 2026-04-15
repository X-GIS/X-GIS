// ═══ X-GIS Map — 전체를 연결하는 엔트리포인트 ═══

import { Lexer, Parser, lower, optimize, emitCommands, evaluate, compileGeoJSONToTiles, decomposeFeatures, deserializeXGB, resolveImportsAsync } from '@xgis/compiler'
import { initGPU, resizeCanvas, MAX_DPR, SAMPLE_COUNT, SAFE_MODE, type GPUContext } from './gpu'
import { Camera } from './camera'
import { MapRenderer, interpolateZoom, interpolateTime, interpolateTimeColor } from './renderer'
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
import type { LayerDrawPhase } from './vector-tile-renderer'
// reprojector.ts preserved for future tile-coordinate RTT approach

interface VariantPipelines {
  fillPipeline: GPURenderPipeline
  linePipeline: GPURenderPipeline
  fillPipelineFallback?: GPURenderPipeline
  linePipelineFallback?: GPURenderPipeline
}

/** A vector-tile show after zoom-opacity resolution and bucket
 *  classification. Produced by classifyVectorTileShows() once per
 *  frame and consumed by the bucket scheduler. */
interface ClassifiedShow {
  sourceName: string
  vtEntry: { source: XGVTSource; renderer: VectorTileRenderer }
  show: SceneCommands['shows'][0]
  fp: GPURenderPipeline
  lp: GPURenderPipeline
  bgl: GPUBindGroupLayout
  fpF?: GPURenderPipeline
  lpF?: GPURenderPipeline
  isTranslucentStroke: boolean
  /** Phase for the OPAQUE bucket draw. 'all' for pure opaque layers,
   *  'fills' for the fill half of a translucent-stroke layer. The
   *  'strokes' phase is emitted separately in the translucent bucket. */
  fillPhase: LayerDrawPhase
}

/** A run of consecutive same-source opaque shows that can share one
 *  sub-pass (single stencil clear). */
interface OpaqueGroup {
  sourceName: string
  shows: ClassifiedShow[]
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
  /** Last frame (per source) we logged a FLICKER warning. Throttles the
   *  warning to at most once every 60 frames (~1s at 60fps) so normal
   *  on-demand loading doesn't flood the overlay. */
  private _flickerLastFrame = new Map<string, number>()
  private _frameCount = 0
  /** Wall-clock animation origin captured on the first rendered frame.
   *  `performance.now() - _startTime` yields the elapsed milliseconds
   *  fed into every time-interpolated value (opacity today, more
   *  properties in future PRs). Null until first renderFrame. */
  private _startTime: number | null = null
  private _elapsedMs = 0

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
    // Reset the e2e ready signal for this load. The smoke test polls
    // __xgisReady after triggering navigation; the previous demo's
    // `true` would falsely satisfy the wait if we didn't clear it.
    if (typeof window !== 'undefined') {
      ;(window as unknown as { __xgisReady?: boolean }).__xgisReady = false
    }

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


    // 3. Load data — all sources in parallel. Sequential awaits used to
    // serialize 4-source demos into ~4x the total wall-clock time (each
    // source had to finish its index + preload decompression before the
    // next started). Promise.all lets index fetches overlap and lets
    // tile decompressions interleave on the main thread.
    let cameraFit = false
    const loadPromises = commands.loads.map(async (load) => {
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

        // Fit camera to the FIRST source that finishes. Multi-source demos
        // typically have the same world-bounds; picking "first to win"
        // avoids order-dependent racing and gives deterministic-enough
        // framing without coordinating across promises.
        if (!cameraFit) {
          const vtBounds = vtRenderer.getBounds()
          if (vtBounds) {
            cameraFit = true
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
        }
      } else {
        const response = await fetch(url)
        const data = await response.json() as GeoJSONFeatureCollection
        this.rawDatasets.set(load.name, data)
      }
    })
    await Promise.all(loadPromises)

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

    // Expose a ready signal for headless e2e / smoke tests. The test
    // harness (playground/e2e/smoke.spec.ts) polls window.__xgisReady
    // to know when a demo has completed its initial load and entered
    // the render loop. Gated on `typeof window` so SSR / Node tests
    // don't trip over the global.
    if (typeof window !== 'undefined') {
      ;(window as unknown as { __xgisReady?: boolean }).__xgisReady = true
    }
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

  /** Classify all visible vector-tile shows into opaque and translucent
   *  buckets for the bucket scheduler. Each show is resolved once — zoom-
   *  interpolated opacity, pipeline + layout picks, early-skip for
   *  effectively-invisible layers — so the pass loop below doesn't repeat
   *  that work.
   *
   *  A translucent-stroke layer appears in BOTH buckets:
   *    - opaque bucket with fillPhase='fills' (draws the polygon fill
   *      with baked alpha into the main color target using standard
   *      alpha blending)
   *    - translucent bucket with phase='strokes' (draws just the SDF
   *      stroke into an offscreen RT with MAX blend, then composites
   *      back with the layer's opacity — kills within-layer alpha
   *      accumulation at corner overlaps)
   *
   *  An opaque layer only appears in the opaque bucket, fillPhase='all',
   *  which renders fill + stroke + inline points in one call.
   */
  private classifyVectorTileShows(): {
    opaque: ClassifiedShow[]
    translucent: ClassifiedShow[]
  } {
    const opaque: ClassifiedShow[] = []
    const translucent: ClassifiedShow[] = []
    for (const entry of this.vectorTileShows) {
      const vtEntry = this.vtSources.get(entry.sourceName)
      if (!vtEntry || !vtEntry.renderer.hasData()) continue
      // Opacity = zoom factor × time factor. Either may be 1 if its stop
      // list is absent, leaving the existing constant opacity intact.
      const baseOpa = entry.show.opacity ?? 1
      const zoomOpa = entry.show.zoomOpacityStops
        ? interpolateZoom(entry.show.zoomOpacityStops, this.camera.zoom)
        : baseOpa
      const timeOpa = entry.show.timeOpacityStops
        ? interpolateTime(
            entry.show.timeOpacityStops, this._elapsedMs,
            entry.show.timeOpacityLoop ?? false,
            entry.show.timeOpacityEasing ?? 'linear',
            entry.show.timeOpacityDelayMs ?? 0,
          )
        : 1
      const composedOpa = zoomOpa * timeOpa

      // PR 3: resolve animated color/width/size/dashoffset here so the
      // downstream VTR, line-renderer, and point-renderer all see a
      // plain static show object and don't need to know about time
      // stops. The classifier is the single choke point that turns
      // animation IR back into concrete uniform values every frame.
      const loop = entry.show.timeOpacityLoop ?? false
      const easing = entry.show.timeOpacityEasing ?? 'linear'
      const delayMs = entry.show.timeOpacityDelayMs ?? 0
      const hasAnyTimeAnim =
        !!entry.show.timeOpacityStops ||
        !!entry.show.timeFillStops ||
        !!entry.show.timeStrokeStops ||
        !!entry.show.timeStrokeWidthStops ||
        !!entry.show.timeSizeStops ||
        !!entry.show.timeDashOffsetStops
      const needsClone = !!entry.show.zoomOpacityStops || hasAnyTimeAnim
      const effectiveShow = needsClone
        ? { ...entry.show, opacity: composedOpa }
        : entry.show
      if (entry.show.timeFillStops) {
        effectiveShow.resolvedFillRgba = interpolateTimeColor(
          entry.show.timeFillStops, this._elapsedMs, loop, easing, delayMs,
        )
      }
      if (entry.show.timeStrokeStops) {
        effectiveShow.resolvedStrokeRgba = interpolateTimeColor(
          entry.show.timeStrokeStops, this._elapsedMs, loop, easing, delayMs,
        )
      }
      if (entry.show.timeStrokeWidthStops) {
        effectiveShow.strokeWidth = interpolateTime(
          entry.show.timeStrokeWidthStops, this._elapsedMs, loop, easing, delayMs,
        )
      }
      if (entry.show.timeDashOffsetStops) {
        effectiveShow.dashOffset = interpolateTime(
          entry.show.timeDashOffsetStops, this._elapsedMs, loop, easing, delayMs,
        )
      }
      if (entry.show.timeSizeStops) {
        effectiveShow.size = interpolateTime(
          entry.show.timeSizeStops, this._elapsedMs, loop, easing, delayMs,
        )
      }
      if ((effectiveShow.opacity ?? 1) < 0.005) continue
      const isTranslucentStroke =
        !SAFE_MODE && (effectiveShow.opacity ?? 1) < 0.999 && !!effectiveShow.stroke
      const fp = entry.pipelines?.fillPipeline ?? this.renderer.fillPipeline
      const lp = entry.pipelines?.linePipeline ?? this.renderer.linePipeline
      const bgl = entry.layout ?? this.renderer.bindGroupLayout
      const fpF = entry.pipelines?.fillPipelineFallback ?? this.renderer.fillPipelineFallback
      const lpF = entry.pipelines?.linePipelineFallback ?? this.renderer.linePipelineFallback
      const classified: ClassifiedShow = {
        sourceName: entry.sourceName,
        vtEntry,
        show: effectiveShow,
        fp, lp, bgl, fpF, lpF,
        isTranslucentStroke,
        fillPhase: isTranslucentStroke ? 'fills' : 'all',
      }
      opaque.push(classified)
      if (isTranslucentStroke) translucent.push(classified)
    }
    return { opaque, translucent }
  }

  /** Group consecutive same-source opaque shows into runs so each source
   *  gets a single render pass with one stencil clear. Preserves
   *  declaration order — a later show with the same sourceName that's
   *  split by an intervening different source opens a NEW group (the
   *  stencil ring state isn't compatible across sources). */
  private groupOpaqueBySource(opaque: ClassifiedShow[]): OpaqueGroup[] {
    const groups: OpaqueGroup[] = []
    for (const show of opaque) {
      const last = groups[groups.length - 1]
      if (last && last.sourceName === show.sourceName) {
        last.shows.push(show)
      } else {
        groups.push({ sourceName: show.sourceName, shows: [show] })
      }
    }
    return groups
  }

  private renderFrame(): void {
    this._stats.beginFrame()
    resizeCanvas(this.ctx)

    // Seed the animation clock on first rendered frame, then compute the
    // elapsed wall-clock milliseconds. Everything time-interpolated
    // (opacity today, color/width/etc. in later PRs) reads this value.
    if (this._startTime === null) this._startTime = performance.now()
    this._elapsedMs = performance.now() - this._startTime

    const projType = {
      mercator: 0, equirectangular: 1, natural_earth: 2,
      orthographic: 3, azimuthal_equidistant: 4, stereographic: 5,
      oblique_mercator: 6,
    }[this.projectionName] ?? 0
    const { device, context, canvas } = this.ctx
    const w = canvas.width, h = canvas.height
    if (w === 0 || h === 0) { requestAnimationFrame(this.renderLoop); return }

    // DSFUN precision removes the old `maxSrcLevel + 6` clamp: tile vertices
    // are now stored as f64-equivalent (high/low) Mercator-meter pairs, so
    // a z=5 parent tile survives camera zoom 22 with sub-millimeter jitter.
    // Zoom 22 is a universal cap across every source.
    this.camera.maxZoom = 22

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
      const useResolve = sc > 1
      const colorView = useResolve ? msaaView : screenView

      // Reset per-frame uniform ring cursors (dynamic-offset slots).
      this.renderer.beginFrame()
      this.lineRenderer?.beginFrame()
      for (const [, { renderer: vtR }] of this.vtSources) vtR.beginFrame()

      // ══════ Bucket scheduler ══════
      //
      // Layers are classified into two buckets so alpha compositing is
      // always correct regardless of user declaration order:
      //
      //   1. OPAQUE bucket — every vector source's fills + opaque
      //      strokes + the fill half of translucent-stroke layers.
      //      Runs first so translucent content has a finished opaque
      //      backdrop to blend against. Sources that don't share
      //      stencil state get their own sub-pass (each sub-pass
      //      clears stencil), but consecutive same-source shows share
      //      one sub-pass.
      //
      //   2. TRANSLUCENT bucket — offscreen MAX-blend + composite for
      //      each translucent-stroke layer, in declaration order.
      //      Runs after the entire opaque bucket so translucent
      //      strokes always paint on top of opaque content.
      //
      //   3. POINTS bucket — a single pass (or inline in bucket 1)
      //      for SDF points. Always last so points draw over the map.
      //
      // The previous scheduler interleaved bucket 1 + 2 per source,
      // which broke the ordering when a translucent layer was
      // declared before an opaque layer: the translucent composite
      // would run BEFORE the later opaque fill, and the opaque fill
      // would cover the translucent strokes.
      const { opaque, translucent } = this.classifyVectorTileShows()
      const opaqueGroups = this.groupOpaqueBySource(opaque)
      const hasTranslucent = translucent.length > 0 && this.lineRenderer !== null
      const hasPoints = this.pointRenderer?.hasLayers() ?? false
      // Inline points into the last opaque sub-pass ONLY when there
      // are no translucent composites to run after. Otherwise defer
      // to a dedicated points pass at the very end so points always
      // draw on top of translucent composites.
      const inlinePoints = hasPoints && !hasTranslucent
      // Which pass owns the MSAA resolveTarget? Precisely the last
      // pass that writes to the color target. Priority: dedicated
      // points > last composite > last opaque sub-pass.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _resolveOwner = hasPoints && !inlinePoints
        ? 'points'
        : hasTranslucent
          ? 'composite'
          : 'opaque'

      if (hasTranslucent) this.lineRenderer!.ensureOffscreen(w, h)

      // ── Bucket 1: opaque ──
      // Always emit at least one pass so raster + canvas background
      // can run even if there are no vector layers to draw. The first
      // pass clears the color target; subsequent opaque sub-passes
      // load.
      const opaqueCount = Math.max(1, opaqueGroups.length)
      for (let gi = 0; gi < opaqueCount; gi++) {
        const group = opaqueGroups[gi]
        const isFirst = gi === 0
        const isLastOpaque = gi === opaqueCount - 1
        // Only the LAST opaque sub-pass can claim resolveTarget, and
        // only if no translucent/points pass runs after it.
        const resolveHere =
          useResolve && isLastOpaque && _resolveOwner === 'opaque'

        passScope(isFirst ? 'opaque-main' : `opaque[${gi}]`, () => {
          const subPass = encoder.beginRenderPass({
            colorAttachments: [{
              view: colorView,
              resolveTarget: resolveHere ? screenView : undefined,
              // First pass clears to the canvas background; subsequent
              // opaque sub-passes load so we don't stomp earlier work.
              clearValue: isFirst ? { r: 0.039, g: 0.039, b: 0.063, a: 1 } : undefined,
              loadOp: isFirst ? 'clear' : 'load',
              storeOp: 'store',
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

          // First opaque pass owns raster + canvas-2D background
          // content. These are always the back-most layers in the
          // current architecture.
          if (isFirst) {
            this.rasterRenderer.render(subPass, this.camera, projType, centerLon, centerLat, w, h)
            this.renderer.renderToPass(subPass, this.camera, projType, centerLon, centerLat, this._elapsedMs)
          }

          if (!group) return

          for (let si = 0; si < group.shows.length; si++) {
            const cs = group.shows[si]
            // Pass pointRenderer inline only on the VERY last opaque
            // draw of the last group AND only if there's no dedicated
            // points pass coming after. Otherwise points render in
            // their own pass below.
            const isTailOfBucket =
              inlinePoints && isLastOpaque && si === group.shows.length - 1
            cs.vtEntry.renderer.render(
              subPass, this.camera, projType, centerLon, centerLat, w, h,
              cs.show, cs.fp, cs.lp, this.renderer.uniformBuffer, cs.bgl,
              cs.fpF, cs.lpF,
              isTailOfBucket ? this.pointRenderer : null,
              cs.fillPhase,
            )
          }

          subPass.end()
        })
      }

      // ── Bucket 2: translucent offscreen + composite ──
      if (hasTranslucent) {
        for (let li = 0; li < translucent.length; li++) {
          const cs = translucent[li]
          const isLastTranslucent = li === translucent.length - 1
          const resolveHere =
            useResolve && isLastTranslucent && _resolveOwner === 'composite'

          passScope(`translucent-off[${li}]`, () => {
            const offPass = this.lineRenderer!.beginTranslucentPass(encoder)
            cs.vtEntry.renderer.render(
              offPass, this.camera, projType, centerLon, centerLat, w, h,
              cs.show, cs.fp, cs.lp, this.renderer.uniformBuffer, cs.bgl,
              cs.fpF, cs.lpF,
              null, 'strokes',
            )
            offPass.end()
          })

          passScope(`translucent-comp[${li}]`, () => {
            const compPass = encoder.beginRenderPass({
              colorAttachments: [{
                view: colorView,
                resolveTarget: resolveHere ? screenView : undefined,
                loadOp: 'load',
                storeOp: 'store',
              }],
            })
            this.lineRenderer!.composite(compPass, cs.show.opacity ?? 1)
            compPass.end()
          })
        }
      }

      // ── Bucket 3: points ──
      // Only run a dedicated points pass if we didn't already inline
      // points into the last opaque sub-pass. The inline path is a
      // small optimization for the common "no translucent" case.
      if (hasPoints && !inlinePoints) {
        passScope('points', () => {
          const ptPass = encoder.beginRenderPass({
            colorAttachments: [{
              view: colorView,
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
      // Throttle [FLICKER] per-source to once per ~60 frames. On-demand
      // tile loading legitimately leaves some visible cells uncached for
      // a few frames; the warning is only informative for diagnosing
      // "missing fallback" regressions, not an error users need to see
      // at 60 Hz during normal pan/zoom.
      if (vts.missedTiles > 0) {
        const last = this._flickerLastFrame.get(name) ?? -Infinity
        if (this._frameCount - last >= 60) {
          this._flickerLastFrame.set(name, this._frameCount)
          console.warn(`[FLICKER] ${name}: ${vts.missedTiles} tiles without fallback (z=${Math.round(this.camera.zoom)} gpuCache=${vtR.getCacheSize()})`)
        }
      }
    }
    this._frameCount++
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
