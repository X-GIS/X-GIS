// ═══ X-GIS Map — 전체를 연결하는 엔트리포인트 ═══

import { Lexer, Parser, lower, optimize, emitCommands } from '@xgis/compiler'
import { deserializeXGB } from '../../../compiler/src/binary/format'
import { initGPU, resizeCanvas, type GPUContext } from './gpu'
import { Camera } from './camera'
import { MapRenderer } from './renderer'
import { interpret, type SceneCommands } from './interpreter'
import { loadGeoJSON, lonLatToMercator, type GeoJSONFeatureCollection } from '../loader/geojson'
import { isTileTemplate } from '../loader/tiles'
import { RasterRenderer } from './raster-renderer'
import { PanZoomController, type Controller } from './controller'
import { GlobeRenderer } from './globe-renderer'
import { CanvasRenderer } from './canvas-renderer'
import { VectorTileRenderer } from './vector-tile-renderer'

export class XGISMap {
  private ctx!: GPUContext
  private camera: Camera
  private renderer!: MapRenderer
  private rasterRenderer!: RasterRenderer
  private globeRenderer!: GlobeRenderer
  private running = false
  private projectionName = 'mercator'
  private controller: Controller | null = null

  // Canvas 2D fallback
  private canvasRenderer: CanvasRenderer | null = null
  private useCanvas2D = false

  // Vector tile renderer
  private vectorTileRenderer: VectorTileRenderer | null = null
  private vectorTileShows: SceneCommands['shows'] = []

  // Raw data for re-projection
  private rawDatasets = new Map<string, GeoJSONFeatureCollection>()
  private showCommands: SceneCommands['shows'] = []

  constructor(private canvas: HTMLCanvasElement) {
    this.camera = new Camera(0, 20, 2)
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
      this.globeRenderer = new GlobeRenderer(this.ctx)
      this.vectorTileRenderer = new VectorTileRenderer(this.ctx)
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
      } else if (url.endsWith('.xgvt') && !this.useCanvas2D && this.vectorTileRenderer) {
        // Vector tile file — load into VectorTileRenderer
        const response = await fetch(url)
        const buf = await response.arrayBuffer()
        this.vectorTileRenderer.loadFromBuffer(buf)
        this.rawDatasets.set(load.name, { _vectorTile: true } as unknown as GeoJSONFeatureCollection)
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

    for (const show of this.showCommands) {
      const data = this.rawDatasets.get(show.targetName)
      if (!data) continue

      // Skip raster tile sources (handled by rasterRenderer)
      if ((data as unknown as { _tileUrl?: string })._tileUrl) continue

      // Skip vector tile sources (handled by vectorTileRenderer)
      if ((data as unknown as { _vectorTile?: boolean })._vectorTile) {
        this.vectorTileShows.push(show)
        continue
      }

      const mesh = loadGeoJSON(data)
      this.renderer.addLayer(show, mesh.polygons, mesh.lines)

      // Bounds are in lon/lat degrees → project to mercator for initial camera fit
      if (mesh.polygons.bounds[0] < Infinity && isFinite(mesh.polygons.bounds[1])) {
        const [minLon, minLat, maxLon, maxLat] = mesh.polygons.bounds
        // Project bounds center to mercator for camera positioning
        const [cx, cy] = lonLatToMercator((minLon + maxLon) / 2, (minLat + maxLat) / 2)
        this.camera.centerX = cx
        this.camera.centerY = cy

        // Estimate zoom from degree extent
        const lonSpan = maxLon - minLon
        const degPerPixel = lonSpan / this.canvas.clientWidth
        this.camera.zoom = Math.max(0.5, Math.log2(360 / (degPerPixel * 256)) - 1)
      }
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
        this.canvasRenderer.addLayer(show, data, null)

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
    this.globeRenderer = new GlobeRenderer(this.ctx)

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
    resizeCanvas(this.ctx)

    const projType = {
      mercator: 0, equirectangular: 1, natural_earth: 2,
      orthographic: 3, azimuthal_equidistant: 4, stereographic: 5,
      oblique_mercator: 6,
    }[this.projectionName] ?? 0
    const { device, context, canvas } = this.ctx
    const w = canvas.width, h = canvas.height
    if (w === 0 || h === 0) { requestAnimationFrame(this.renderLoop); return }

    // RTC: Camera center IS projection center. Always.
    // Vertex shader: project(vertex) - project(center) → small f32 relative coords
    // This means: whatever you're looking at has minimum distortion.
    const R = 6378137
    const centerLon = (this.camera.centerX / R) * (180 / Math.PI)
    const centerLat = Math.max(-89, Math.min(89,
      (2 * Math.atan(Math.exp(this.camera.centerY / R)) - Math.PI / 2) * (180 / Math.PI)
    ))

    const isGlobe = projType >= 3 && projType <= 5 // orthographic, azimuthal, stereographic (not oblique mercator)
    const encoder = device.createCommandEncoder()
    const screenView = context.getCurrentTexture().createView()

    if (isGlobe) {
      // ═══ Globe mode: 2-pass rendering ═══
      // Pass 1: Render flat Equirectangular map to offscreen texture
      const flatTarget = this.globeRenderer.getFlatMapTarget()
      const flatSize = this.globeRenderer.flatMapSize

      const flatPass = encoder.beginRenderPass({
        colorAttachments: [{
          view: flatTarget,
          clearValue: { r: 0.05, g: 0.08, b: 0.12, a: 1 }, // dark ocean
          loadOp: 'clear',
          storeOp: 'store',
        }],
      })

      // Render to flat texture using equirectangular (type=1), centered at 0,0
      // Use a special "world view" camera that shows the entire world
      const flatCam = new Camera(0, 0, 0.5) // zoom 0.5 = see entire world
      this.rasterRenderer.render(flatPass, flatCam, 1, 0, 0, flatSize, flatSize)
      this.renderer.renderToPass(flatPass, flatCam, 1, 0, 0)
      flatPass.end()

      // Pass 2: Render sphere with flat map texture → screen
      this.globeRenderer.render(encoder, screenView, w, h, centerLon, centerLat, this.camera.zoom)

    } else {
      // ═══ Flat mode: direct rendering ═══
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: screenView,
          clearValue: { r: 0.05, g: 0.05, b: 0.08, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      })

      this.rasterRenderer.render(pass, this.camera, projType, centerLon, centerLat, w, h)
      this.renderer.renderToPass(pass, this.camera, projType, centerLon, centerLat)

      // Render vector tiles
      if (this.vectorTileRenderer?.hasData()) {
        for (const show of this.vectorTileShows) {
          this.vectorTileRenderer.render(
            pass, this.camera, projType, centerLon, centerLat, w, h,
            show, this.renderer.fillPipeline, this.renderer.linePipeline,
            this.renderer.uniformBuffer, this.renderer.bindGroupLayout,
          )
        }
      }

      pass.end()
    }

    device.queue.submit([encoder.finish()])

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
