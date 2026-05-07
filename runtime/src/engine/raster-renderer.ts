// ═══ Raster Tile Renderer — 텍스처 타일을 GPU 투영으로 렌더링 ═══

import type { GPUContext } from './gpu'
import type { Camera } from './camera'
import { visibleTilesFrustum, tileUrl, loadImageTexture } from '../loader/tiles'
import { mercator as mercatorProj } from './projection'
import { BLEND_ALPHA, STENCIL_DISABLED } from './gpu-shared'
import { isPickEnabled, getSampleCount } from './gpu'
import { WGSL_LOG_DEPTH_FNS } from './wgsl-log-depth'
import { WGSL_PROJECTION_CONSTS, WGSL_PROJECTION_FNS } from './wgsl-projection'

const RASTER_SHADER = /* wgsl */ `
${WGSL_PROJECTION_CONSTS}
${WGSL_LOG_DEPTH_FNS}

struct Uniforms {
  mvp: mat4x4<f32>,
  // proj_params: x=type, y=centerLon, z=centerLat, w=log_depth_fc
  proj_params: vec4<f32>,
}

@group(0) @binding(0) var<uniform> u: Uniforms;

${WGSL_PROJECTION_FNS}
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var tex_sampler: sampler;

struct TileUniforms {
  bounds: vec4<f32>,    // west, south, east, north (degrees)
  tile_rtc: vec4<f32>,  // xy = project(tileWest,tileSouth) - project(camera), z = tileWest, w = tileSouth
  merc_y: vec2<f32>,    // x = merc_south (absolute), y = merc_diff (merc_north - merc_south, stored as small f32)
  _pad: vec2<f32>,
}
@group(1) @binding(0) var<uniform> tile: TileUniforms;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) vis: f32,
  @location(2) view_w: f32,
}

struct RasterFragmentOutput {
  @location(0) color: vec4<f32>,
  __PICK_FIELD__
  @builtin(frag_depth) depth: f32,
}

// Subdivided grid: N×N cells, 6 vertices per cell
const GRID_N: u32 = 8u;
const GRID_VERTS: u32 = 8u * 8u * 6u; // 384

@vertex
fn vs_tile(@builtin(vertex_index) vid: u32) -> VsOut {
  let cell = vid / 6u;
  let tri  = vid % 6u;
  let cx = cell % GRID_N;
  let cy = cell / GRID_N;

  let du_arr = array<u32, 6>(0, 1, 0, 1, 1, 0);
  let dv_arr = array<u32, 6>(0, 0, 1, 0, 1, 1);
  let gx = cx + du_arr[tri];
  let gy = cy + dv_arr[tri];

  let uu = f32(gx) / f32(GRID_N);
  let vv = f32(gy) / f32(GRID_N);

  // Mercator-uniform grid: vv is linear in Mercator Y (matches raster texture layout)
  // merc_y.x = merc_south (absolute), merc_y.y = merc_diff (small, high precision)
  // vv=0 → north (offset=diff), vv=1 → south (offset=0)
  let merc_y_offset = (1.0 - vv) * tile.merc_y.y;  // local offset from tileSouth
  let merc_y_abs = tile.merc_y.x + merc_y_offset;   // absolute merc Y (for non-Mercator projections)

  let lon = mix(tile.bounds.x, tile.bounds.z, uu);
  // Recover latitude from absolute Mercator Y (for non-Mercator projections only)
  let lat_rad = 2.0 * atan(exp(merc_y_abs)) - PI / 2.0;
  let lat = lat_rad / DEG2RAD;

  let local_lon = lon - tile.tile_rtc.z;  // degrees from tileWest
  let origin_lat = tile.tile_rtc.w;       // tileSouth

  let local_x = local_lon * DEG2RAD * EARTH_R;

  var local_y: f32;
  let t = u.proj_params.x;
  if (t < 0.5) {
    // Mercator: linear in Mercator Y — merc_y_offset is already relative to tileSouth
    // (computed as (1-vv) * merc_diff) so no catastrophic subtraction of near-equal values.
    local_y = merc_y_offset * EARTH_R;
  } else if (t < 1.5) {
    // Equirectangular
    local_y = (lat - origin_lat) * DEG2RAD * EARTH_R;
  } else {
    // Other projections: project absolute then subtract origin
    let projected = project(lon, lat, u.proj_params);
    let origin_projected = project(tile.tile_rtc.z, origin_lat, u.proj_params);
    let rtc_other = projected - origin_projected + tile.tile_rtc.xy;
    var out: VsOut;
    let clip_other = u.mvp * vec4<f32>(rtc_other, 0.0, 1.0);
    out.pos = apply_log_depth(clip_other, u.proj_params.w);
    out.view_w = clip_other.w;
    out.uv = vec2<f32>(uu, vv);
    out.vis = select(1.0, center_cos_c(lon, lat, u.proj_params.y, u.proj_params.z), t > 2.5);
    return out;
  }

  // tile_rtc.xy = project(tileWest,tileSouth) - project(camera), computed CPU f64
  let rtc = vec2<f32>(local_x + tile.tile_rtc.x, local_y + tile.tile_rtc.y);

  var out: VsOut;
  let clip = u.mvp * vec4<f32>(rtc, 0.0, 1.0);
  out.pos = apply_log_depth(clip, u.proj_params.w);
  out.view_w = clip.w;
  out.uv = vec2<f32>(uu, vv);
  out.vis = 1.0;
  return out;
}

@fragment
fn fs_tile(input: VsOut) -> RasterFragmentOutput {
  if (input.vis < 0.0) { discard; }
  var out: RasterFragmentOutput;
  out.color = textureSample(tex, tex_sampler, input.uv);
  __PICK_WRITE__
  out.depth = compute_log_frag_depth(input.view_w, u.proj_params.w);
  return out;
}
`

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
  // Pool of per-draw tile uniform buffers (avoids writeBuffer race with draw).
  // Each buffer has a matching pre-built bind group in `tileBindGroupPool` so
  // the hot path never calls createBindGroup — a major frame-time win when
  // many raster tiles are visible.
  private tileUniformPool: GPUBuffer[] = []
  private tileBindGroupPool: GPUBindGroup[] = []
  private tileUniformIdx = 0
  private drawTileF32 = new Float32Array(12) // bounds(4) + tile_rtc(4) + merc_y(2) + pad(2)

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
    const pickShader = RASTER_SHADER
      .replace(/__PICK_FIELD__/g, isPickEnabled() ? '@location(1) @interpolate(flat) pick: vec2<u32>,' : '')
      // Raster tiles don't carry a feature id — always emit (0, 0) so the
      // pick texture stays at "no feature" where the basemap is the front-most
      // surface. Polygon / line / point pipelines write their real IDs on top.
      .replace(/__PICK_WRITE__/g, isPickEnabled() ? 'out.pick = vec2<u32>(0u, 0u);' : '')
    const module = this.device.createShaderModule({ code: pickShader, label: 'raster-shader' })
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
  ): void {
    if (!this.urlTemplate) return
    this.frameCount++

    const frame = camera.getFrameView(canvasWidth, canvasHeight)
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
    const tiles = visibleTilesFrustum(camera, selectorProj, currentZ, canvasWidth, canvasHeight)

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

      // Get or create a pooled uniform buffer + matching bind group for this
      // draw. The bind group is pre-built 1:1 with the buffer so the hot loop
      // skips createBindGroup entirely.
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

      // Compute bounds: use fallback tile's coordinates if using parent
      const renderCoord = isFallback ? fallbackCoord : coord
      const rn = Math.pow(2, renderCoord.z)
      const ox = renderCoord.ox ?? renderCoord.x
      const west = ox / rn * 360 - 180
      const east = (ox + 1) / rn * 360 - 180
      const north = Math.atan(Math.sinh(Math.PI * (1 - 2 * renderCoord.y / rn))) * 180 / Math.PI
      const south = Math.atan(Math.sinh(Math.PI * (1 - 2 * (renderCoord.y + 1) / rn))) * 180 / Math.PI

      // Compute tile_rtc in f64: project(tileWest, tileSouth) - project(camera)
      // Uses SW corner as origin — identical to vector tile renderer
      const DEG2RAD = Math.PI / 180
      const R = 6378137
      const tileX = west * DEG2RAD * R
      const centerX = projCenterLon * DEG2RAD * R
      const MERC_LIMIT = 85.051129
      const clampMerc = (v: number) => Math.max(-MERC_LIMIT, Math.min(MERC_LIMIT, v))
      const tileY = projType < 0.5
        ? Math.log(Math.tan(Math.PI / 4 + clampMerc(south) * DEG2RAD / 2)) * R
        : south * DEG2RAD * R
      const centerY = projType < 0.5
        ? Math.log(Math.tan(Math.PI / 4 + clampMerc(projCenterLat) * DEG2RAD / 2)) * R
        : projCenterLat * DEG2RAD * R

      // Precompute Mercator Y bounds in f64 — crucially, store merc_south and the
      // small diff (merc_north - merc_south) separately, avoiding catastrophic
      // cancellation in f32 at high zoom where the two values are nearly equal.
      const mercSouth = Math.log(Math.tan(Math.PI / 4 + clampMerc(south) * DEG2RAD / 2))
      const mercNorth = Math.log(Math.tan(Math.PI / 4 + clampMerc(north) * DEG2RAD / 2))
      const mercDiff = mercNorth - mercSouth

      const tf = this.drawTileF32
      tf[0] = west; tf[1] = south; tf[2] = east; tf[3] = north   // bounds
      tf[4] = tileX - centerX  // tile_rtc.x (f64 → f32)
      tf[5] = tileY - centerY  // tile_rtc.y
      tf[6] = west             // tile_rtc.z = tileWest
      tf[7] = south            // tile_rtc.w = tileSouth
      tf[8] = mercSouth        // merc_y.x (absolute, for non-Mercator projections)
      tf[9] = mercDiff         // merc_y.y (small diff, precise at any zoom)
      tf[10] = 0; tf[11] = 0   // padding
      this.device.queue.writeBuffer(tileBuf, 0, tf)

      // Per-tile global bind group: immutable after load because the texture
      // view and sampler are stable for the tile's lifetime. Cached on the
      // CachedTile entry so repeated frames reuse the same GPU binding.
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
      pass.setBindGroup(1, tileBG)
      pass.draw(384) // 8×8 grid × 6 verts/cell
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
