// ═══ X-GIS Map — 전체를 연결하는 엔트리포인트 ═══

import { Lexer, Parser, lower, optimize, emitCommands, evaluate, deserializeXGB, resolveImportsAsync } from '@xgis/compiler'
import { getSharedGeoJSONCompilePool } from '../data/geojson-compile-pool'
import { initGPU, resizeCanvas, MAX_DPR, SAMPLE_COUNT, GPU_PROF, type GPUContext } from './gpu'
import { GPUTimer } from './gpu-timer'
import { Camera } from './camera'
import { MapRenderer, interpolateZoom } from './renderer'
import {
  classifyVectorTileShows as classifyVectorTileShowsImpl,
  groupOpaqueBySource as groupOpaqueBySourceImpl,
  planFrameSchedule,
  type ClassifiedShow as ExternalClassifiedShow,
  type OpaqueGroup as ExternalOpaqueGroup,
} from './bucket-scheduler'
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
import { toU32Id, pointPatchToFeatureCollection, type PointPatch } from './id-resolver'
import type { GeoJSONFeature } from '../loader/geojson'
// reprojector.ts preserved for future tile-coordinate RTT approach

interface VariantPipelines {
  fillPipeline: GPURenderPipeline
  linePipeline: GPURenderPipeline
  fillPipelineFallback?: GPURenderPipeline
  linePipelineFallback?: GPURenderPipeline
}

// ClassifiedShow + OpaqueGroup live in bucket-scheduler.ts so they're
// importable by tests. Local aliases keep the rest of map.ts terse.
type ClassifiedShow = ExternalClassifiedShow
type OpaqueGroup = ExternalOpaqueGroup

export class XGISMap {
  private ctx!: GPUContext
  private camera: Camera
  private renderer!: MapRenderer
  private rasterRenderer!: RasterRenderer
  /** Optional GPU pass timer. Null when timestamp-query is unsupported or
   *  `?gpuprof=1` is not set. When set, the FIRST opaque sub-pass each
   *  frame is timed; samples drain to `getGpuTimings()`. */
  gpuTimer: GPUTimer | null = null
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

  // External-injection update state (see setSourceData / updateFeature)
  private _pendingPatches = new Map<string, Map<number, { geometry?: GeoJSONFeature['geometry']; properties?: Record<string, unknown> }>>()
  private _pendingFlushHandle: number | null = null
  private _unknownSourceWarned = new Set<string>()
  // Lazy featureId → feature index per source, so flushPendingUpdates can
  // patch in O(patches) instead of O(features). Invalidated on setSourceData
  // (full replace) and rebuilt on demand.
  private _featureIndex = new Map<string, Map<number, GeoJSONFeature>>()

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
  /** First frame (per source) at which missedTiles became non-zero. We
   *  expect a burst during the initial 30-ish frames after a source is
   *  added — worker compile lands, then the viewport's leaf tiles
   *  compile on demand at 2/frame. Warning during that window is noise;
   *  a real FLICKER (GPU cache eviction churn, tile-drop regression)
   *  sustains past that horizon. */
  private _flickerFirstFrame = new Map<string, number>()
  private _frameCount = 0
  private static readonly FLICKER_GRACE_FRAMES = 60
  /** Wall-clock animation origin captured on the first rendered frame.
   *  `performance.now() - _startTime` yields the elapsed milliseconds
   *  fed into every time-interpolated value (opacity today, more
   *  properties in future PRs). Null until first renderFrame. */
  private _startTime: number | null = null
  private _elapsedMs = 0

