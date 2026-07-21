// ═══ X-GIS SourceManager — GeoJSON / source INGEST cluster ═══
//
// Second structural decomposition of XGISMap: the source-ingest methods
// (`_attachOneSource` / `_attachGeoJSONViaVirtualPMTiles` /
// `_attachInlineGeoJSONViaVirtualPMTiles` / `_reprojectIngest` /
// `setSourceData`) live here. XGISMap keeps the source-state Maps
// (`rawDatasets` / `sourceCRS`) as the SHARED references — SourceManager
// receives the SAME Map instances by reference, so every internal read in
// renderFrame / rebuildLayers / hasPendingSourceWork / diagnostics stays
// untouched. `vtSources` registration routes through the injected
// `registerVtSource` callback (XGISMap's `_registerVtSource`) so the #1155 F3
// cold-start burst flag is applied at the single write authority.
//
// BEHAVIOR + PUBLIC API IDENTICAL — every method below is moved verbatim
// from map.ts; only the dependency wiring changed. The EPSG reproject /
// ordering, polar-cap ordering, and camera-fit logic are byte-identical:
//   - `this.rawDatasets` / `this.sourceCRS` → the same shared Map instances,
//     held here by reference.
//   - `this.vtSources.set(...)`      → injected `registerVtSource` callback
//   - `this.invalidate()`            → injected `invalidate` callback
//   - `this._fitZoomToLonSpan(...)`  → injected `fitZoomToLonSpan` callback
//   - `this._runBoundsFitGate(...)`  → injected `runBoundsFitGate` callback
//   - `this.rebuildLayers()`         → injected `rebuildLayers` callback
//   - `this.teardownSource(...)`     → injected `teardownSource` callback
//   - `this._featureIndex.delete(…)` → injected `deleteFeatureIndex` callback
//   - `this.ctx` / `this.renderer` / `this.lineRenderer` → injected
//     accessors (these are populated lazily in run() so they must be read
//     fresh, not captured at construction).
//   - `this.camera` / `this.canvas`  → injected (stable ctor-time instances).

import { assertIngestBudget, readBodyCapped, safeFetch } from '@xgis/shared'
import type { Camera } from './camera'
import type { GPUContext } from '@xgis/rhi-webgpu'
import { getMaxDpr } from '@xgis/engine'
import type { MapRendererContent } from './render/renderer'
import type { LineRenderer } from './render/line-renderer'
import {
  lonLatToMercator,
  type GeoJSONFeatureCollection,
  type GeoJSONFeature,
  type GeoJSONGeometry,
} from '@xgis/data'
import type { RawDataset } from './map-types'
import { isTileTemplate } from '@xgis/data'
import { TileCatalog } from '@xgis/data'
import { VectorTileRenderer } from './render/vector-tile-renderer'
import type { ShowSourceMaps } from './show-source-maps'
import type { SceneCommands } from './interpreter'
import { asVectorTileKind, computeGeoJSONBounds } from './map-geo-helpers'
import { attachPMTilesSource, detectVectorTileFormat } from '@xgis/data'
import { VirtualPMTilesBackend } from '@xgis/data'
import { detectCapPoles, type CapPoles } from '@xgis/data'
import * as tilingPool from '@xgis/data'
import { reprojectFeatureCollection } from '@xgis/data'
import { pointPatchToFeatureCollection, type PointPatch } from '@xgis/data'
import { decodeCoverage } from '@xgis/data'
import { SOURCE_TYPES } from '@xgis/compiler'
import type { SourceLoader } from './source-loader'

/** The built-in source `type:` values the dispatch handles natively; anything else
 *  routes to the per-map custom source-loader registry (source-loader-seam §4).
 *  DERIVED from the compiler's authoritative `SOURCE_TYPES` (the grammar-accepted
 *  set — single authority, no hand-copy to drift) plus `'xgvt'`, the
 *  runtime-internal vector-tile token that has no grammar spelling but the
 *  dispatch must still treat as built-in. */
const BUILTIN_SOURCE_TYPES = new Set<string>([...SOURCE_TYPES, 'xgvt'])

