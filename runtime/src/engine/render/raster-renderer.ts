// ═══ Raster Tile Renderer — 텍스처 타일을 GPU 투영으로 렌더링 ═══

import type { GPUContext } from '../gpu/gpu'
import type { Camera } from '../projection/camera'
import { visibleTilesFrustum, tileUrl, loadImageTexture } from '../../data/tile-select'
import { mercator as mercatorProj } from '../projection/projection'
import { lonLatToECEF, type ECEF } from '../projection/ecef'
import { emitRasterWgsl } from '../shader-dsl'
import { BLEND_ALPHA, STENCIL_DISABLED } from '../gpu/gpu-shared'
import { isPickEnabled, getSampleCount } from '../gpu/gpu'
import { DEBUG_OVERDRAW } from '../debug-flags'

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
// Cap the per-draw uniform pool so long sessions with peaks of 300+ frustum
// tiles don't hold onto VRAM forever. The pool grows as needed up to this cap
// and stale entries are destroyed when the cap is exceeded.
const MAX_TILE_UNIFORM_POOL = 256

export class RasterRenderer {
  private device: GPUDevice
  private format: GPUTextureFormat = 'bgra8unorm'
  private pipeline: GPURenderPipeline
  private globalBindGroupLayout: GPUBindGroupLayout
  private tileBindGroupLayout: GPUBindGroupLayout
  private uniformBuffer: GPUBuffer
  private sampler: GPUSampler

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
  // Pool of per-draw tile uniform buffers (avoids writeBuffer race with draw).
  // Each buffer has a matching pre-built bind group in `tileBindGroupPool` so
  // the hot path never calls createBindGroup — a major frame-time win when
  // many raster tiles are visible.
  private tileUniformPool: GPUBuffer[] = []
  private tileBindGroupPool: GPUBindGroup[] = []
  private tileUniformIdx = 0
  private drawTileF32 = new Float32Array(12) // bounds(4) + tile_ecef_center(4) + merc_y(2) + pad(2)

