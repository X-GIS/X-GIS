// ═══ Raster Tile Renderer — 텍스처 타일을 GPU 투영으로 렌더링 ═══

import type { GPUContext } from '@xgis/engine'
import type { Camera } from '@xgis/engine'
import { visibleTilesFrustum, tileUrl, loadImageTexture } from '@xgis/data'
import { mercator as mercatorProj, mercatorYToLat } from '@xgis/engine'
import { lonLatToECEF, type ECEF } from '@xgis/engine'
import type { RhiDevice, RhiRenderPass, RhiTexture } from '@xgis/engine'
import { RasterDraper, type RasterTile } from './material/raster-material'
import { wrapWebGpuPass } from '@xgis/engine'
import { routeToSphereSelector, enumerateWorldCopies } from '@xgis/engine'
import { isPickEnabled, getSampleCount } from '@xgis/engine'
import { DEBUG_OVERDRAW } from '../debug-flags'
import { globeVisibleTiles } from '@xgis/engine'
import { writeProjectionCull } from './frame-projection-uniform'
import { rasterUniformSlots, rasterUniformBytes, rasterTileSlots } from './raster-uniform-slots'

/** Camera RTC anchor for the raster VS on the globe / 3D surfaces.
 *
 *  MUST be the WGS84 **ellipsoid** ECEF of the camera centre (lonLatToECEF,
 *  E2≠0) — the same frame `lonlat_to_ecef` reconstructs the raster tile
 *  vertices in. The camera's `getECEFCenter()` is the **sphere** (E2=0);
 *  subtracting a sphere anchor from ellipsoid vertices leaves the
 *  ellipsoid−sphere discrepancy (~21.5 km at mid-latitude) on every vertex,
 *  which threw the whole raster sheet off the globe. Mirrors the vector
 *  tiler's ellipsoid `cam_ecef_off` (vector-tile-renderer.ts:3627-3638). */
export function rasterGlobeCamAnchor(lonDeg: number, latDeg: number): ECEF {
  return lonLatToECEF(lonDeg, latDeg)
}

interface CachedTile {
  texture: GPUTexture
  lastUsedFrame: number
  firstShownFrame: number
  // Bind group referencing this tile's texture view. Immutable after load —
  // cached here so the hot render loop doesn't create one per tile per frame.
  globalBG?: GPUBindGroup
}

const MAX_CACHED_TILES = 256
const MAX_CONCURRENT_LOADS = 6

export class RasterRenderer {
  private device: GPUDevice
  /** The injected backend RHI device (ctx.rhi) — the RasterDraper routes resource
   *  creation through it (WebGpuDevice on WebGPU, WebGl2Device under ?forcegl2=1). */
  private readonly rhi: RhiDevice
  private format: GPUTextureFormat = 'bgra8unorm'

  // LRU tile cache
  private tileCache = new Map<string, CachedTile>()
  private loadingTiles = new Map<string, AbortController>()
  private frameCount = 0
  private lastZoom = -1
  /** Visible-tile keys captured from the previous frame's render(). Used by
   *  the next beginFrame()'s deferred eviction to know which tiles to
   *  protect — see the parallel pattern in
   *  VectorTileRenderer.beginFrame() (commit da4f26f). */
  private lastVisibleKeys: Set<string> = new Set()

  private urlTemplate = ''
  /** Mapbox `raster-opacity`, resolved per frame by the orchestrator.
   *  1.0 = fully opaque (the default for layers that didn't author
   *  `raster-opacity`). The fragment shader multiplies the sampled
   *  alpha by this value so the basemap can fade over the background
   *  the way MapLibre handles e.g. OFM Liberty's natural-earth
   *  shaded relief. */
  private _opacity = 1.0
  /** Mapbox raster colour adjustments, resolved per frame by the
   *  orchestrator (opaque-pass) from the active raster show's
   *  `paintShapes.raster`. ALL defaults are a hard no-op (hue 0, brightness
   *  range 0..1, saturation 0, contrast 0) so an un-authored raster show is
   *  byte-identical to sampling the texel unchanged. */
  private _hueRotate = 0
  private _brightnessMin = 0
  private _brightnessMax = 1
  private _saturation = 0
  private _contrast = 0
  /** True when `raster-resampling: nearest` is active. Default false
   *  (linear) is byte-identical to today's fixed-linear sampler. */
  private _nearest = false
  private drawTileF32 = new Float32Array(rasterTileSlots().slots) // reflect-derived (= bounds4+tile_ecef4+merc_y2+pad2 = 12)