/** Dependencies SourceManager needs from the host XGISMap. */
export interface SourceManagerDeps {
  /** Shared with XGISMap — same Map instance, by reference. */
  rawDatasets: Map<string, RawDataset>
  /** #1155 F3 — register a (catalog, renderer) pair through XGISMap's single
   *  authority (`_registerVtSource`) rather than writing the shared `vtSources`
   *  Map directly, so the burst flag is applied at every registration. Both
   *  attach sites below run inside run()'s awaited load phase (before
   *  `_burst.enter()`), so the flag is a no-op today; routing through the
   *  callback keeps the single-write-authority contract true if a future
   *  dynamic-attach path reaches here post-enter.
   *
   *  #1153 P1/A7 — every registerVtSource call site is guarded by the optional
   *  `isStale` probe threaded through `_attachOneSource` /
   *  `_attachGeoJSONViaVirtualPMTiles`: a stale (superseded) run destroys its
   *  locally built pair and skips the write. Any NEW attach call site that builds
   *  a (catalog, renderer) pair MUST thread `isStale` and guard the same way, or
   *  it silently reopens the stale-write hole (fenced by the T9 regression). */
  registerVtSource: (key: string, source: TileCatalog, renderer: VectorTileRenderer) => void
  /** Shared with XGISMap — same Map instance, by reference. */
  sourceCRS: Map<string, string>
  /** Shared with XGISMap — same Map instance, by reference. Records the
   *  Mercator clamp-boundary poles each GeoJSON source touches (issue #360
   *  F1) so XGISMap's polar-cap install can synthesise the right cap(s)
   *  without re-walking the (already-tiled) feature collection. */
  geojsonCapPoles: Map<string, CapPoles>
  /** Shared with XGISMap — same Map instance, by reference. Holds the
   *  reprojected Point/MultiPoint FC per geojson source so the heatmap fork
   *  in `rebuildLayers` can read its points after this manager overwrites the
   *  source's `rawDatasets` entry with the `{ _vectorTile: true }` marker
   *  (tiled geojson moves its points into the tile backend). */
  heatmapPointData: Map<string, GeoJSONFeatureCollection>
  /** The Camera instance (stable, created in XGISMap ctor). */
  camera: Camera
  /** The raw constructor canvas — `this.canvas` on the host (NOT
   *  `getCanvas()`); the camera-fit math reads `canvas.width` directly. */
  canvas: HTMLCanvasElement
  /** The WebGPU context, read fresh (populated in run() / runBinary). */
  getCtx(): GPUContext
  /** The MapRenderer, read fresh (populated in run() / runBinary). */
  getRenderer(): MapRendererContent
  /** The shared SDF LineRenderer, read fresh (may be null pre-init). */
  getLineRenderer(): LineRenderer | null
  /** Mark a render as needed (XGISMap's `invalidate()`). */
  invalidate(): void
  /** XGISMap's `_fitZoomToLonSpan` — map a lon-span to the auto-fit zoom. */
  fitZoomToLonSpan(lonSpan: number, cssWidthPx: number): number
  /** XGISMap's `_runBoundsFitGate` — run the camera-fit effect only when
   *  the camera hasn't been explicitly positioned. */
  runBoundsFitGate(apply: () => void): boolean
  /** XGISMap's `rebuildLayers` — rebuild GPU layers from raw data. */
  rebuildLayers(): void
  /** XGISMap's `teardownSource` — destroy GPU resources for a source. */
  teardownSource(sourceId: string): void
  /** XGISMap's `_featureIndex.delete(sourceId)`. */
  deleteFeatureIndex(sourceId: string): void
  /** Per-map custom source-loader registry (`XGISMapOptions.sources`), consulted by
   *  the attach dispatch when a declared `type` is not a built-in (source-loader-seam §3). */
  sourceLoaders?: Readonly<Record<string, SourceLoader>>
}

export class SourceManager {
  // Shared Map references (same instances as XGISMap's fields).
  private readonly rawDatasets: Map<string, RawDataset>
  private readonly registerVtSource: (
    key: string,
    source: TileCatalog,
    renderer: VectorTileRenderer,
  ) => void
  private readonly sourceCRS: Map<string, string>
  private readonly geojsonCapPoles: Map<string, CapPoles>
  private readonly heatmapPointData: Map<string, GeoJSONFeatureCollection>
  private readonly camera: Camera
  private readonly canvas: HTMLCanvasElement
  private readonly getCtx: () => GPUContext
  private readonly getRenderer: () => MapRendererContent
  private readonly getLineRenderer: () => LineRenderer | null
  private readonly invalidate: () => void
  private readonly _fitZoomToLonSpan: (lonSpan: number, cssWidthPx: number) => number
  private readonly _runBoundsFitGate: (apply: () => void) => boolean
  private readonly rebuildLayers: () => void
  private readonly teardownSource: (sourceId: string) => void
  private readonly deleteFeatureIndex: (sourceId: string) => void
  private readonly sourceLoaders?: Readonly<Record<string, SourceLoader>>

  /** Per-SourceManager (≈ per-map) id used to namespace this map's GeoJSON
   *  tiling-worker indexes. The tiling worker is a process-global singleton
   *  shared by every map; without a per-caller prefix, two maps that declare
   *  a GeoJSON source with the same name (the common default 'geojson') would
   *  clobber each other's index. Also drives the `dropSource` eviction below. */
  private readonly _tilingInstanceId = tilingPool.newTilingInstanceId()

  /** The run()-scoped ShowSourceMaps captured at virtual-PMTiles attach time,
   *  so `setSourceData` can RE-seed a pushed FC through the same attach
   *  (#1235 gap 1). A data push changes no shows, so reusing the attach-time
   *  maps is exact; null until the first virtual attach of a run. */
  private _lastShowSourceMaps: ShowSourceMaps | null = null

  /** The FeatureCollection each virtual-tiled geojson source was last seeded
   *  with (#1235 gap 2). `rawDatasets` holds only the `_vectorTile` marker for
   *  these sources, so without this the host-side data is unreachable and
   *  `updateFeature` had to reject inline-declared sources. Written on every
   *  attach/re-seed; read by the feature-update queue to patch + re-seed. */
  readonly hostSeededFC = new Map<string, GeoJSONFeatureCollection>()

  constructor(deps: SourceManagerDeps) {
    this.rawDatasets = deps.rawDatasets
    this.registerVtSource = deps.registerVtSource
    this.sourceCRS = deps.sourceCRS
    this.geojsonCapPoles = deps.geojsonCapPoles
    this.heatmapPointData = deps.heatmapPointData
    this.camera = deps.camera
    this.canvas = deps.canvas
    this.getCtx = deps.getCtx
    this.getRenderer = deps.getRenderer
    this.getLineRenderer = deps.getLineRenderer
    this.invalidate = deps.invalidate
    this._fitZoomToLonSpan = deps.fitZoomToLonSpan
    this._runBoundsFitGate = deps.runBoundsFitGate
    this.rebuildLayers = deps.rebuildLayers
    this.teardownSource = deps.teardownSource
    this.deleteFeatureIndex = deps.deleteFeatureIndex
    this.sourceLoaders = deps.sourceLoaders
  }