  constructor(ctx: GPUContext) {
    this.device = ctx.device
    this.format = ctx.format

    this.globalBindGroupLayout = ctx.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    })

    this.tileBindGroupLayout = ctx.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      ],
    })

    this.pipeline = this.buildPipeline()

    this.uniformBuffer = ctx.device.createBuffer({
      size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'raster-uniforms',
    })

    this.sampler = ctx.device.createSampler({
      magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
    })
  }

  /** Recompile shader + pipeline using the current QUALITY (MSAA /
   *  picking). Called by map.setQuality() when those knobs flip at
   *  runtime. All cached bind groups on CachedTile entries stay valid —
   *  they reference the texture view + sampler + uniform buffer, not
   *  the pipeline. */
  rebuildForQuality(): void {
    this.pipeline = this.buildPipeline()
  }

  /** Live-reads QUALITY so the returned pipeline matches the current
   *  MSAA / picking setting. Used at construction time AND from
   *  `rebuildForQuality()` — each call produces a fresh module + pipeline. */
  private buildPipeline(): GPURenderPipeline {
    const module = this.device.createShaderModule({ code: emitRasterWgsl(isPickEnabled()), label: 'raster-shader' })
    return this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.globalBindGroupLayout, this.tileBindGroupLayout] }),
      vertex: { module, entryPoint: 'vs_tile' },
      fragment: {
        module, entryPoint: 'fs_tile',
        targets: isPickEnabled()
          ? [{ format: this.format, blend: BLEND_ALPHA }, { format: 'rg32uint' as GPUTextureFormat }]
          : [{ format: this.format, blend: BLEND_ALPHA }],
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: STENCIL_DISABLED,
      multisample: { count: getSampleCount() },
      label: 'raster-pipeline',
    })
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

  /** True while any tile fetch is still in flight. The map's render loop
   *  polls this to keep ticking during load — newly-arrived textures need
   *  one more frame to show up, but arrivals don't fire a direct callback
   *  today, so we just keep the loop warm until the queue drains. */
  hasPendingLoads(): boolean {
    return this.loadingTiles.size > 0
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

    // Quadtree-based frustum selection works at every pitch, including 0.
    // The legacy AABB path (`visibleTiles`) diverged over time and broke
    // at low pitch for the VT pipeline, so we unify on the frustum path.
    //
    // Pass projection name through so the selector's world-copy gate
    // (worldCopiesFor()) picks single-world for non-Mercator. Hardcoding
    // mercatorProj here previously caused 5× raster tile fan-out around
    // the orthographic disk because every copy projected to a different
    // wrong hemisphere. visibleTilesFrustum only reads `.name` on the
    // projection arg, so a `{ name }` shim is sufficient.
    const selectorProj = projType === 0
      ? mercatorProj
      : { name: 'non-mercator', forward: mercatorProj.forward, inverse: mercatorProj.inverse }
    const tiles = visibleTilesFrustum(camera, selectorProj, currentZ, canvasWidth, canvasHeight, 0, dpr)

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
    const uniformData = new ArrayBuffer(128)
    new Float32Array(uniformData, 0, 16).set(mvp)
    new Float32Array(uniformData, 64, 4).set([projType, projCenterLon, projCenterLat, frame.logDepthFc])
    // raster_params at offset 80 — x = opacity, yzw reserved.
    new Float32Array(uniformData, 80, 4).set([this._opacity, 0, 0, 0])
    // cam_ecef_center @96 — camera anchor (ellipsoid) for camera-relative RTC,
    // mirroring polygon's cam_ecef_off. Subtracted in the raster VS so the ECEF
    // vertex projects vertex − cameraCenter through the camera-at-origin MVP.
    // Flat Mercator (projType 0): cam_ecef_center.xy carries the 2D Mercator
    // camera centre — the flat VS computes rel = project(lon,lat) − cam.xy and
    // the ECEF lanes are dead there. 3D / globe: the ECEF anchor (ellipsoid).
    if (projType === 0) {
      new Float32Array(uniformData, 96, 4).set([camera.centerX, camera.centerY, 0, 0])
    } else {
      // ELLIPSOID camera anchor — the raster VS reconstructs each vertex via
      // lonlat_to_ecef (WGS84, E2≠0), so the anchor it subtracts MUST be on the
      // same ellipsoid. getECEFCenter() is the SPHERE (E2=0); subtracting it
      // from ellipsoid vertices left the ellipsoid−sphere discrepancy (~21.5 km
      // at mid-lat) on every vertex → the raster sheet flew off the globe. This
      // is the exact frame-consistency fix the vector tiler already applies to
      // cam_ecef_off (vector-tile-renderer.ts:3627-3638).
      const camC = rasterGlobeCamAnchor(projCenterLon, projCenterLat)
      new Float32Array(uniformData, 96, 4).set([camC[0], camC[1], camC[2], 0])
    }
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData)

    pass.setPipeline(this.pipeline)

    // Reset per-draw uniform pool index
    this.tileUniformIdx = 0

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

      // Per-tile global bind group: immutable after load. Pre-build
      // ONCE per tile lifetime — shared across all world-copy draws.
      if (!cached.globalBG) {
        cached.globalBG = this.device.createBindGroup({
          layout: this.globalBindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: this.uniformBuffer } },
            { binding: 1, resource: cached.texture.createView() },
            { binding: 2, resource: this.sampler },
          ],
        })
      }
      pass.setBindGroup(0, cached.globalBG)

      // iter-188 — world-copy loop. For Mercator, draw the tile in
      // every visible world copy by shifting bounds.x / bounds.z by
      // wo * 360°. The vertex shader's mix(bounds.x, bounds.z, uu)
      // naturally lands lon in the right world copy for lonlat_to_ecef.
      // tile_ecef_center stays unshifted (shared across copies; the
      // RTC subtraction is in 3D ECEF and copy-invariant).
      // Non-Mercator collapses to wo=0 only.
      for (const wo of RASTER_WORLD_COPIES) {
        // Get or create a pooled uniform buffer + matching bind group.
        if (this.tileUniformIdx >= this.tileUniformPool.length) {
          const buf = this.device.createBuffer({
            size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          })
          this.tileUniformPool.push(buf)
          this.tileBindGroupPool.push(this.device.createBindGroup({
            layout: this.tileBindGroupLayout,
            entries: [{ binding: 0, resource: { buffer: buf } }],
          }))
        }
        const tileBuf = this.tileUniformPool[this.tileUniformIdx]
        const tileBG = this.tileBindGroupPool[this.tileUniformIdx]
        this.tileUniformIdx++

        const tf = this.drawTileF32
        // bounds: shift west/east by wo*360° so the shader's mix(bounds.x, bounds.z, uu)
        // naturally produces the correct world-copy longitude for lonlat_to_ecef.
        tf[0] = west + wo * 360; tf[1] = south; tf[2] = east + wo * 360; tf[3] = north
        // tile_ecef_center: ECEF of SW corner (unshifted; shared across copies).
        tf[4] = swEcef[0]; tf[5] = swEcef[1]; tf[6] = swEcef[2]; tf[7] = 0
        tf[8] = mercSouth        // merc_y.x
        tf[9] = mercDiff         // merc_y.y
        tf[10] = 0; tf[11] = 0   // padding
        this.device.queue.writeBuffer(tileBuf, 0, tf)
        pass.setBindGroup(1, tileBG)
        pass.draw(384) // 8×8 grid × 6 verts/cell
      }
    }

    // Capture this frame's visible set; deferred eviction runs in the next
    // beginFrame(). Eviction used to run inline here, but destroying tile
    // textures mid-frame trips "Destroyed texture used in submit" because
    // bind groups created earlier in this same render() still reference
    // them at queue.submit() time. Same lifecycle hazard the buffer fix
    // (da4f26f) addressed for VectorTileRenderer.evictGPUTiles().
    this.lastVisibleKeys = visibleKeys

    // Shrink the uniform pool back toward MAX_TILE_UNIFORM_POOL if a previous
    // peak (e.g. extreme pitch) grew it beyond the cap. Only trim the tail
    // past what we used this frame so active draws aren't disturbed.
    if (this.tileUniformPool.length > MAX_TILE_UNIFORM_POOL
        && this.tileUniformIdx <= MAX_TILE_UNIFORM_POOL) {
      for (let i = this.tileUniformPool.length - 1; i >= MAX_TILE_UNIFORM_POOL; i--) {
        this.tileUniformPool[i].destroy()
      }
      this.tileUniformPool.length = MAX_TILE_UNIFORM_POOL
      this.tileBindGroupPool.length = MAX_TILE_UNIFORM_POOL
    }
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