  // ── Idle-render skip ──
  // Before this, `renderLoop` called `renderFrame()` every rAF (~60Hz) even
  // when nothing changed. On mobile the SDF line shader + mobile GPU is
  // heavy enough that a static minimal.xgis map pegged the tile units for
  // zero visual benefit ("엄청난 랙"). Now we compare camera state + canvas
  // size each tick and skip the frame when the signature matches, the
  // scene has no time-based animation, and no external invalidate is
  // pending. Any camera input, data push, or active animation resumes
  // per-frame rendering naturally.
  private _needsRender = true
  private _sceneHasAnimation = false
  private _lastSigZoom = NaN
  private _lastSigCX = NaN
  private _lastSigCY = NaN
  private _lastSigBearing = NaN
  private _lastSigPitch = NaN
  private _lastSigW = 0
  private _lastSigH = 0
  /** Explicit render trigger for code paths that change state outside the
   *  camera (setSourceData, updateFeature, tile load completion, etc.). */
  invalidate(): void { this._needsRender = true }

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
    this.invalidate()
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
      if (GPU_PROF) this.gpuTimer = new GPUTimer(this.ctx)
      try {
        this.pointRenderer = new PointRenderer(this.ctx)
        this.shapeRegistry = new ShapeRegistry(this.ctx.device)
        // Register user-defined symbols from DSL under the `user:` namespace
        // so they shadow built-ins of the same name instead of being silently
        // dropped by the duplicate-name guard in `addShape`.
        for (const sym of commands.symbols ?? []) {
          for (const path of sym.paths) {
            this.shapeRegistry.addUserShape(sym.name, path)
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
      } else if (load.url === '') {
        // Inline source — no URL provided. Seed with an empty
        // FeatureCollection so the host can push data later via
        // setSourceData / setSourcePoints / updateFeature.
        this.rawDatasets.set(load.name, { type: 'FeatureCollection', features: [] })
      } else {
        const response = await fetch(url)
        if (!response.ok) {
          throw new Error(
            `[X-GIS] Failed to load "${load.name}" from ${url} — HTTP ${response.status}. ` +
            `Check that the file exists at that path (iOS Safari otherwise surfaces this as the opaque ` +
            `"string did not match the expected pattern" when response.json() runs on an HTML 404 body).`,
          )
        }
        const data = await response.json() as GeoJSONFeatureCollection
        this.rawDatasets.set(load.name, data)
      }
    })
    await Promise.all(loadPromises)

    this.showCommands = commands.shows
    this._sceneHasAnimation = commands.shows.some(s =>
      !!s.timeOpacityStops || !!s.timeFillStops || !!s.timeStrokeStops ||
      !!s.timeStrokeWidthStops || !!s.timeSizeStops || !!s.timeDashOffsetStops
    )
    this._needsRender = true


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

        // Resolve zoom-interpolated size to a concrete value at the
        // current camera zoom. Evaluated once at layer build time —
        // sufficient for static displays; a zoom-aware point uniform
        // upload path is tracked as a follow-up for live resize.
        const baseSize = show.zoomSizeStops && show.zoomSizeStops.length > 0
          ? interpolateZoom(show.zoomSizeStops, this.camera.zoom)
          : (show.size ?? 8)

        // Evaluate per-feature size if data-driven
        let perFeatureSizes: number[] | null = null
        if (show.sizeExpr?.ast) {
          const ast = show.sizeExpr.ast as import('@xgis/compiler').Expr
          perFeatureSizes = filtered.features.map(f => {
            const r = evaluate(ast, f.properties ?? {})
            return typeof r === 'number' ? r : baseSize
          })
        }

        // Resolve shape name to GPU shape_id
        const shapeId = show.shape ? (this.shapeRegistry?.getShapeId(show.shape) ?? 0) : 0