  /** Reproject a real-FC ingest from its declared source CRS to WGS84
   *  lon/lat before it enters `rawDatasets` (and therefore before tiling
   *  / bounds / camera-fit). The declared CRS is looked up by source name
   *  in `this.sourceCRS` (built in `run()` from `commands.loads[].crs`);
   *  a source with no declared CRS is treated as EPSG:4326 and the call
   *  is a no-op that returns the same reference (no clone). An invalid /
   *  unsupported EPSG throws a clear, source-attributable error (AC7) —
   *  callers on the parallel `Promise.all` load path isolate the failure
   *  to that one source rather than aborting every load. Only call this
   *  for real FeatureCollections — never for the synthetic `_vectorTile`
   *  / `_tileUrl` markers (those carry no coordinate data).
   *
   *  Public (underscore-prefixed) as a test seam — same convention as
   *  `_runBoundsFitGate` — so integration tests can drive the ingest
   *  reprojection without a GPU device (AC3/AC7/AC8). */
  _reprojectIngest(sourceName: string, fc: GeoJSONFeatureCollection): GeoJSONFeatureCollection {
    const fromEPSG = this.sourceCRS.get(sourceName)
    if (fromEPSG === undefined) return fc // no declared CRS ⇒ 4326 / no-op
    try {
      return reprojectFeatureCollection(fc, fromEPSG)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const err = new Error(
        `[X-GIS] Failed to reproject source "${sourceName}" from ${fromEPSG}: ${msg}`,
      )
      // Tag so the parallel-load orchestrator (run()) can isolate a single
      // bad-CRS source instead of aborting every load (AC7).
      ;(err as { xgisReprojectFailure?: boolean }).xgisReprojectFailure = true
      throw err
    }
  }