  // ── Forced-WebGL2 raster slice (US-003) ──
  // A SECOND draper backed by the WebGl2Device (host.ctx.rhi), drawing an analytic
  // checker tile through the engine's RHI screen pass — the milestone proof that a real
  // layer renders on the WebGL2 backend, not just offscreen. Distinct from `_rasterDraper`
  // (the WebGPU pilot). Created lazily on the first forced-WebGL2 frame.
  private _rhiDraper?: RasterDraper
  private _rhiChecker?: RhiTexture
  /** The WebGPU RasterDraper — render()'s sole draw path (P1.4). Lazily built with the
   *  swapchain format + sample count; rebuilt on a quality (MSAA) change via invalidation. */
  private _rasterDraper?: RasterDraper
  private ensureRasterDraper(): RasterDraper {
    return (this._rasterDraper ??= new RasterDraper(this.rhi, this.format, getSampleCount()))
  }

  constructor(ctx: GPUContext) {
    this.device = ctx.device
    this.rhi = ctx.rhi
    this.format = ctx.format

    // The raster draw goes through the RHI Material seam (RasterDraper, lazily built in
    // ensureRasterDraper): it owns the pipelines (non-pick + pick MRT), bind-group layouts,
    // the linear/nearest samplers, the global uniform + the per-tile pool. The renderer keeps
    // only its tile cache + the per-frame paint params (_opacity/_nearest/…).
  }

  /** A quality (MSAA / picking) change invalidates the raster draper so the next render()
   *  lazily rebuilds its pipelines with the new getSampleCount() / isPickEnabled(). */
  rebuildForQuality(): void {
    this._rasterDraper = undefined
  }

  setUrlTemplate(url: string): void {
    this.urlTemplate = url
  }

  /** Set the per-frame opacity multiplier (Mapbox `raster-opacity`).
   *  Caller resolves the show's PropertyShape<number> via
   *  `resolveNumberShape` before the frame's `render()` call.
   *  Defaults to 1.0; a show that doesn't author opacity leaves the
   *  previous value in place — single-raster scenes are fine but
   *  multi-raster mixing would need a per-tile or per-show extension. */
  setOpacity(opacity: number): void {
    // Reject NaN / Infinity / non-numeric explicitly. Math.max /
    // Math.min PROPAGATE NaN — `Math.max(0, Math.min(1, NaN))` is
    // NaN, not 0 — so the previous clamp silently let a NaN
    // raster-opacity reach the fragment shader, which multiplied
    // every sampled texel by NaN and the whole layer disappeared.
    if (typeof opacity !== 'number' || !Number.isFinite(opacity)) return
    this._opacity = Math.max(0, Math.min(1, opacity))
  }