        this.pointRenderer.addLayer(
          filtered.features as any,
          fill, stroke,
          show.strokeWidth,
          baseSize,
          show.opacity ?? 1.0,
          show.sizeUnit,
          perFeatureSizes,
          show.billboard,
          shapeId,
          show.anchor,
          show.zoomSizeStops ?? null,
        )
        continue
      }

      const source = new XGVTSource()
      const vtRenderer = new VectorTileRenderer(this.ctx)
      vtRenderer.setBindGroupLayout(this.renderer.bindGroupLayout)
      if (this.lineRenderer) vtRenderer.setLineRenderer(this.lineRenderer)
      vtRenderer.setSource(source)
      this.vtSources.set(vtKey, { source, renderer: vtRenderer })

      // Offload `decomposeFeatures` + `compileGeoJSONToTiles(z0)` to a
      // worker so earcut over 10k+ features no longer blocks the main
      // thread. The source is created empty up-front; when the pool
      // returns we call `addTileLevel` + `setRawParts` + fit the camera.
      // Legacy behaviour (synchronous fit + first-frame z0) is preserved
      // in the fallback path when the worker pool is unavailable.
      //
      // Stable-id policy (`feature.id` → `properties.id` → index) lives
      // in the worker now via the `'feature-id-fallback'` mode; see
      // `geojson-compile-worker.ts:resolveIdResolver`.
      const pool = getSharedGeoJSONCompilePool()
      const compilePromise = pool.compile(filtered, 0, 0, 'feature-id-fallback')
      // Capture the entry we just registered so a stale completion (arriving
      // after a re-teardown) cannot overwrite a newer source under the same
      // key — `setSourceData` / `teardownSource` deletes the entry, and we
      // only apply results if the pointer still matches.
      const registeredEntry = this.vtSources.get(vtKey)
      compilePromise.then(({ parts, tileSet }) => {
        if (this.vtSources.get(vtKey) !== registeredEntry) return // superseded
        if (tileSet.levels.length > 0) {
          source.addTileLevel(tileSet.levels[0], tileSet.bounds, tileSet.propertyTable)
        }
        source.setRawParts(parts, tileSet.levels.length > 0 ? 7 : 0)

        // Feature data buffer MUST be built after the property table
        // is set on the source — which only happens in `addTileLevel`
        // above. Building it earlier (inside the sync rebuildLayers
        // block below) silently no-ops because `getPropertyTable()`
        // returns undefined before the worker returns, leaving the
        // variant pipeline paired with the default bind-group layout
        // and tripping a WebGPU validation error on every draw. Fixture
        // audit surfaced this as the `match()`-based fixtures
        // (fixture_categorical, reftest_triangle_match, etc.) logging
        // "Bind group layout of pipeline layout does not match layout
        // of bind group".
        const variant = show.shaderVariant
        if (variant && variant.needsFeatureBuffer && !vtRenderer.hasFeatureData()) {
          vtRenderer.buildFeatureDataBuffer(variant as import('@xgis/compiler').ShaderVariant, this.renderer.featureBindGroupLayout)
        }
        // Worker result just landed — wake the render loop to paint it.
        this.invalidate()

        // Fit camera once the compile lands. For the fallback (sync) path
        // this still runs inside the same microtask, so users see the same
        // "camera snaps to data on load" behaviour they had before.
        const [minLon, minLat, maxLon, maxLat] = tileSet.bounds
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
      }).catch((err) => {
        console.error('[X-GIS] GeoJSON compile failed:', err)
      })

      // Setup shader variant if needed. The pipeline + layout must be
      // wired synchronously (they're stored on vectorTileShows and read
      // by the render loop every frame), but the feature data buffer
      // itself is built inside the compile-promise `.then()` above —
      // the property table it needs only exists after the worker
      // compile lands.
      let pipelines: typeof this.vtVariantPipelines = null
      let layout: GPUBindGroupLayout | null = null
      const variantSync = show.shaderVariant
      if (variantSync && (variantSync.preamble || variantSync.needsFeatureBuffer)) {
        try {
          pipelines = this.renderer.getOrCreateVariantPipelines(variantSync as any)
          layout = variantSync.needsFeatureBuffer
            ? this.renderer.featureBindGroupLayout
            : this.renderer.bindGroupLayout
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
    if (GPU_PROF) this.gpuTimer = new GPUTimer(this.ctx)
      try { this.pointRenderer = new PointRenderer(this.ctx) } catch (e) { console.warn('[X-GIS] PointRenderer init failed:', e) }

    for (const load of commands.loads) {
      const url = load.url.startsWith('http') || load.url.startsWith('/') ? load.url : baseUrl + load.url
      const response = await fetch(url)
      const data = await response.json() as GeoJSONFeatureCollection
      this.rawDatasets.set(load.name, data)
    }

    this.showCommands = commands.shows
    this._sceneHasAnimation = commands.shows.some(s =>
      !!s.timeOpacityStops || !!s.timeFillStops || !!s.timeStrokeStops ||
      !!s.timeStrokeWidthStops || !!s.timeSizeStops || !!s.timeDashOffsetStops
    )
    this._needsRender = true
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
    if (!this.shouldRenderThisFrame()) {
      requestAnimationFrame(this.renderLoop)
      return
    }
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

  /** Decide whether `renderLoop` should actually call `renderFrame()`.
   *  Skips the frame when the camera and canvas are unchanged since the
   *  last draw AND no animation / pending data source needs to advance.
   *  `renderFrame` itself updates the stored signature and clears
   *  `_needsRender` after a successful draw. */
  private shouldRenderThisFrame(): boolean {
    if (this._needsRender) return true
    if (this._sceneHasAnimation) return true
    if (this.hasPendingSourceWork()) return true
    const c = this.camera
    const canvas = this.ctx?.canvas
    const w = canvas?.width ?? 0, h = canvas?.height ?? 0
    return (
      c.zoom !== this._lastSigZoom ||
      c.centerX !== this._lastSigCX ||
      c.centerY !== this._lastSigCY ||
      c.bearing !== this._lastSigBearing ||
      c.pitch !== this._lastSigPitch ||
      w !== this._lastSigW ||
      h !== this._lastSigH
    )
  }

  /** Returns true when any source has tile loads / compile work queued for
   *  this frame. Prevents stranding off-screen loads once the camera settles. */
  private hasPendingSourceWork(): boolean {
    for (const { source } of this.vtSources.values()) {
      if (source.hasPendingLoads?.()) return true
    }
    return false
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
  /** Thin instance wrapper around the pure classifier in
   *  `bucket-scheduler.ts`. Bundles up the instance state the
   *  classifier needs into a single param object so the underlying
   *  function stays testable in isolation. */
  private classifyVectorTileShows(): {
    opaque: ClassifiedShow[]
    translucent: ClassifiedShow[]
  } {
    return classifyVectorTileShowsImpl({
      vectorTileShows: this.vectorTileShows,
      vtSources: this.vtSources,
      cameraZoom: this.camera.zoom,
      elapsedMs: this._elapsedMs,
      rendererDefaults: {
        fillPipeline: this.renderer.fillPipeline,
        linePipeline: this.renderer.linePipeline,
        bindGroupLayout: this.renderer.bindGroupLayout,
        fillPipelineFallback: this.renderer.fillPipelineFallback,
        linePipelineFallback: this.renderer.linePipelineFallback,
      },
    })
  }

  /** Thin instance wrapper around the pure grouper in
   *  `bucket-scheduler.ts`. */
  private groupOpaqueBySource(opaque: ClassifiedShow[]): OpaqueGroup[] {
    return groupOpaqueBySourceImpl(opaque)
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

    // Clamp camera Y (latitude bounded), wrap X to a single world.
    const MAX_MERC = 20037508.34
    const WORLD_MERC_FULL = MAX_MERC * 2 // full circumference
    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, MAX_DPR) : 1
    const mpp = (40075016.686 / 256) / Math.pow(2, this.camera.zoom)
    const visHalfY = (h / dpr) * mpp / 2
    const maxY = Math.max(0, MAX_MERC - visHalfY)
    this.camera.centerY = Math.max(-maxY, Math.min(maxY, this.camera.centerY))

    // X wrap — camera is allowed to pan infinitely in either direction, but
    // the renderer's world-copy enumeration (`WORLD_COPIES = [-2..+2]`) is
    // expressed as a STATIC offset from the camera's primary world. If
    // camera.centerX drifts outside `[-MAX_MERC, +MAX_MERC]` the outer
    // copies on one side fall off the quadtree's `ox` guard (tiles.ts)
    // while the other side is empty, producing a visible "window" of map
    // inside a black background when panning past ±360° lon. Wrap back
    // into one world so the WORLD_COPIES math is always correct.
    if (this.camera.centerX > MAX_MERC) {
      const over = this.camera.centerX + MAX_MERC
      this.camera.centerX = ((over % WORLD_MERC_FULL) + WORLD_MERC_FULL) % WORLD_MERC_FULL - MAX_MERC
    } else if (this.camera.centerX < -MAX_MERC) {
      const under = this.camera.centerX + MAX_MERC
      this.camera.centerX = ((under % WORLD_MERC_FULL) + WORLD_MERC_FULL) % WORLD_MERC_FULL - MAX_MERC
    }

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
      // sample count tracks the pipeline-time SAMPLE_COUNT (1 on mobile /
      // ?safe / ?quality=performance / ?msaa=1, 4 on desktop default).
      const sc = SAMPLE_COUNT
      const useResolve = sc > 1
      if (!this.stencilTexture || this.msaaWidth !== w || this.msaaHeight !== h) {
        this.msaaTexture?.destroy()
        this.stencilTexture?.destroy()
        // Allocate the MSAA color attachment ONLY when MSAA is on. When
        // sc === 1 we render straight to the swapchain (no resolveTarget)
        // and the MSAA texture would just waste w×h×4 bytes per frame.
        this.msaaTexture = useResolve
          ? device.createTexture({
              size: { width: w, height: h },
              format: this.ctx.format,
              sampleCount: sc,
              usage: GPUTextureUsage.RENDER_ATTACHMENT,
            })
          : null
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
      const colorView = useResolve ? this.msaaTexture!.createView() : screenView

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
      // ── Two independent point paths ──
      //
      // 1. TILE points: data lives on xgvt tiles (e.g. countries_xgvt
      //    + populated_places_xgvt). VTR drains them per-source via
      //    pointRenderer.addTilePoint/flushTilePoints inside its own
      //    render pass. We pass `pointRenderer` to every VTR.render
      //    call below — VTR's tile loop is a no-op for sources that
      //    don't carry point vertices, so this is safe and free.
      //
      // 2. DIRECT-LAYER points: GeoJSON sources where rebuildLayers
      //    routed the show into pointRenderer.addLayer() instead of
      //    creating a vector-tile pipeline. These live in
      //    pointRenderer.layers and are rendered by a dedicated bucket
      //    3 pass. They are NEVER reachable from VTR.render — VTR
      //    only sees tile data.
      //
      // The original `inlinePoints` optimization conflated these two
      // paths and silently skipped bucket 3 whenever there was no
      // translucent layer, hiding every direct-layer point demo
      // (sdf_points, gradient_points, megacities, custom_*, etc).
      // Fix: bucket 3 always runs when direct-layer points exist.
      // Which pass owns the MSAA resolveTarget? Precisely the last
      // pass that writes to the color target. Priority: dedicated
      // points > last composite > last opaque sub-pass.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const _resolveOwner = hasPoints
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
        // Depth must persist across opaque sub-passes so group N's
        // polygons are correctly occluded by group N-1's (e.g. roads
        // rendered after buildings must respect building depth in a
        // pitched / globe view), and across into the points bucket for
        // the same reason. Only the final consumer can discard. Tile-
        // based mobile GPUs pay a write-back when we store, but the
        // result was visibly wrong without it.
        const persistDepth = !isLastOpaque || hasPoints

        passScope(isFirst ? 'opaque-main' : `opaque[${gi}]`, () => {
          // Time only the FIRST opaque sub-pass — that's where raster +
          // the heaviest vector source draws. Additional groups would need
          // their own QuerySet to time independently; for the perf-investigation
          // workload (multi_layer) one sub-pass usually covers everything.
          const tsWrites = (isFirst && this.gpuTimer?.passWrites()) || undefined
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
              // First sub-pass clears depth; subsequent ones load the
              // depth their predecessor stored.
              depthLoadOp: isFirst ? 'clear' : 'load',
              depthStoreOp: persistDepth ? 'store' : 'discard',
              // Stencil IS still per-sub-pass — each opaque group uses
              // unique IDs for its own polygon coverage and they don't
              // need to survive across groups.
              stencilClearValue: 0,
              stencilLoadOp: 'clear',
              stencilStoreOp: 'discard',
            },
            timestampWrites: tsWrites,
          })

          // First opaque pass owns raster + canvas-2D background
          // content. These are always the back-most layers in the
          // current architecture.
          if (isFirst) {
            this.rasterRenderer.render(subPass, this.camera, projType, centerLon, centerLat, w, h)
            this.renderer.renderToPass(subPass, this.camera, projType, centerLon, centerLat, this._elapsedMs)
          }

          // Render the group's vector tile shows (if any). In a
          // points-only demo (no opaque vector tile layers at all)
          // `group` is undefined and the synthetic first pass exists
          // only to clear the canvas + draw raster + draw legacy
          // MapRenderer layers. We MUST still call subPass.end() in
          // that case, otherwise the pass stays open and bucket 3
          // (or any subsequent encoder operation) trips a
          // "RenderPassEncoder is open" validation error.
          if (group) {
            for (let si = 0; si < group.shows.length; si++) {
              const cs = group.shows[si]
              // Always pass pointRenderer so VTR can flush any TILE
              // points stored on this source's xgvt data. The tile
              // loop short-circuits when no point vertices exist,
              // so there's no cost for plain polygon/line sources.
              // Direct-layer points (pointRenderer.addLayer
              // registered) are rendered separately in bucket 3
              // below.
              cs.vtEntry.renderer.render(
                subPass, this.camera, projType, centerLon, centerLat, w, h,
                cs.show, cs.fp, cs.lp, this.renderer.uniformBuffer, cs.bgl,
                cs.fpF, cs.lpF,
                this.pointRenderer,
                cs.fillPhase,
              )
            }
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

      // ── Bucket 3: direct-layer points ──
      // Renders pointRenderer.layers (GeoJSON sources routed through
      // pointRenderer.addLayer in rebuildLayers). Always runs when
      // direct layers exist; tile-points are handled inline in
      // bucket 1 via VTR.render's pointRenderer parameter.
      if (hasPoints) {
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
              // Load the depth the last opaque sub-pass stored above so
              // billboards on the back side of a globe / pitched surface
              // are correctly occluded by the front-facing opaque
              // polygons. Translucent points still skip depth WRITES
              // (their pipeline disables depthWriteEnabled), so a halo
              // doesn't block other markers — but they DO depth-test.
              depthClearValue: 1.0, depthLoadOp: 'load', depthStoreOp: 'discard',
              stencilClearValue: 0, stencilLoadOp: 'clear', stencilStoreOp: 'discard',
            },
          })
          // Re-evaluate zoom-interpolated point sizes against the
          // current camera before drawing. No-op for layers without
          // zoomSizeStops; internally skipped when zoom is unchanged.
          this.pointRenderer!.updateDynamicSizes(this.camera.zoom, interpolateZoom)
          this.pointRenderer!.render(ptPass, this.camera, centerLon, centerLat, w, h)
          ptPass.end()
        })
      }
    }

    // Flush CPU-side uniform-ring mirrors just before submit. WebGPU
    // orders writeBuffer-before-submit for us, so the encoded draws
    // still see fresh uniform data even though the writes happen
    // after encoder.finish(). Covers MapRenderer's `uniform-ring` and
    // LineRenderer's `line-layer-ring`; VTR's `vtr-uniform-ring`
    // already self-flushes at the end of each renderTileKeys.
    this.renderer.endFrame()
    this.lineRenderer?.endFrame()

    // GPU timing: resolve the queryset BEFORE finish so the same command
    // buffer carries the resolve+copy. Mapping happens after submit.
    this.gpuTimer?.resolveOnEncoder(encoder)

    // Outer scope catches the FRAME-level error (one entry per bad frame),
    // matching the inner scope opened right after createCommandEncoder().
    device.queue.submit([encoder.finish()])

    // Drain any readbacks that finished mapping last frame, kick mapAsync
    // on freshly-submitted ones. Cheap when disabled (no-op).
    this.gpuTimer?.pollReadbacks()
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
        // Grace period — ignore FLICKER for the first N frames after we
        // first observe missedTiles > 0 on this source. Initial-load
        // compile bursts routinely show 1–16 missed tiles for 2–8 frames
        // as on-demand compilation catches up; warning there is noise.
        // Only fire when missedTiles persist past the grace window, which
        // means an actual regression (GPU cache thrash, tile-drop bug).
        let firstSeen = this._flickerFirstFrame.get(name)
        if (firstSeen === undefined) {
          firstSeen = this._frameCount
          this._flickerFirstFrame.set(name, firstSeen)
        }
        const framesSinceFirst = this._frameCount - firstSeen
        if (framesSinceFirst >= XGISMap.FLICKER_GRACE_FRAMES) {
          const last = this._flickerLastFrame.get(name) ?? -Infinity
          if (this._frameCount - last >= 60) {
            this._flickerLastFrame.set(name, this._frameCount)
            console.warn(`[FLICKER] ${name}: ${vts.missedTiles} tiles without fallback (z=${Math.round(this.camera.zoom)} gpuCache=${vtR.getCacheSize()})`)
          }
        }
      } else {
        // Clean frame clears the first-seen marker so a later burst (e.g.
        // after pan to a new region) gets its own grace window.
        this._flickerFirstFrame.delete(name)
      }
    }
    this._frameCount++
    this._stats.tilesVisible = totalTilesVis
    this._stats.tilesCached = totalTilesCached
    this._stats.endFrame()
    this._statsPanel?.update(this._stats.get())

    // Snapshot state for the idle-skip comparator in `shouldRenderThisFrame`.
    // Animation ticks + external invalidate() re-arm `_needsRender` on their
    // own path, so clearing it unconditionally here is safe.
    this._lastSigZoom = this.camera.zoom
    this._lastSigCX = this.camera.centerX
    this._lastSigCY = this.camera.centerY
    this._lastSigBearing = this.camera.bearing
    this._lastSigPitch = this.camera.pitch
    this._lastSigW = this.ctx.canvas.width
    this._lastSigH = this.ctx.canvas.height
    this._needsRender = false

    // Tile/texture loads still in flight keep the loop warm so the scene
    // converges. Covers three sources:
    //   - VT tiles with unresolved placeholders (missedTiles > 0)
    //   - VT tiles queued behind the per-frame upload budget
    //   - raster tiles mid-fetch
    if (totalMissed > 0 || this.rasterRenderer.hasPendingLoads()) {
      this._needsRender = true
    } else {
      for (const [, { renderer }] of this.vtSources) {
        if (renderer.hasPendingUploads()) { this._needsRender = true; break }
      }
    }

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

  // ═══ External data injection API ═══════════════════════════════
  //
  // Host applications that hold their own data (C2 tracks, sensor
  // feeds, geofences) push it in via these methods instead of having
  // X-GIS fetch a URL. The source must be declared in the .xgis file
  // with `source X { type: geojson }` (no url) so run() can seed an
  // empty placeholder that setSourceData then fills.

  /** Destroy GPU resources for every vtSources entry belonging to
   *  `sourceId` (including its filtered variants keyed `id__N`). */
  private teardownSource(sourceId: string): void {
    for (const [key, entry] of this.vtSources) {
      if (key === sourceId || key.startsWith(`${sourceId}__`)) {
        entry.renderer.destroy()
        this.vtSources.delete(key)
      }
    }
  }

  /** Full-replace push for a GeoJSON source.
   *  Retiles and re-uploads only the affected source; other sources
   *  keep their existing GPU state.
   *
   *  Throws if `sourceId` was not declared in the .xgis file. */
  setSourceData(sourceId: string, data: GeoJSONFeatureCollection): void {
    if (!this.rawDatasets.has(sourceId)) {
      throw new Error(`[X-GIS] setSourceData: unknown source "${sourceId}"`)
    }
    this.rawDatasets.set(sourceId, data)
    // Full replace invalidates any cached feature index for this source.
    this._featureIndex.delete(sourceId)
    this.teardownSource(sourceId)
    this.rebuildLayers()
    this.invalidate()
  }

  /** Typed-array fast path for point sources.
   *
   *  The host passes parallel Float32Arrays of longitudes and
   *  latitudes plus an optional `Uint32Array` of stable ids. This
   *  bypasses GeoJSON authoring on the host side — the dominant
   *  cost in high-rate track scenarios — at the price of synthesizing
   *  a minimal FeatureCollection inside X-GIS. A truly zero-alloc
   *  pointRenderer path is deferred to PR 2; the public API is the
   *  fast path so callers don't need to change when that lands.
   *
   *  Current volume sweet spot: a few thousand points at 10 Hz.
   *  Beyond that, the PR 2 optimization becomes necessary.
   *
   *  Throws on length mismatch between lon / lat / ids. */
  setSourcePoints(sourceId: string, data: PointPatch): void {
    this.setSourceData(sourceId, pointPatchToFeatureCollection(data))
  }

  /** Feature-level mutation. Enqueues a patch and coalesces all
   *  pending updates within a single rAF into one retile per source.
   *
   *  `featureId` matches the stable id (GeoJSON feature.id → u32).
   *  Unknown source or feature logs a warn-once and drops the patch
   *  (a host race under reconnect is expected, not fatal). */
  updateFeature(
    sourceId: string,
    featureId: number,
    patch: { geometry?: GeoJSONFeature['geometry']; properties?: Record<string, unknown> },
  ): void {
    if (!this.rawDatasets.has(sourceId)) {
      if (!this._unknownSourceWarned.has(sourceId)) {
        console.warn(`[X-GIS] updateFeature: unknown source "${sourceId}"`)
        this._unknownSourceWarned.add(sourceId)
      }
      return
    }
    let bySource = this._pendingPatches.get(sourceId)
    if (!bySource) {
      bySource = new Map()
      this._pendingPatches.set(sourceId, bySource)
    }
    const existing = bySource.get(featureId)
    bySource.set(featureId, {
      geometry: patch.geometry ?? existing?.geometry,
      properties: { ...(existing?.properties ?? {}), ...(patch.properties ?? {}) },
    })
    this.scheduleFlushPendingUpdates()
    this.invalidate()
  }

  private scheduleFlushPendingUpdates(): void {
    if (this._pendingFlushHandle !== null) return
    const raf = (typeof window !== 'undefined' && window.requestAnimationFrame)
      ? window.requestAnimationFrame.bind(window)
      : (cb: FrameRequestCallback): number => setTimeout(() => cb(performance.now()), 16) as unknown as number
    this._pendingFlushHandle = raf(() => this.flushPendingUpdates())
  }

  private flushPendingUpdates(): void {
    this._pendingFlushHandle = null
    if (this._pendingPatches.size === 0) return

    for (const [sourceId, patches] of this._pendingPatches) {
      const data = this.rawDatasets.get(sourceId)
      if (!data) continue
      // Lookup via featureId index so patching is O(patches) instead of
      // O(features). The index is built once per source and reused across
      // flush cycles until setSourceData replaces the dataset.
      let index = this._featureIndex.get(sourceId)
      if (!index) {
        index = new Map()
        for (const f of data.features) {
          index.set(toU32Id(f.id ?? f.properties?.id), f)
        }
        this._featureIndex.set(sourceId, index)
      }
      for (const [fid, patch] of patches) {
        const f = index.get(fid)
        if (!f) continue
        if (patch.geometry) f.geometry = patch.geometry
        if (patch.properties) {
          f.properties = { ...(f.properties ?? {}), ...patch.properties }
        }
      }
      // Trigger a single retile for this source.
      this.teardownSource(sourceId)
    }
    this._pendingPatches.clear()
    this.rebuildLayers()
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