  /** Attach one declared `load:` from the parsed program — dispatches
   *  by URL/format into the four supported branches:
   *    1. raster tile template (`{z}/{x}/{y}` URL)        → store URL string
   *    2. vector tile archive (.pmtiles / .tilejson / .xgvt) → spin up
   *       per-source TileCatalog + VectorTileRenderer, attach via the
   *       unified vector-tile-loader, register vtSources entry
   *    3. inline-empty source (`url: ''`)                 → empty FeatureCollection
   *    4. GeoJSON URL                                      → fetch + JSON parse
   *
   *  The five preprocessed maps from `buildShowSourceMaps` flow into
   *  the vector-tile branch only — nothing else uses them. cameraFit
   *  is shared mutable state across parallel loads ("first source that
   *  knows its bounds wins"); boxed in an object so each Promise sees
   *  the same flag. */
  async _attachOneSource(
    load: SceneCommands['loads'][0],
    baseUrl: string,
    maps: ShowSourceMaps,
    cameraFitState: { fit: boolean },
    // A7 (#1153 P1) — optional staleness probe. A superseded run()'s attach
    // promises keep settling AFTER the winner's entry-teardown; when this returns
    // true the branch destroys its locally built catalog+renderer and returns
    // WITHOUT the shared-map registerVtSource write, so a dead-device entry can't
    // overwrite the winner's same-key entry. Additive/optional — every existing
    // caller (which passes nothing) is unaffected.
    isStale?: () => boolean,
  ): Promise<void> {
    // Inline GeoJSON (`source x { data: {...} }`) — route through the SAME
    // VirtualPMTiles geojson ingest the url path uses (reproject → tile via
    // VirtualPMTilesBackend → VTR pipelines → camera-fit), just skipping the
    // fetch. Seeding only `rawDatasets` is NOT enough to render: the source
    // must be tiled with a backend exactly like url geojson, or it stays
    // invisible (real-GPU verified — rawDatasets-only seed produced a blank
    // frame even tiled+camera-fit). `data:` wins over `url:` (compiler warns).
    if (load.inlineData !== undefined && load.inlineData !== null) {
      await this._attachGeoJSONViaVirtualPMTiles(
        load.name,
        load.inlineData as GeoJSONFeatureCollection,
        maps,
        cameraFitState,
        isStale,
      )
      return
    }
    const url =
      load.url.startsWith('http') || load.url.startsWith('/') ? load.url : baseUrl + load.url
    console.log(`[X-GIS] Loading: ${load.name} from ${url}`)

    // Source `type:` from the DSL takes precedence over URL-extension
    // sniffing so a URL without a file extension (e.g. a TileJSON
    // manifest at `https://tiles.example.com/planet`) still routes
    // correctly. Without this, the misrouted URL falls into the
    // bottom `fetch().json()` branch and the JSON gets stored as a
    // FeatureCollection — which then crashes `applyFilter` because
    // there's no `.features` array.
    const declaredType = load.type

    // ── Custom source-loader registry (source-loader-seam §3.3) ──────────────
    // Hoisted BEFORE the URL-shape heuristics so a registered custom type is
    // AUTHORITATIVE — a custom source whose URL looks like a tile template (or
    // ends `.pmtiles`) must not be hijacked into the raster / PMTiles branch
    // (architect Finding D). The loader output routes through the SAME
    // `_attachGeoJSONViaVirtualPMTiles` path the geojson branch uses; a bare
    // `rawDatasets.set` seed renders a BLANK frame (see the inline-data note above).
    if (declaredType !== undefined && !BUILTIN_SOURCE_TYPES.has(declaredType)) {
      const loader = this.sourceLoaders?.[declaredType]
      if (!loader) {
        const registered = Object.keys(this.sourceLoaders ?? {})
        throw new Error(
          `[X-GIS] no loader registered for source type '${declaredType}' ` +
            `(source "${load.name}"); registered: [${registered.join(', ')}] — ` +
            `pass it in XGISMapOptions.sources.`,
        )
      }
      const result = await loader({
        id: load.name,
        url,
        options: load.options ?? {},
        fetch: (u: string) => safeFetch(u, undefined, `custom source "${load.name}"`),
      })
      const fc =
        result.kind === 'points'
          ? pointPatchToFeatureCollection(result.data as unknown as PointPatch)
          : (result.data as unknown as GeoJSONFeatureCollection)
      // Route seam marker (mirrors the geojson-URL branch's `__xgisVirtualPMTilesActive`)
      // so a real-GPU gate can assert the CUSTOM branch actually ran for this type —
      // not merely that some pixels appeared.
      if (typeof window !== 'undefined') {
        ;(window as unknown as { __xgisCustomLoaderRan?: string }).__xgisCustomLoaderRan =
          declaredType
      }
      await this._attachGeoJSONViaVirtualPMTiles(load.name, fc, maps, cameraFitState, isStale)
      return
    }
    // S-100 gridded coverage (#1158 GAP-1). A built-in `type: coverage` source:
    // fetch the `.xgcov` (same SSRF guard + body cap as the geojson branch),
    // decode to a CPU-resident CoverageHandle, and store a `{ _coverage }` marker
    // in rawDatasets (the marker union, map-types.ts). The handle is the value-
    // readout authority (map.getCoverage(...).valueAt); the renderer owns the GPU
    // texture separately.
    // REBASE HAZARD (#1153 P1): this worktree is at clean HEAD, whose _attachOneSource
    // has no `isStale` staleness probe yet. When P1's isStale threading lands, this
    // branch MUST thread it and guard the rawDatasets.set below (the marker write
    // lands after the fetch await), per P1's contract "any NEW attach call site …
    // MUST thread isStale" — otherwise a superseded run reopens the stale-write hole.
    if (declaredType === 'coverage') {
      const response = await safeFetch(url, undefined, `coverage source "${load.name}"`)
      if (!response.ok)
        throw new Error(
          `[X-GIS] Failed to load coverage "${load.name}" from ${url} — HTTP ${response.status}.`,
        )
      const rawBytes = await readBodyCapped(
        response,
        256 * 1024 * 1024,
        `coverage source "${load.name}"`,
      )
      const buf = rawBytes.buffer.slice(
        rawBytes.byteOffset,
        rawBytes.byteOffset + rawBytes.byteLength,
      )
      const handle = await decodeCoverage(buf)
      // Thread the source's display options (ramp / range, #1158) alongside the
      // handle so rebuildLayers can arm the CoverageRenderer without re-reading
      // the load command.
      this.rawDatasets.set(load.name, { _coverage: handle, ramp: load.ramp, range: load.range })
      return
    }

    // Mapbox styles declare `type: vector` / converted to `type: tilejson`
    // for MVT XYZ endpoints whose URL contains the `{z}/{x}/{y}` template.
    // Don't let the template-shape heuristic re-route those into the
    // raster path — declared vector-family type wins.
    const isDeclaredVector =
      declaredType === 'vector' || declaredType === 'tilejson' || declaredType === 'pmtiles'
    // raster-dem (#777) — guard BEFORE looksLikeRaster; see map-types.ts `_dem`.
    if (declaredType === 'raster-dem') {
      this.rawDatasets.set(load.name, {
        _tileUrl: url,
        _dem: true,
        encoding: load.encoding,
        tileSize: load.tileSize,
        redFactor: load.redFactor,
        greenFactor: load.greenFactor,
        blueFactor: load.blueFactor,
        baseShift: load.baseShift,
      })
      return
    }
    const looksLikeRaster = declaredType === 'raster' || (!isDeclaredVector && isTileTemplate(url))
    const vectorTileFormat = detectVectorTileFormat(url, asVectorTileKind(declaredType))

    if (looksLikeRaster) {
      this.rawDatasets.set(load.name, { _tileUrl: url, tileSize: load.tileSize })
      return
    }

    if (vectorTileFormat !== null) {
      const source = new TileCatalog()
      const vtRenderer = new VectorTileRenderer(this.getCtx())
      vtRenderer.setBindGroupLayout(this.getRenderer().bindGroupLayout)
      vtRenderer.setPaletteResources(
        this.getRenderer().paletteColorAtlasView,
        this.getRenderer().paletteSampler,
      ) // must be set before any tile uploads
      vtRenderer.setSpriteAtlasView(this.getRenderer().spriteAtlasView)
      vtRenderer.setPaletteResources(
        this.getRenderer().paletteColorAtlasView,
        this.getRenderer().paletteSampler,
      )
      vtRenderer.setSpriteAtlasView(this.getRenderer().spriteAtlasView)
      vtRenderer.setExtrudedPipelines(
        this.getRenderer().fillPipelineExtruded,
        this.getRenderer().fillPipelineExtrudedFallback,
      )
      vtRenderer.setGroundPipelines(
        this.getRenderer().fillPipelineGround,
        this.getRenderer().fillPipelineGroundFallback,
      )
      vtRenderer.setPatternPipelines(
        this.getRenderer().fillPipelinePatternGround,
        this.getRenderer().fillPipelinePatternGroundFallback,
      )
      vtRenderer.setPatternExtrudedPipelines(
        this.getRenderer().fillPipelinePatternExtruded,
        this.getRenderer().fillPipelinePatternExtrudedFallback,
      )
      vtRenderer.setOITPipeline(this.getRenderer().fillPipelineExtrudedOIT)
      if (this.getLineRenderer()) vtRenderer.setLineRenderer(this.getLineRenderer()!)
      vtRenderer.setFillRhi?.(this.getRenderer().fillRhiState?.() ?? null)
      vtRenderer.setSource(source) // connect before load so preloaded tiles auto-upload
      const fullUrl = url.startsWith('http') ? url : new URL(url, location.href).href
      // Inferred set + explicit `layers:` merge: explicit wins for any
      // layer not in the inferred set; inferred is typically a subset.
      const inferred = maps.usedSourceLayers.get(load.name)
      const filterLayers =
        load.layers && load.layers.length > 0
          ? load.layers
          : inferred && inferred.size > 0
            ? [...inferred]
            : undefined
      await attachPMTilesSource(source, {
        url: fullUrl,
        kind: vectorTileFormat,
        layers: filterLayers,
        extrudeExprs: maps.extrudeExprsBySource.get(load.name),
        extrudeBaseExprs: maps.extrudeBaseExprsBySource.get(load.name),
        showSlices: maps.showSlicesBySource.get(load.name),
        strokeWidthExprs: maps.strokeWidthExprsBySource.get(load.name),
        strokeColorExprs: maps.strokeColorExprsBySource.get(load.name),
      })
      // A7 — a superseded run must not register a dead-device catalog into the
      // winner's shared vtSources. Destroy the locally built pair (mirror
      // teardownSource, map.ts) and bail before any shared-map write.
      if (isStale?.()) {
        vtRenderer.destroy()
        source.destroy()
        return
      }
      this.registerVtSource(load.name, source, vtRenderer)
      this.rawDatasets.set(load.name, { _vectorTile: true })

      // Fit camera to the FIRST source that finishes. Multi-source demos
      // typically share world-bounds; "first to win" avoids order-
      // dependent racing across parallel loads. Route through
      // `_runBoundsFitGate` so an explicitly-positioned camera (setView /
      // hash / pointer / programmatic setter) is NOT clobbered when the
      // attach lands — matching the GeoJSON + inline paths.
      if (!cameraFitState.fit) {
        const vtBounds = vtRenderer.getBounds()
        if (vtBounds) {
          this._runBoundsFitGate(() => {
            cameraFitState.fit = true
            const [minLon, minLat, maxLon, maxLat] = vtBounds
            const clampedLat = Math.max(-85, Math.min(85, (minLat + maxLat) / 2))
            const [cx, cy] = lonLatToMercator((minLon + maxLon) / 2, clampedLat)
            this.camera.centerX = cx
            this.camera.centerY = cy
            // Keep centerLatDeg consistent with the fitted centerY (≤85, byte-safe).
            this.camera.syncCenterLat()
            const dpr =
              typeof window !== 'undefined'
                ? Math.min(window.devicePixelRatio || 1, getMaxDpr())
                : 1
            const cssW = this.canvas.width / dpr
            this.camera.zoom = this._fitZoomToLonSpan(maxLon - minLon, cssW)
          })
        }
      }
      return
    }

    if (load.url === '') {
      // Inline source — host pushes data later via setSourceData /
      // setSourcePoints / updateFeature.
      this.rawDatasets.set(load.name, { type: 'FeatureCollection', features: [] })
      return
    }

    // GeoJSON URL fetch. SSRF guard first — a style's source `url` is
    // host-supplied; block private/loopback/non-http(s) targets, and
    // re-check every redirect hop (safeFetch follows manually) so an
    // allowlisted host can't 302 to an internal address. Throws
    // XGISSecurityError, caught at _attachOneSource's existing boundary so
    // the bad source fails cleanly without taking down the map.
    const response = await safeFetch(url, undefined, `GeoJSON source "${load.name}"`)
    if (!response.ok) {
      throw new Error(
        `[X-GIS] Failed to load "${load.name}" from ${url} — HTTP ${response.status}. ` +
          `Check that the file exists at that path (iOS Safari otherwise surfaces this as the opaque ` +
          `"string did not match the expected pattern" when response.json() runs on an HTML 404 body).`,
      )
    }
    // DoS guard: bound the RAW body before JSON.parse (a multi-GB body
    // would OOM response.json() before the feature/vertex cap below runs),
    // then bound the parsed collection semantically. 256 MB is far above any
    // interactive dataset; larger sources should be tiled server-side.
    const rawBytes = await readBodyCapped(
      response,
      256 * 1024 * 1024,
      `GeoJSON source "${load.name}"`,
    )
    const data = JSON.parse(new TextDecoder().decode(rawBytes)) as GeoJSONFeatureCollection
    assertIngestBudget((data as { features?: unknown }).features, `GeoJSON source "${load.name}"`)

    // Phase 5f: VirtualPMTilesBackend is now the default route for
    // GeoJSON URL sources. The legacy main-thread compileSync path
    // (GeoJSONRuntimeBackend) is still available for opt-out
    // diagnostics during the rollout via either:
    //   - `window.__XGIS_USE_LEGACY_GEOJSON = true` in DevTools
    //   - `?legacy=1` query param
    // The opt-out keeps the safety net while we confirm the new
    // path is stable across every demo + fixture. Once the e2e
    // suite has run green for a stretch, the legacy path comes
    // out entirely (Phase 5f follow-up).
    const useLegacy =
      typeof window !== 'undefined' &&
      ((window as unknown as { __XGIS_USE_LEGACY_GEOJSON?: boolean }).__XGIS_USE_LEGACY_GEOJSON ===
        true ||
        /[?&]legacy=1\b/.test(window.location.search))
    const useVirtualPMTiles = !useLegacy
    if (useVirtualPMTiles) {
      // Diagnostic flag — set on `window` so the Phase 5e regression
      // spec can assert the route taken without parsing console
      // output. Cheap: one property write at attach time.
      if (typeof window !== 'undefined') {
        ;(
          window as unknown as { __xgisVirtualPMTilesActive?: boolean }
        ).__xgisVirtualPMTilesActive = true
      }
      await this._attachGeoJSONViaVirtualPMTiles(load.name, data, maps, cameraFitState, isStale)
      return
    }

    // Legacy opt-out path. Reproject declared-CRS input → WGS84 LL before
    // it enters rawDatasets (and therefore before tiling). Absent CRS ⇒
    // EPSG:4326 / no-op.
    // A7 (#1153 P1) — same stale-write hole as the default path: this write lands
    // after the safeFetch / readBodyCapped awaits above. Nothing local is built on
    // this branch, so a plain return suffices (mirrors the guarded default paths).
    if (isStale?.()) return
    this.rawDatasets.set(load.name, this._reprojectIngest(load.name, data))
  }