  /** Set the per-frame Mapbox raster colour adjustments. Caller resolves
   *  each `paintShapes.raster.*` PropertyShape<number> before render().
   *  Non-finite inputs fall back to the spec default (a no-op) so a
   *  malformed value can't NaN-poison the texel like opacity used to. */
  setColorAdjust(hueRotate: number, brightnessMin: number, brightnessMax: number, saturation: number, contrast: number): void {
    const f = (v: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
    this._hueRotate = f(hueRotate, 0)
    // Mapbox spec ranges: brightness 0..1, saturation/contrast -1..1.
    this._brightnessMin = Math.max(0, Math.min(1, f(brightnessMin, 0)))
    this._brightnessMax = Math.max(0, Math.min(1, f(brightnessMax, 1)))
    this._saturation = Math.max(-1, Math.min(1, f(saturation, 0)))
    this._contrast = Math.max(-1, Math.min(1, f(contrast, 0)))
  }

  /** Select the sampler filter for `raster-resampling` ('linear' default |
   *  'nearest'). Flipping invalidates the cached per-tile bind groups so
   *  the next render rebuilds them against the new sampler. Default linear
   *  is byte-identical to today. */
  setResampling(nearest: boolean): void {
    // `_nearest` is forwarded to draper.draw(); the RasterDraper caches its global bind group
    // per (texture, pick, resampling), so flipping needs no cache invalidation here.
    this._nearest = nearest
  }

  /** True while any tile fetch is still in flight. The map's render loop
   *  polls this to keep ticking during load — newly-arrived textures need
   *  one more frame to show up, but arrivals don't fire a direct callback
   *  today, so we just keep the loop warm until the queue drains. */
  hasPendingLoads(): boolean {
    return this.loadingTiles.size > 0
  }

  /** Lazily build the 256×256 RGBA checker as an RHI texture (WebGl2Device path). */
  private ensureRhiChecker(rhi: RhiDevice): RhiTexture {
    if (this._rhiChecker) return this._rhiChecker
    const N = 256, C = 32
    const data = new Uint8Array(N * N * 4)
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const on = (((x / C) | 0) + ((y / C) | 0)) % 2 === 0
        const i = (y * N + x) * 4
        data[i] = on ? 240 : 30; data[i + 1] = on ? 80 : 30; data[i + 2] = on ? 40 : 120; data[i + 3] = 255
      }
    }
    const tex = rhi.createTexture({ width: N, height: N, format: 'rgba8unorm', usage: ['sample', 'copy-dst'], label: 'rhi-raster-checker' })
    rhi.writeTexture(tex, data, N * 4, N, N)
    this._rhiChecker = tex
    return tex
  }

  /** US-003: render the analytic checker tile on WebGl2Device through the engine's RHI
   *  screen pass — a real raster tile (a z0 world tile, AA-free, asymmetric for the
   *  orientation gate) drawn via the SAME RasterDraper the WebGPU pilot uses, now backed
   *  by the WebGl2Device. globalBytes/tileBytes mirror the live render() packing. */
  renderRhiChecker(
    rhi: RhiDevice, pass: RhiRenderPass, camera: Camera,
    projType: number, projCenterLon: number, projCenterLat: number,
    w: number, h: number, dpr: number,
  ): void {
    this._rhiDraper ??= new RasterDraper(rhi, 'rgba8unorm', 1)
    const checker = this.ensureRhiChecker(rhi)
    const frame = camera.getViewForProjection(projType, w, h, dpr)

    // Global uniform (160 B) — Float32 element offsets: mvp@0, proj@16, raster_params@20,
    // color0@24, color1@28, cam_ecef_center@32. Mirrors render()'s layout.
    const globalBytes = new ArrayBuffer(rasterUniformBytes())
    const gf = new Float32Array(globalBytes)
    gf.set(frame.matrix, 0)
    gf.set([projType, projCenterLon, projCenterLat, frame.logDepthFc], 16)
    gf.set([this._opacity, 0, 0, 8], 20)
    gf.set([this._hueRotate, this._brightnessMin, this._brightnessMax, this._saturation], 24)
    gf.set([this._contrast, 0, 0, 0], 28)
    // cam_ecef_center: the slice renders a FLAT z0 tile (single-sample, projType-0 scope —
    // the globe/ECEF anchor is Story-5/6), so pack the 2D Mercator camera centre. No projType
    // branch here keeps the forced-WebGL2 path off the projType-comparison arch ratchet.
    gf.set([camera.centerX, camera.centerY, 0, 0], 32)

    // One z0 world tile (whole Mercator band), uv_rect = whole texture.
    const west = -180, south = -85.051129, east = 180, north = 85.051129
    const swEcef = lonLatToECEF(west, south)
    const DEG2RAD = Math.PI / 180
    const mercSouth = Math.log(Math.tan(Math.PI / 4 + south * DEG2RAD / 2))
    const mercNorth = Math.log(Math.tan(Math.PI / 4 + north * DEG2RAD / 2))
    const tf = new Float32Array(16)
    tf[0] = west; tf[1] = south; tf[2] = east; tf[3] = north
    tf[4] = swEcef[0]; tf[5] = swEcef[1]; tf[6] = swEcef[2]
    tf[8] = mercSouth; tf[9] = mercNorth - mercSouth
    tf[12] = 0; tf[13] = 0; tf[14] = 1; tf[15] = 1

    this._rhiDraper.draw(pass, globalBytes, [{ texture: checker, tileBytes: tf }])
  }

  render(
    pass: GPURenderPassEncoder,
    camera: Camera,
    projType: number,
    projCenterLon: number,
    projCenterLat: number,
    canvasWidth: number,
    canvasHeight: number,
    /** Backing-buffer:CSS pixel ratio. Forwarded to the tile selector
     *  so a DPR=3 phone doesn't load 9× more raster tiles than DPR=1. */
    dpr: number = 1,
  ): void {
    if (!this.urlTemplate) return
    // Overdraw-debug v1: raster renderer has no debug pipeline yet, so
    // its contribution would mismatch the r16float accumulator format.
    // Skip entirely — raster tiles produce uniform 1× overdraw which
    // the heatmap can do without for now.
    if (DEBUG_OVERDRAW) return
    this.frameCount++

    const frame = camera.getViewForProjection(projType, canvasWidth, canvasHeight, dpr)
    const mvp = frame.matrix
    const { zoom } = camera

    const currentZ = Math.max(0, Math.min(18, Math.round(zoom)))

    // On zoom change: cancel distant zoom requests but KEEP parent tiles loading
    if (currentZ !== this.lastZoom) {
      for (const [key, ctrl] of this.loadingTiles) {
        const tileZ = parseInt(key.split('/')[0])
        // Keep parent tiles (lower zoom) and current zoom; abort higher zooms
        if (tileZ > currentZ) {
          ctrl.abort()
          this.loadingTiles.delete(key)
        }
      }
      this.lastZoom = currentZ
    }

    // Tile selection: mirror the vector path (tile-selection-cache.ts ~594).
    // Globe / sphere projTypes (routeToSphereSelector) use globeVisibleTiles,
    // which culls by sphere visibility. The flat frustum selector is blind to
    // the sphere cap — it produces a 2D rect cull that misses cap-edge tiles,
    // causing blank coverage gaps on the globe (#596).
    const R = 6378137
    const centerLon = camera.centerX / R * (180 / Math.PI)
    const centerLat = mercatorYToLat(camera.centerY)
    const cssW = canvasWidth / dpr
    const cssH = canvasHeight / dpr
    let tiles: ReturnType<typeof visibleTilesFrustum>
    if (routeToSphereSelector(projType, camera.globeMode)) {
      const globeTiles = globeVisibleTiles(
        centerLon, centerLat, camera.zoom, currentZ, cssW, cssH,
        camera.pitch ?? 0, camera.bearing ?? 0,
      )
      if (enumerateWorldCopies(projType, camera.zoom)) {
        tiles = []
        for (const wc of [-2, -1, 0, 1, 2]) {
          for (const t of globeTiles) {
            tiles.push({ z: t.z, x: t.x, y: t.y, ox: t.x + wc * (1 << t.z) })
          }
        }
      } else {
        tiles = globeTiles.map(t => ({ z: t.z, x: t.x, y: t.y, ox: t.ox }))
      }
    } else {
      // Flat projections: pass projection name so the selector's world-copy
      // gate (worldCopiesFor()) picks single-world for non-Mercator.
      const selectorProj = projType === 0
        ? mercatorProj
        : { name: 'non-mercator', forward: mercatorProj.forward, inverse: mercatorProj.inverse }
      tiles = visibleTilesFrustum(camera, selectorProj, currentZ, canvasWidth, canvasHeight, 0, dpr)
    }

    // Sort: lower zoom first (draw background), higher zoom on top (sharp near tiles)
    tiles.sort((a, b) => {
      if (a.z !== b.z) return a.z - b.z
      return 0
    })

    // Build set of visible tile keys for this frame
    const visibleKeys = new Set(tiles.map(c => `${c.z}/${c.x}/${c.y}`))

    // Load missing tiles — iterate in reverse zoom order so leaf (near/high-z)
    // tiles consume the limited concurrency budget first. The draw sort above
    // is ASC (background → foreground), which means foreground tiles sit at
    // the end; requesting in draw order starved the actual visible leaves
    // under pitched/mixed-LOD views, leaving blurry parent fallback instead.
    const loadOrder = [...tiles].sort((a, b) => b.z - a.z)
    for (const coord of loadOrder) {
      const key = `${coord.z}/${coord.x}/${coord.y}`
      if (this.tileCache.has(key) || this.loadingTiles.has(key)) continue
      if (this.loadingTiles.size >= MAX_CONCURRENT_LOADS) break // respect concurrency limit

      const ctrl = new AbortController()
      this.loadingTiles.set(key, ctrl)
      const url = tileUrl(this.urlTemplate, coord)

      loadImageTexture(this.device, url, ctrl.signal).then((texture) => {
        this.loadingTiles.delete(key)
        if (!texture) return
        this.tileCache.set(key, { texture, lastUsedFrame: this.frameCount, firstShownFrame: this.frameCount })
        this.evictTiles(visibleKeys)
      })
    }

    // Write global uniforms. proj_params.w = log_depth_fc so the raster
    // grid shader can apply/read the log-depth transform uniformly with
    // the vector pipelines.
    const uniformData = new ArrayBuffer(rasterUniformBytes())
    const RS = rasterUniformSlots().slot // offsets reflect-derived (byte-identical; raster-uniform-bytes.test.ts)
    new Float32Array(uniformData, RS.mvp * 4, 16).set(mvp)
    // proj_params + globe_eye written TOGETHER (coupled so the #600 "projection
    // set, eye forgotten" leak is unrepresentable). proj_params.w = log_depth_fc
    // is raster-specific (the raster struct folds it into that lane). frame.eye is
    // the globe/ECEF camera position (undefined off the globe → globe_eye zero).
    writeProjectionCull(new Float32Array(uniformData), RS.proj_params, RS.globe_eye, projType, projCenterLon, projCenterLat, frame.eye, frame.logDepthFc)
    // raster_params at offset 80 — x = opacity, yzw reserved.
    new Float32Array(uniformData, RS.raster_params * 4, 4).set([this._opacity, 0, 0, 0])
    // raster_color0 @96 — (hueRotateDeg, brightnessMin, brightnessMax, saturation).
    new Float32Array(uniformData, RS.raster_color0 * 4, 4).set([this._hueRotate, this._brightnessMin, this._brightnessMax, this._saturation])
    // raster_color1 @112 — x = contrast, yzw reserved.
    new Float32Array(uniformData, RS.raster_color1 * 4, 4).set([this._contrast, 0, 0, 0])
    // cam_ecef_center @128 — camera anchor (ellipsoid) for camera-relative RTC,
    // mirroring polygon's cam_ecef_off. Subtracted in the raster VS so the ECEF
    // vertex projects vertex − cameraCenter through the camera-at-origin MVP.
    // Flat Mercator (projType 0): cam_ecef_center.xy carries the 2D Mercator
    // camera centre — the flat VS computes rel = project(lon,lat) − cam.xy and
    // the ECEF lanes are dead there. 3D / globe: the ECEF anchor (ellipsoid).
    if (projType === 0) {
      new Float32Array(uniformData, RS.cam_ecef_center * 4, 4).set([camera.centerX, camera.centerY, 0, 0])
    } else {
      // ELLIPSOID camera anchor — the raster VS reconstructs each vertex via
      // lonlat_to_ecef (WGS84, E2≠0), so the anchor it subtracts MUST be on the
      // same ellipsoid. getECEFCenter() is the SPHERE (E2=0); subtracting it
      // from ellipsoid vertices left the ellipsoid−sphere discrepancy (~21.5 km
      // at mid-lat) on every vertex → the raster sheet flew off the globe. This
      // is the exact frame-consistency fix the vector tiler already applies to
      // cam_ecef_off (vector-tile-renderer.ts:3627-3638).
      const camC = rasterGlobeCamAnchor(projCenterLon, projCenterLat)
      new Float32Array(uniformData, RS.cam_ecef_center * 4, 4).set([camC[0], camC[1], camC[2], 0])
    }
    // (proj_params + globe_eye written together above via writeProjectionCull.)
    // The raster draw goes through the RHI Material seam (P1.4: the sole path). Collect each
    // visible tile (+ world-copy) into a RasterTile, then issue them in ONE draper.draw below.
    const tilesArr: RasterTile[] = []

    // Also load parent tiles for fallback (1-2 levels up)
    for (const coord of tiles) {
      for (let pz = 1; pz <= 2; pz++) {
        const parentZ = coord.z - pz
        if (parentZ < 0) break
        const parentX = coord.x >> pz
        const parentY = coord.y >> pz
        const parentKey = `${parentZ}/${parentX}/${parentY}`
        if (this.tileCache.has(parentKey) || this.loadingTiles.has(parentKey)) continue
        if (this.loadingTiles.size >= MAX_CONCURRENT_LOADS) break
        const ctrl = new AbortController()
        this.loadingTiles.set(parentKey, ctrl)
        loadImageTexture(this.device, tileUrl(this.urlTemplate, { z: parentZ, x: parentX, y: parentY, ox: parentX }), ctrl.signal).then((texture) => {
          this.loadingTiles.delete(parentKey)
          if (texture) this.tileCache.set(parentKey, { texture, lastUsedFrame: this.frameCount, firstShownFrame: this.frameCount })
        })
      }
    }

    // World-copy fan-out is the SELECTOR's job (ADR-0006: one copy-set
    // per pipeline). `visibleTilesFrustum` enumerates the visible copies
    // for the cylindrical family (worldCopiesFor → WORLD_COPIES) and bakes
    // each copy's offset into the tile's `ox` — so the bounds derived from
    // `ox` below (`west = ox/rn*360 - 180`) already sit in their own world
    // copy. Re-looping `camera.getVisibleWorldCopies()` here shifted those
    // already-placed bounds AGAIN by wo*360, drawing every selected tile at
    // every (ox + wo) position: the same logical world tile rasterised
    // multiple times at the same screen location (raster-opacity<1 then
    // COMPOUNDED the alpha; opacity=1 was wasted over-draw). The VTR vector
    // path reads the selector ox ONCE (tile-selection-cache worldOffDeg) and
    // draws each tile once — mirror that single-source pattern here. Globe /
    // ECEF (projType ≥ 0.5) and the cylindrical non-Mercator flat set
    // (1/2/6, routed through the mercator-named selector shim) were already
    // collapsed to [0] and stay unchanged.
    const RASTER_WORLD_COPIES = [0]
    // Render tiles: current zoom first, then parent fallback for missing
    for (const coord of tiles) {
      const key = `${coord.z}/${coord.x}/${coord.y}`
      let cached = this.tileCache.get(key)
      let fallbackCoord = coord
      let isFallback = false

      // Parent fallback: walk up until we find a cached tile
      if (!cached) {
        for (let pz = 1; pz <= 4; pz++) {
          const parentZ = coord.z - pz
          if (parentZ < 0) break
          const parentX = coord.x >> pz
          const parentY = coord.y >> pz
          const parentKey = `${parentZ}/${parentX}/${parentY}`
          const parentCached = this.tileCache.get(parentKey)
          if (parentCached) {
            cached = parentCached
            fallbackCoord = { z: parentZ, x: parentX, y: parentY, ox: (coord.ox ?? coord.x) >> pz }
            isFallback = true
            break
          }
        }
      }

      if (!cached) continue

      cached.lastUsedFrame = this.frameCount

      // Compute bounds: use fallback tile's coordinates if using parent
      const renderCoord = isFallback ? fallbackCoord : coord
      const rn = Math.pow(2, renderCoord.z)
      const ox = renderCoord.ox ?? renderCoord.x
      const west = ox / rn * 360 - 180
      const east = (ox + 1) / rn * 360 - 180
      const north = Math.atan(Math.sinh(Math.PI * (1 - 2 * renderCoord.y / rn))) * 180 / Math.PI
      const south = Math.atan(Math.sinh(Math.PI * (1 - 2 * (renderCoord.y + 1) / rn))) * 180 / Math.PI

      // ECEF anchor: SW corner of tile in WGS84 ECEF (unshifted across copies).
      // The shader subtracts this from lonlat_to_ecef(vertex) to form the RTC
      // offset vector, then transforms with the ECEF MVP. Precision: f64 here,
      // f32 in the uniform — acceptable because tile SW is close to vertices.
      const swEcef = lonLatToECEF(west, south)

      // Precompute Mercator Y bounds in f64 — crucially, store merc_south and the
      // small diff (merc_north - merc_south) separately, avoiding catastrophic
      // cancellation in f32 at high zoom where the two values are nearly equal.
      const DEG2RAD = Math.PI / 180
      const MERC_LIMIT = 85.051129
      const clampMerc = (v: number) => Math.max(-MERC_LIMIT, Math.min(MERC_LIMIT, v))
      const mercSouth = Math.log(Math.tan(Math.PI / 4 + clampMerc(south) * DEG2RAD / 2))
      const mercNorth = Math.log(Math.tan(Math.PI / 4 + clampMerc(north) * DEG2RAD / 2))
      const mercDiff = mercNorth - mercSouth

      // iter-188 — world-copy loop. For Mercator, draw the tile in every visible world copy
      // by shifting bounds.x / bounds.z by wo*360° (the VS mix(bounds.x, bounds.z, uu) lands
      // lon in the right copy). tile_ecef_center stays unshifted (copy-invariant 3D-ECEF RTC).
      // Non-Mercator collapses to wo=0. Each (tile, world-copy) becomes one RasterTile.
      for (const wo of RASTER_WORLD_COPIES) {
        const tf = this.drawTileF32
        const RT = rasterTileSlots().slot // reflect-derived f32 slots (byte-identical; raster-uniform-bytes.test.ts)
        tf[RT.bounds] = west + wo * 360; tf[RT.bounds + 1] = south; tf[RT.bounds + 2] = east + wo * 360; tf[RT.bounds + 3] = north
        tf[RT.tile_ecef_center] = swEcef[0]; tf[RT.tile_ecef_center + 1] = swEcef[1]; tf[RT.tile_ecef_center + 2] = swEcef[2]; tf[RT.tile_ecef_center + 3] = 0
        tf[RT.merc_y] = mercSouth        // merc_y.x
        tf[RT.merc_y + 1] = mercDiff         // merc_y.y
        tf[RT._pad] = 0; tf[RT._pad + 1] = 0   // padding
        // `tf` (this.drawTileF32) is reused every iteration — COPY it for the batch entry.
        tilesArr.push({ texture: cached.texture, tileBytes: tf.slice() })
      }
    }

    // Issue every collected tile in ONE draper.draw — the sole raster draw path (P1.4),
    // byte-identical to the legacy multi-tile loop. uniformData is the 160B global; the draper
    // owns the per-tile pool + the global/texture/sampler bind group. pick = the opaque-pass MRT.
    // Always called (even with 0 visible tiles) so the global uniform is written every frame —
    // matching the legacy path (it wrote the global before the loop): 0 tiles → global write, no draws.
    this.ensureRasterDraper().draw(wrapWebGpuPass(pass), uniformData, tilesArr, this._nearest, isPickEnabled())

    // Capture this frame's visible set; deferred eviction runs in the next
    // beginFrame(). Eviction used to run inline here, but destroying tile
    // textures mid-frame trips "Destroyed texture used in submit" because
    // bind groups created earlier in this same render() still reference
    // them at queue.submit() time. Same lifecycle hazard the buffer fix
    // (da4f26f) addressed for VectorTileRenderer.evictGPUTiles().
    this.lastVisibleKeys = visibleKeys
  }

  /** Drop LRU tiles past MAX_CACHED_TILES and destroy their GPU textures.
   *  ONLY called from `beginFrame()` so the previous frame's queue.submit()
   *  has already returned — destroying textures here cannot poison an
   *  in-flight submit. Mirrors VectorTileRenderer.evictGPUTiles(). */
  beginFrame(): void {
    if (this.tileCache.size > MAX_CACHED_TILES) this.evictTiles(this.lastVisibleKeys)
  }

  /** Evict least-recently-used tiles when cache exceeds limit */
  private evictTiles(visibleKeys: Set<string>): void {
    if (this.tileCache.size <= MAX_CACHED_TILES) return

    // Sort by lastUsedFrame (oldest first), skip currently visible
    const entries = [...this.tileCache.entries()]
      .filter(([key]) => !visibleKeys.has(key))
      .sort((a, b) => a[1].lastUsedFrame - b[1].lastUsedFrame)

    const toEvict = this.tileCache.size - MAX_CACHED_TILES
    for (let i = 0; i < toEvict && i < entries.length; i++) {
      const [key, tile] = entries[i]
      tile.texture.destroy()
      this.tileCache.delete(key)
    }
  }
}