  /** Phase 5f-2 opt-in: attach an INLINE GeoJSON source (filtered,
   *  per-show) through VirtualPMTilesBackend, bypassing the legacy
   *  pool.compile + setRawParts + GeoJSONRuntimeBackend chain. Run
   *  when `__XGIS_USE_VIRTUAL_INLINE_GEOJSON` / `?virt_inline=1` is
   *  set AND the show carries no filter / geometryExpr (those still
   *  take the legacy path). Per-feature buffer variants (match() /
   *  gradient() colour) ride THIS path since #821: `maps` carries the
   *  same showSlices / extrude / stroke descriptors the URL-GeoJSON
   *  attach passes, so the MVT worker emits per-tile featureProps and
   *  the slice keys match the VTR's computeSliceKey lookups — the
   *  legacy path stored tiles under the default `''` slice, which the
   *  VTR never finds (permanent cache miss → blank frame). */
  _attachInlineGeoJSONViaVirtualPMTiles(
    vtKey: string,
    filtered: GeoJSONFeatureCollection,
    maps: ShowSourceMaps,
    source: TileCatalog,
  ): void {
    this._lastShowSourceMaps = maps
    this.hostSeededFC.set(vtKey, filtered)
    const inferred = maps.usedSourceLayers.get(vtKey)
    const backend = new VirtualPMTilesBackend({
      sourceName: vtKey,
      instanceId: this._tilingInstanceId,
      geojson: filtered,
      layers: inferred && inferred.size > 0 ? [...inferred] : undefined,
      extrudeExprs: maps.extrudeExprsBySource.get(vtKey),
      extrudeBaseExprs: maps.extrudeBaseExprsBySource.get(vtKey),
      showSlices: maps.showSlicesBySource.get(vtKey),
      strokeWidthExprs: maps.strokeWidthExprsBySource.get(vtKey),
      strokeColorExprs: maps.strokeColorExprsBySource.get(vtKey),
    })
    source.attachBackend(backend)

    // Camera fit from the data's bounds. Same heuristic the legacy
    // compile callback uses; the bounds come from a sync walk
    // because we don't get a tileSet callback in this path.
    this._runBoundsFitGate(() => {
      let minLon = Infinity,
        minLat = Infinity,
        maxLon = -Infinity,
        maxLat = -Infinity
      const visit = (c: unknown): void => {
        if (!Array.isArray(c)) return
        if (typeof c[0] === 'number' && typeof c[1] === 'number') {
          const lon = c[0] as number,
            lat = c[1] as number
          if (lon < minLon) minLon = lon
          if (lon > maxLon) maxLon = lon
          if (lat < minLat) minLat = lat
          if (lat > maxLat) maxLat = lat
          return
        }
        for (const inner of c) visit(inner)
      }
      for (const f of filtered.features) {
        if (f.geometry) visit((f.geometry as { coordinates?: unknown }).coordinates)
      }
      if (minLon < Infinity) {
        const clampedLat = Math.max(-85, Math.min(85, (minLat + maxLat) / 2))
        const [cx, cy] = lonLatToMercator((minLon + maxLon) / 2, clampedLat)
        this.camera.centerX = cx
        this.camera.centerY = cy
        // Keep centerLatDeg consistent with the fitted centerY (≤85, byte-safe).
        this.camera.syncCenterLat()
        const dpr =
          typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, getMaxDpr()) : 1
        const cssW = this.canvas.width / dpr
        this.camera.zoom = this._fitZoomToLonSpan(maxLon - minLon, cssW)
      }
    })

    this.invalidate()
  }

  /** Phase 5e: attach a GeoJSON source through VirtualPMTilesBackend
   *  so it flows through the catalog + MVT-worker pipeline instead
   *  of the synchronous main-thread compileSync path. Mirrors the
   *  PMTiles attach branch above — same TileCatalog + VectorTileRenderer
   *  setup, same camera-fit logic, same vtSources registry — only
   *  the backend instance differs. */
  async _attachGeoJSONViaVirtualPMTiles(
    sourceName: string,
    data: GeoJSONFeatureCollection,
    maps: ShowSourceMaps,
    cameraFitState: { fit: boolean },
    // A7 (#1153 P1) — see _attachOneSource: when the run went stale this method
    // bails at ENTRY (below), before any shared-map write or local build.
    isStale?: () => boolean,
  ): Promise<void> {
    // A7 (#1153 P1) — probe staleness at ENTRY. A superseded run's caller awaits
    // (custom loader / safeFetch+readBodyCapped) settle AFTER the winner booted;
    // there is NO await anywhere between here and the end of this method, so one
    // entry probe fully covers it. Bail BEFORE every shared-map write (the
    // geojsonCapPoles.set/delete below, and registerVtSource / rawDatasets /
    // heatmapPointData further down) and before building the dead-device VTR +
    // spawning the tiling worker. (Earlier the probe sat after the capPoles write,
    // so a stale run corrupted the winner's polar-cap record — issue #360 F1.)
    if (isStale?.()) return
    this._lastShowSourceMaps = maps
    // (Seeded-FC record for #1235 gap 2 is written AFTER the reproject below,
    // so updateFeature patches operate in the same WGS84 frame the tiler sees.)
    // Reproject declared-CRS input → WGS84 LL FIRST so both the tiling
    // backend (below) and the camera-fit bounds (computeGeoJSONBounds)
    // operate on reprojected coordinates (AC9). Absent CRS ⇒ 4326 / no-op.
    data = this._reprojectIngest(sourceName, data)
    this.hostSeededFC.set(sourceName, data)
    // Record which Mercator clamp-boundary pole(s) this source touches so
    // XGISMap's polar-cap install (issue #360 F1) can synthesise the cap(s)
    // that close the ±5° hole on globe / sphere projections. Detection runs
    // on the reprojected WGS84 LL coordinates (matching the cap mesh frame).
    const capPoles = detectCapPoles(data)
    if (capPoles.north || capPoles.south) this.geojsonCapPoles.set(sourceName, capPoles)
    else this.geojsonCapPoles.delete(sourceName)
    const source = new TileCatalog()
    const vtRenderer = new VectorTileRenderer(this.getCtx())
    vtRenderer.setBindGroupLayout(this.getRenderer().bindGroupLayout)
    vtRenderer.setPaletteResources(
      this.getRenderer().paletteColorAtlasView,
      this.getRenderer().paletteSampler,
    )
    vtRenderer.setSpriteAtlasView(this.getRenderer().spriteAtlasView)
    vtRenderer.setExtrudedPipelines(
      this.getRenderer().fillPipelineExtruded,
      this.getRenderer().fillPipelineExtrudedFallback,
    )
    vtRenderer.setGroundPipelines(
      this.getRenderer().fillPipelineGround,
      this.getRenderer().fillPipelineGroundFallback,
    )
    vtRenderer.setPatternPipelines(
      this.getRenderer().fillPipelinePatternGround,
      this.getRenderer().fillPipelinePatternGroundFallback,
    )
    vtRenderer.setPatternExtrudedPipelines(
      this.getRenderer().fillPipelinePatternExtruded,
      this.getRenderer().fillPipelinePatternExtrudedFallback,
    )
    vtRenderer.setOITPipeline(this.getRenderer().fillPipelineExtrudedOIT)
    if (this.getLineRenderer()) vtRenderer.setLineRenderer(this.getLineRenderer()!)
    vtRenderer.setFillRhi?.(this.getRenderer().fillRhiState?.() ?? null)
    vtRenderer.setSource(source)

    const inferred = maps.usedSourceLayers.get(sourceName)
    const filterLayers = inferred && inferred.size > 0 ? [...inferred] : undefined

    const backend = new VirtualPMTilesBackend({
      sourceName,
      instanceId: this._tilingInstanceId,
      geojson: data,
      layers: filterLayers,
      extrudeExprs: maps.extrudeExprsBySource.get(sourceName),
      extrudeBaseExprs: maps.extrudeBaseExprsBySource.get(sourceName),
      showSlices: maps.showSlicesBySource.get(sourceName),
      strokeWidthExprs: maps.strokeWidthExprsBySource.get(sourceName),
      strokeColorExprs: maps.strokeColorExprsBySource.get(sourceName),
    })
    source.attachBackend(backend)

    // A7 — staleness was already ruled out at entry (no await since), so the
    // dead-device catalog + shared-map writes below cannot leak into a winner.
    this.registerVtSource(sourceName, source, vtRenderer)
    // Preserve this geojson source's Point/MultiPoint features for the
    // HeatmapRenderer BEFORE the next line overwrites `rawDatasets` with the
    // `{ _vectorTile: true }` marker (points move into the tile backend). Use
    // the reprojected `data` FC so the heatmap coords match the tiled output.
    const heatmapPts = (data.features ?? []).filter(
      (f) => f.geometry?.type === 'Point' || f.geometry?.type === 'MultiPoint',
    )
    if (heatmapPts.length)
      this.heatmapPointData.set(sourceName, {
        type: 'FeatureCollection',
        features: heatmapPts,
      } as GeoJSONFeatureCollection)
    else this.heatmapPointData.delete(sourceName)
    this.rawDatasets.set(sourceName, { _vectorTile: true })

    // Camera-fit: derive bounds from the GeoJSON features themselves
    // (no remote metadata to consult, unlike PMTiles). Route through
    // `_runBoundsFitGate` so an explicitly-positioned camera (setView /
    // hash / pointer / programmatic setter) is NOT clobbered when the
    // attach lands — matching the inline path above.
    if (!cameraFitState.fit) {
      const bounds = computeGeoJSONBounds(data)
      if (bounds) {
        this._runBoundsFitGate(() => {
          cameraFitState.fit = true
          const [minLon, minLat, maxLon, maxLat] = bounds
          const clampedLat = Math.max(-85, Math.min(85, (minLat + maxLat) / 2))
          const [cx, cy] = lonLatToMercator((minLon + maxLon) / 2, clampedLat)
          this.camera.centerX = cx
          this.camera.centerY = cy
          // Keep centerLatDeg consistent with the fitted centerY (≤85, byte-safe).
          this.camera.syncCenterLat()
          const dpr =
            typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, getMaxDpr()) : 1
          const cssW = this.canvas.width / dpr
          this.camera.zoom = this._fitZoomToLonSpan(maxLon - minLon, cssW)
        })
      }
    }
  }

  /** Full-replace push for a GeoJSON source.
   *  Retiles and re-uploads only the affected source; other sources
   *  keep their existing GPU state.
   *
   *  Throws if `sourceId` was not declared in the .xgis file. */
  setSourceData(
    sourceId: string,
    data: GeoJSONFeatureCollection | GeoJSONFeature | GeoJSONGeometry,
  ): void {
    if (!this.rawDatasets.has(sourceId)) {
      throw new Error(`[X-GIS] setSourceData: unknown source "${sourceId}"`)
    }
    // Validate FeatureCollection shape. Pre-fix a host passing
    // `null` / `[]` / a Feature / a Geometry directly polluted the
    // rawDatasets entry and crashed rebuildLayers on .features
    // access. Normalise to a safe FeatureCollection rather than
    // storing whatever the caller passed verbatim.
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`[X-GIS] setSourceData: data must be a FeatureCollection object`)
    }
    // Auto-promote a single Feature → FeatureCollection (Mapbox API
    // accepts both; was previously a confusing throw). Same lift the
    // compiler-side normaliseInlineGeoJSON does for inline source.data.
    // Also accept a bare Geometry (`{ type: 'Point', coordinates: … }`)
    // by wrapping it in a Feature inside a FeatureCollection.
    // The typed union narrows directly: `data.type === 'Feature'` and the
    // `'coordinates' in data` presence check discriminate the three arms with
    // no cast. A GeometryCollection (no `coordinates`) falls to the FC arm and
    // is rejected by the features-array guard below, matching the prior path.
    let normalized: GeoJSONFeatureCollection
    if (data.type === 'Feature') {
      normalized = { type: 'FeatureCollection', features: [data] }
    } else if ('coordinates' in data) {
      // Bare Geometry (Point / LineString / Polygon / Multi*).
      normalized = {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: data, properties: {} }],
      }
    } else {
      normalized = data as GeoJSONFeatureCollection
    }
    if (!Array.isArray((normalized as { features?: unknown }).features)) {
      throw new Error(
        `[X-GIS] setSourceData: data.features must be an array (got ${typeof (normalized as { features?: unknown }).features})`,
      )
    }
    // DoS guard: refuse a pathological host-pushed collection before it
    // is reprojected / retiled / uploaded (unbounded feature/vertex OOM).
    assertIngestBudget(
      (normalized as { features?: unknown }).features,
      `setSourceData("${sourceId}")`,
    )
    // #1235 gap 1 — a source that was attached through the virtual-PMTiles
    // tiling (rawDatasets holds the `_vectorTile` marker: inline `data:` and
    // URL-loaded GeoJSON alike) must be RE-SEEDED through that same attach.
    // Writing the raw FC here instead routed the rebuild into the legacy
    // worker-compile path, which uploads fills/points but never line
    // segments — a pushed LineString silently rendered nothing. The attach
    // reprojects internally, re-registers the vt entry synchronously (no
    // await before registerVtSource), and re-writes the marker; the
    // show-source maps are the run()-scoped ones cached at attach time (a
    // data push changes no shows).
    const prev = this.rawDatasets.get(sourceId)
    if (
      prev !== undefined &&
      typeof prev === 'object' &&
      '_vectorTile' in prev &&
      this._lastShowSourceMaps !== null
    ) {
      this.deleteFeatureIndex(sourceId)
      this.teardownSource(sourceId)
      tilingPool.dropSource(this._tilingInstanceId, sourceId)
      void this._attachGeoJSONViaVirtualPMTiles(sourceId, normalized, this._lastShowSourceMaps, {
        fit: false,
      })
      this.rebuildLayers()
      this.invalidate()
      return
    }
    // Reproject declared-CRS host-pushed data → WGS84 LL after the shape
    // normalize above and BEFORE polar-cap injection / tiling (AC9). The
    // declared CRS is looked up by sourceId in the run()-time registry;
    // absent CRS ⇒ EPSG:4326 / no-op.
    normalized = this._reprojectIngest(sourceId, normalized)
    this.rawDatasets.set(sourceId, normalized)
    // Full replace invalidates any cached feature index for this source.
    this.deleteFeatureIndex(sourceId)
    this.teardownSource(sourceId)
    // Evict the old GeoJSON tiling-worker index for this source before the
    // rebuild re-tiles it. Without this the per-source GeoJSONVT index leaks
    // in the singleton worker for the process lifetime (SPA churn / repeated
    // setSourceData). Scoped to THIS map's namespaced key, so a sibling map's
    // index is untouched. Drop BEFORE rebuildLayers so the fresh setSource
    // (same key, new data) isn't the one that gets deleted.
    tilingPool.dropSource(this._tilingInstanceId, sourceId)
    this.rebuildLayers()
    this.invalidate()
  }
}
