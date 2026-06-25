// ═══ Raster Tile Renderer — 텍스처 타일을 GPU 투영으로 렌더링 ═══

import type { GPUContext } from '../gpu/gpu'
import type { Camera } from '../projection/camera'
import { visibleTilesFrustum, tileUrl, loadImageTexture } from '../../data/tile-select'
import { mercator as mercatorProj } from '../projection/projection'
import { lonLatToECEF, type ECEF } from '../projection/ecef'
import { emitRasterWgsl } from '../shaders/dsl'
import { WebGpuDevice, wrapWebGpuPass } from './rhi/rhi-webgpu'
import type { RhiDevice, RhiRenderPass, RhiTexture } from './rhi/rhi'
import { RasterDraper, type RasterTile } from './material/raster-material'
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
  // Active sampler for THIS frame's tile bind groups. Points at
  // `linearSampler` (default) or `nearestSampler` per `raster-resampling`.
  private sampler: GPUSampler
  private linearSampler!: GPUSampler
  private nearestSampler!: GPUSampler

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
  // Pool of per-draw tile uniform buffers (avoids writeBuffer race with draw).
  // Each buffer has a matching pre-built bind group in `tileBindGroupPool` so
  // the hot path never calls createBindGroup — a major frame-time win when
  // many raster tiles are visible.
  private tileUniformPool: GPUBuffer[] = []
  private tileBindGroupPool: GPUBindGroup[] = []
  private tileUniformIdx = 0
  private drawTileF32 = new Float32Array(16) // bounds(4) + tile_ecef_center(4) + merc_y(2) + pad(2) + uv_rect(4)

  // ── PoC S1: arbitrary-texture globe drape (approach B proof) ──────────────
  // Reuses the raster shader/pipeline/8×8 grid to drape a caller-supplied
  // texture as ONE synthetic tile patch on the sphere. Dedicated buffers so it
  // never clobbers render()'s shared per-frame uniform.
  private _drapeGlobalBuf?: GPUBuffer
  private _drapeTileBuf?: GPUBuffer
  private _drapeTileBG?: GPUBindGroup
  private _checkerTex?: GPUTexture
  private _drapeBGForTex?: { tex: GPUTexture; bg: GPUBindGroup }
  private readonly _drapeGlobalF32 = new Float32Array(40) // 160 bytes
  // M2 surface-quadtree resources: ONE global buffer (written once/frame) + a
  // POOL of per-leaf tile buffers + bind groups (each leaf needs its own uniform
  // — a shared buffer collapses under many same-bind-group draws), and a per-
  // texture group-0 bind group cache.
  private _sqGlobalBuf?: GPUBuffer
  // group-0 bind group cache, keyed by texture (global buffer + tile texture +
  // sampler) — built once per texture, not per leaf.
  private _sqBG0ByTex = new Map<GPUTexture, GPUBindGroup>()
  // Quadtree leaf-set cache: when the camera MVP + the data-tile set are unchanged,
  // skip the per-frame Pass-1 traversal + slot-buffer write and reuse the leaves.
  private _sqCacheSig = ''
  private _sqCacheLeafList: Array<{ w: number; s: number; e: number; n: number; uMin: number; vMin: number; uMax: number; vMax: number; tex: GPUTexture }> = []
  private _sqCacheNeed = 0
  private _sqCacheMaxDepth = 0
  private _sqCacheTex: GPUTexture[] = []
  // Per-leaf uniforms live in ONE big buffer (256B-aligned slots) written ONCE
  // per frame; each leaf draws with a STATIC-offset bind group into its slot.
  // (Per-draw queue.writeBuffer to a shared/pooled buffer collapses or under-
  // covers at 1000+ leaves; a single write + static offsets is the correct WebGPU
  // pattern.) SLOT = 256 = minUniformBufferOffsetAlignment.
  private _sqSlotBuf?: GPUBuffer
  private readonly _sqSlotBGs: GPUBindGroup[] = []
  private _sqSlotData?: Float32Array

  // ── RHI vertical pilot (behind __xgisRasterViaRhi) ──
  // The raster draw routed through the layered seam: RasterMaterial (RHI resources
  // + pipeline) + executeRasterItems (generic draw loop) + an inline builder (the
  // visible-tile loop emits RasterDrawItem data). Proves the backend abstraction
  // renders pixel-identically to the legacy direct calls. Legacy is the default.
  private _rasterDraper?: RasterDraper

  // ── Forced-WebGL2 raster slice (US-003) ──
  // A SECOND draper backed by the WebGl2Device (host.ctx.rhi), drawing an analytic
  // checker tile through the engine's RHI screen pass — the milestone proof that a real
  // layer renders on the WebGL2 backend, not just offscreen. Distinct from `_rasterDraper`
  // (the WebGPU pilot). Created lazily on the first forced-WebGL2 frame.
  private _rhiDraper?: RasterDraper
  private _rhiChecker?: RhiTexture

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
      size: 160, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'raster-uniforms',
    })

    this.linearSampler = ctx.device.createSampler({
      magFilter: 'linear', minFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
    })
    // Mapbox `raster-resampling: nearest` (pixel-art / DEM staircase) uses
    // a NEAREST-filtered sampler instead of the default linear. Built once;
    // `_nearest` selects between the two per render. Both are immutable.
    this.nearestSampler = ctx.device.createSampler({
      magFilter: 'nearest', minFilter: 'nearest',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
    })
    this.sampler = this.linearSampler
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
    if (nearest === this._nearest) return
    this._nearest = nearest
    this.sampler = nearest ? this.nearestSampler : this.linearSampler
    // Cached globalBG entries reference the OLD sampler — drop them so the
    // render loop rebuilds each against `this.sampler`.
    for (const tile of this.tileCache.values()) tile.globalBG = undefined
  }

  /** True while any tile fetch is still in flight. The map's render loop
   *  polls this to keep ticking during load — newly-arrived textures need
   *  one more frame to show up, but arrivals don't fire a direct callback
   *  today, so we just keep the loop warm until the queue drains. */
  hasPendingLoads(): boolean {
    return this.loadingTiles.size > 0
  }

  /** PoC S1 (approach B proof): drape `texture` (default = built-in
   *  checkerboard) as ONE front-facing tile patch (±60° lon / ±40° lat around
   *  the camera centre) on the sphere, reusing the raster shader/pipeline/grid.
   *  Dedicated buffers so it never touches render()'s shared per-frame uniform. */
  drawDrape(
    pass: GPURenderPassEncoder,
    camera: Camera,
    projType: number,
    projCenterLon: number,
    projCenterLat: number,
    canvasWidth: number,
    canvasHeight: number,
    dpr: number,
    texture?: GPUTexture,
    /** PoC US-S3 — drape over these geo bounds instead of the ±60°/±40°
     *  camera-centred patch (so a baked vector tile drapes over its TRUE
     *  geographic extent). When omitted, the S1 front-patch behaviour. */
    bounds?: { west: number; south: number; east: number; north: number },
    /** M2 — texture sub-rectangle [uMin,vMin,uMax,vMax] this patch samples of
     *  `texture`. Default (0,0,1,1) = whole. A surface patch covering part of a
     *  coarser data tile passes its sub-rect so the mesh decouples from data. */
    uvRect?: [number, number, number, number],
    /** M2 — override the mesh subdivision (else SSE/angular-span driven). The
     *  surface quadtree passes a small fixed value (its leaves are already SSE-
     *  refined flat) so the shared global uniform's gridN stays consistent. */
    forceGridN?: number,
  ): void {
    const tex = texture ?? this.ensureChecker()
    const frame = camera.getViewForProjection(projType, canvasWidth, canvasHeight, dpr)

    if (!this._drapeGlobalBuf) {
      this._drapeGlobalBuf = this.device.createBuffer({
        size: 160, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'raster-drape-uniforms',
      })
    }
    const g = this._drapeGlobalF32
    g.set(frame.matrix, 0)                                                   // mvp @0
    g[16] = projType; g[17] = projCenterLon; g[18] = projCenterLat; g[19] = frame.logDepthFc // proj_params @64
    // raster_params @80: x=opacity=1, y=back-face debug flag (1 ⇒ paint far-
    // hemisphere drape fragments RED so a back-wrapping drape is visible).
    const backDbg = (globalThis as { __xgisDebugBackFace?: boolean }).__xgisDebugBackFace ? 1 : 0
    // raster_params.z = 1 ⇒ the drape hemisphere-culls its back-faces (vis = cos_c
    // in vs_tile) so far-side tiles don't leak through to the front of the globe.
    // raster_params.w = grid_n: SSE/curvature-driven mesh subdivision so a wide
    // tile's draped patch follows the sphere instead of showing straight chords
    // at the limb. ~1 segment per `DEG_PER_SEG` degrees of the patch's angular
    // span, clamped [8,32] (non-indexed draw, so no 16-bit index limit).
    const _dW = bounds ? bounds.west : projCenterLon - 60
    const _dE = bounds ? bounds.east : projCenterLon + 60
    const _dS = bounds ? bounds.south : projCenterLat - 40
    const _dN = bounds ? bounds.north : projCenterLat + 40
    const DEG_PER_SEG = 3
    const angSpan = Math.max(Math.abs(_dE - _dW), Math.abs(_dN - _dS))
    // forceGridN: the SSE surface quadtree refines each leaf to be near-flat, so
    // its leaves drape with a fixed 1×1 quad (gridN=1). A fixed gridN also keeps
    // the shared global uniform CONSISTENT across many per-leaf draws (a varying
    // gridN there mismatches the per-draw vertex count → garbage on big leaves).
    const gridN = forceGridN ?? ((globalThis as { __xgisDrapeForceGrid8?: boolean }).__xgisDrapeForceGrid8
      ? 8 // A/B control: force the old fixed 8×8 mesh to compare limb faceting.
      : Math.max(8, Math.min(32, Math.ceil(angSpan / DEG_PER_SEG))))
    g[20] = 1; g[21] = backDbg; g[22] = 1; g[23] = gridN                      // raster_params @80
    g[24] = 0; g[25] = 0; g[26] = 1; g[27] = 0                               // raster_color0 @96 (no-op)
    // raster_color1.y (g[29]) = uv/texture-rgb debug (shared with drawSurfaceQuadtree).
    g[28] = 0; g[29] = (globalThis as { __xgisDebugUvColor?: boolean }).__xgisDebugUvColor ? 1 : 0; g[30] = 0; g[31] = 0
    if (projType === 0) {
      g[32] = camera.centerX; g[33] = camera.centerY; g[34] = 0; g[35] = 0
    } else {
      const c = rasterGlobeCamAnchor(projCenterLon, projCenterLat)
      g[32] = c[0]; g[33] = c[1]; g[34] = c[2]; g[35] = 0                    // cam_ecef_center @128 (ellipsoid)
    }
    this.device.queue.writeBuffer(this._drapeGlobalBuf, 0, g)

    if (this._drapeBGForTex?.tex !== tex) {
      this._drapeBGForTex = {
        tex,
        bg: this.device.createBindGroup({
          layout: this.globalBindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: this._drapeGlobalBuf } },
            { binding: 1, resource: tex.createView() },
            { binding: 2, resource: this.linearSampler },
          ],
        }),
      }
    }

    // Drape extent: caller-supplied bounds (S3 — a baked tile's true geo
    // extent) or the S1 ±60°/±40° front-facing patch around the camera centre.
    const MERC = 85.051129
    const clampLat = (v: number) => Math.max(-MERC, Math.min(MERC, v))
    const west = bounds ? bounds.west : projCenterLon - 60
    const east = bounds ? bounds.east : projCenterLon + 60
    const south = bounds ? clampLat(bounds.south) : clampLat(projCenterLat - 40)
    const north = bounds ? clampLat(bounds.north) : clampLat(projCenterLat + 40)
    const swEcef = lonLatToECEF(west, south)
    const DEG2RAD = Math.PI / 180
    const mercSouth = Math.log(Math.tan(Math.PI / 4 + south * DEG2RAD / 2))
    const mercDiff = Math.log(Math.tan(Math.PI / 4 + north * DEG2RAD / 2)) - mercSouth

    if (!this._drapeTileBuf) {
      this._drapeTileBuf = this.device.createBuffer({
        size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'raster-drape-tile',
      })
      this._drapeTileBG = this.device.createBindGroup({
        layout: this.tileBindGroupLayout,
        entries: [{ binding: 0, resource: { buffer: this._drapeTileBuf } }],
      })
    }
    const tf = this.drawTileF32
    tf[0] = west; tf[1] = south; tf[2] = east; tf[3] = north
    tf[4] = swEcef[0]; tf[5] = swEcef[1]; tf[6] = swEcef[2]; tf[7] = 0
    tf[8] = mercSouth; tf[9] = mercDiff; tf[10] = 0; tf[11] = 0
    // uv_rect: which sub-rectangle of `texture` this patch samples (default whole).
    tf[12] = uvRect ? uvRect[0] : 0; tf[13] = uvRect ? uvRect[1] : 0
    tf[14] = uvRect ? uvRect[2] : 1; tf[15] = uvRect ? uvRect[3] : 1
    this.device.queue.writeBuffer(this._drapeTileBuf, 0, tf)

    // PoC S3 debug: replicate the shader's GLOBE-path transform on the CPU for
    // the 4 patch corners and log clip.w + NDC, to find why a southern-lat tile
    // renders 0 visible pixels. Gated on globalThis.__xgisDrapeDump; inert off.
    if ((globalThis as { __xgisDrapeDump?: boolean }).__xgisDrapeDump && projType !== 0) {
      const M = frame.matrix
      const cam = rasterGlobeCamAnchor(projCenterLon, projCenterLat)
      const proj = (lon: number, lat: number) => {
        const e = lonLatToECEF(lon, lat)
        const x = e[0] - cam[0], y = e[1] - cam[1], z = e[2] - cam[2]
        const cw = M[3] * x + M[7] * y + M[11] * z + M[15]
        const cx = M[0] * x + M[4] * y + M[8] * z + M[12]
        const cy = M[1] * x + M[5] * y + M[9] * z + M[13]
        const cz = M[2] * x + M[6] * y + M[10] * z + M[14]
        return `w=${cw.toFixed(2)} ndc=(${(cx / cw).toFixed(2)},${(cy / cw).toFixed(2)},${(cz / cw).toFixed(2)})`
      }
      console.warn(`[DRAPEDUMP] bounds W${west} S${south} E${east} N${north} cam=(${cam[0].toFixed(0)},${cam[1].toFixed(0)},${cam[2].toFixed(0)})`)
      console.warn(`[DRAPEDUMP] SW ${proj(west, south)} | SE ${proj(east, south)} | NW ${proj(west, north)} | NE ${proj(east, north)}`)
    }

    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, this._drapeBGForTex.bg)
    pass.setBindGroup(1, this._drapeTileBG!)
    pass.draw(gridN * gridN * 6) // gridN×gridN grid × 6 verts/cell (matches raster_params.w)
  }

  /** M2 (정석) — adaptive SSE surface quadtree drape. Each data tile is recursively
   *  subdivided by its SCREEN-SPACE chord error (project corners + edge midpoints,
   *  measure px deviation from the straight chord); patches where the sphere curves
   *  most on screen (the limb) refine deeper. Each leaf is draped via a uv sub-rect
   *  of the data texture (M2-1). This decouples mesh DENSITY from data-tile zoom and
   *  keeps the limb smooth where curvature is high. Returns leaf/depth stats. */
  drawSurfaceQuadtree(
    pass: GPURenderPassEncoder,
    camera: Camera,
    projType: number,
    projCenterLon: number,
    projCenterLat: number,
    canvasWidth: number,
    canvasHeight: number,
    dpr: number,
    dataTiles: Array<{ tex: GPUTexture; west: number; south: number; east: number; north: number }>,
  ): { leaves: number; maxDepth: number } {
    const frame = camera.getViewForProjection(projType, canvasWidth, canvasHeight, dpr)
    const M = frame.matrix
    const cam = projType === 0
      ? ([camera.centerX, camera.centerY, 0] as readonly number[])
      : rasterGlobeCamAnchor(projCenterLon, projCenterLat)
    const W = canvasWidth, H = canvasHeight
    const projectPx = (lon: number, lat: number): { x: number; y: number; behind: boolean } => {
      const e = lonLatToECEF(lon, lat)
      const x = e[0] - cam[0], y = e[1] - cam[1], z = e[2] - cam[2]
      const cw = M[3] * x + M[7] * y + M[11] * z + M[15]
      if (cw <= 0) return { x: 0, y: 0, behind: true }
      const cx = M[0] * x + M[4] * y + M[8] * z + M[12]
      const cy = M[1] * x + M[5] * y + M[9] * z + M[13]
      return { x: (cx / cw * 0.5 + 0.5) * W, y: (0.5 - cy / cw * 0.5) * H, behind: false }
    }
    const dot3 = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    const D2R = Math.PI / 180, R2D = 180 / Math.PI
    const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + lat * D2R / 2))
    const latMidMerc = (s: number, n: number) => (2 * Math.atan(Math.exp((mercY(s) + mercY(n)) / 2)) - Math.PI / 2) * R2D
    const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)
    const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

    // ── Global uniform (written ONCE): same mvp/cam for every leaf; gridN=1
    //    (leaves are SSE-refined flat quads), hemisphere-cull on. ──
    const device = this.device
    if (!this._sqGlobalBuf) {
      this._sqGlobalBuf = device.createBuffer({ size: 160, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'sq-global' })
    }
    const g = this._drapeGlobalF32
    g.set(M, 0)
    g[16] = projType; g[17] = projCenterLon; g[18] = projCenterLat; g[19] = frame.logDepthFc
    const LEAF_GRIDN = 4 // per-leaf mesh (curved, not a flat quad — avoids inter-leaf gaps)
    // raster_params: x=opacity, y=back-face debug(off), z=shader hemisphere cull,
    // w=gridN. z=1: per-fragment hemisphere cull (vis=cos_c, discard cos_c<0) so a
    // silhouette-STRADDLING leaf drops its past-the-limb fragments — without it the
    // drape mesh bleeds a green rim past the globe edge. (The earlier "over-discard"
    // was the tile-instability sparse-coverage era, not the cull; iso-proven clean.)
    g[20] = 1; g[21] = 0; g[22] = 1; g[23] = LEAF_GRIDN
    g[24] = 0; g[25] = 0; g[26] = 1; g[27] = 0
    // raster_color1.y (g[29]) = uv-delivery debug flag.
    const uvDbg = (globalThis as { __xgisDebugUvColor?: boolean }).__xgisDebugUvColor ? 1 : 0
    g[28] = 0; g[29] = uvDbg; g[30] = 0; g[31] = 0
    if (projType === 0) { g[32] = camera.centerX; g[33] = camera.centerY; g[34] = 0; g[35] = 0 }
    else { g[32] = cam[0]; g[33] = cam[1]; g[34] = cam[2]; g[35] = 0 }
    device.queue.writeBuffer(this._sqGlobalBuf, 0, g)
    pass.setPipeline(this.pipeline)

    const TARGET_PX = 2, MAXDEPTH = 7, MAXLEAVES = 4000
    let leaves = 0, maxDepth = 0
    interface Node { w: number; s: number; e: number; n: number; uMin: number; vMin: number; uMax: number; vMax: number; depth: number }
    // Diagnostic: drape the OPAQUE checker instead of the data texture, to
    // isolate leaf TILING (gaps) from texture-alpha sampling.
    const useChecker = (globalThis as { __xgisDebugSurfaceQuadtreeChecker?: boolean }).__xgisDebugSurfaceQuadtreeChecker

    interface Leaf { w: number; s: number; e: number; n: number; uMin: number; vMin: number; uMax: number; vMax: number; tex: GPUTexture }
    const SLOT_F32 = 64, SLOT_B = 256
    // ── Leaf-set cache: when the camera MVP (M) + the data-tile set (count,
    //    bounds, textures) are unchanged, skip the Pass-1 traversal AND the slot
    //    write and reuse last frame's leaves — a static-camera frame costs only
    //    the Pass-2 draws. Any camera move / tile (re)bake changes the signature. ──
    let sig = ''
    for (let k = 0; k < 16; k++) sig += M[k].toFixed(3) + ','
    sig += `|${W}x${H}|${dataTiles.length}|`
    for (const d of dataTiles) sig += `${d.west.toFixed(2)},${d.south.toFixed(2)},${d.east.toFixed(2)},${d.north.toFixed(2)};`
    let texMatch = dataTiles.length === this._sqCacheTex.length
    if (texMatch) for (let k = 0; k < dataTiles.length; k++) { if (dataTiles[k].tex !== this._sqCacheTex[k]) { texMatch = false; break } }
    const cacheHit = sig === this._sqCacheSig && texMatch && !!this._sqSlotBuf && this._sqCacheLeafList.length > 0
    let leafList: Leaf[]
    let need: number
    if (cacheHit) {
      leafList = this._sqCacheLeafList
      need = this._sqCacheNeed
      maxDepth = this._sqCacheMaxDepth
      leaves = leafList.length
    } else {
      // ── Pass 1: refine the quadtree, collecting LEAVES (geometry + uv). ──
      leafList = []
      for (const dt of dataTiles) {
        const texForLeaf = useChecker ? this.ensureChecker() : dt.tex
        const stack: Node[] = [{ w: dt.west, s: dt.south, e: dt.east, n: dt.north, uMin: 0, vMin: 0, uMax: 1, vMax: 1, depth: 0 }]
        while (stack.length && leafList.length < MAXLEAVES) {
          const nd = stack.pop()!
          const clon = (nd.w + nd.e) / 2, clat = (nd.s + nd.n) / 2
          // Back-hemisphere cull: skip when the whole patch is on the far side.
          let anyFront = false
          for (const [lo, la] of [[nd.w, nd.s], [nd.e, nd.s], [nd.w, nd.n], [nd.e, nd.n], [clon, clat]] as const) {
            if (dot3(lonLatToECEF(lo, la), cam) > 0) { anyFront = true; break }
          }
          if (!anyFront) continue
          // Screen-space chord error: deviation of projected edge/centre midpoints
          // from the straight chord between projected corners (px).
          const pNW = projectPx(nd.w, nd.n), pNE = projectPx(nd.e, nd.n), pSW = projectPx(nd.w, nd.s), pSE = projectPx(nd.e, nd.s)
          const behind = pNW.behind || pNE.behind || pSW.behind || pSE.behind
          let sse = Infinity
          if (!behind) {
            const eT = projectPx(clon, nd.n), eB = projectPx(clon, nd.s)
            const eL = projectPx(nd.w, clat), eR = projectPx(nd.e, clat)
            const eC = projectPx(clon, latMidMerc(nd.s, nd.n))
            sse = Math.max(
              dist(eT, mid(pNW, pNE)), dist(eB, mid(pSW, pSE)),
              dist(eL, mid(pNW, pSW)), dist(eR, mid(pNE, pSE)),
              dist(eC, mid(mid(pNW, pSE), mid(pNE, pSW))),
            )
          }
          if ((behind || sse > TARGET_PX) && nd.depth < MAXDEPTH) {
            const lonMid = (nd.w + nd.e) / 2, latMid = latMidMerc(nd.s, nd.n)
            const uMid = (nd.uMin + nd.uMax) / 2, vMid = (nd.vMin + nd.vMax) / 2
            const d = nd.depth + 1
            // v = 0 = north → north child takes [vMin, vMid].
            stack.push({ w: nd.w, s: latMid, e: lonMid, n: nd.n, uMin: nd.uMin, vMin: nd.vMin, uMax: uMid, vMax: vMid, depth: d }) // NW
            stack.push({ w: lonMid, s: latMid, e: nd.e, n: nd.n, uMin: uMid, vMin: nd.vMin, uMax: nd.uMax, vMax: vMid, depth: d }) // NE
            stack.push({ w: nd.w, s: nd.s, e: lonMid, n: latMid, uMin: nd.uMin, vMin: vMid, uMax: uMid, vMax: nd.vMax, depth: d }) // SW
            stack.push({ w: lonMid, s: nd.s, e: nd.e, n: latMid, uMin: uMid, vMin: vMid, uMax: nd.uMax, vMax: nd.vMax, depth: d }) // SE
          } else {
            leafList.push({ w: nd.w, s: nd.s, e: nd.e, n: nd.n, uMin: nd.uMin, vMin: nd.vMin, uMax: nd.uMax, vMax: nd.vMax, tex: texForLeaf })
            if (nd.depth > maxDepth) maxDepth = nd.depth
          }
        }
      }
      leaves = leafList.length
      if (leaves === 0) { this._sqCacheSig = ''; return { leaves, maxDepth } }

      // ── One big uniform buffer: 256B slot per leaf, written ONCE. ──
      need = Math.min(leaves, MAXLEAVES)
      if (!this._sqSlotBuf || this._sqSlotBuf.size < need * SLOT_B) {
        this._sqSlotBuf?.destroy()
        this._sqSlotBuf = device.createBuffer({ size: MAXLEAVES * SLOT_B, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'sq-slots' })
        this._sqSlotData = new Float32Array(MAXLEAVES * SLOT_F32)
        this._sqSlotBGs.length = 0 // slot bind groups reference the (new) buffer
      }
      const data = this._sqSlotData!
      for (let i = 0; i < need; i++) {
        const lf = leafList[i]
        const sw = lonLatToECEF(lf.w, lf.s)
        const o = i * SLOT_F32
        data[o] = lf.w; data[o + 1] = lf.s; data[o + 2] = lf.e; data[o + 3] = lf.n
        data[o + 4] = sw[0]; data[o + 5] = sw[1]; data[o + 6] = sw[2]; data[o + 7] = 0
        data[o + 8] = mercY(lf.s); data[o + 9] = mercY(lf.n) - mercY(lf.s); data[o + 10] = 0; data[o + 11] = 0
        data[o + 12] = lf.uMin; data[o + 13] = lf.vMin; data[o + 14] = lf.uMax; data[o + 15] = lf.vMax
        if (!this._sqSlotBGs[i]) {
          this._sqSlotBGs[i] = device.createBindGroup({
            layout: this.tileBindGroupLayout,
            entries: [{ binding: 0, resource: { buffer: this._sqSlotBuf, offset: i * SLOT_B, size: 64 } }],
          })
        }
      }
      device.queue.writeBuffer(this._sqSlotBuf, 0, data, 0, need * SLOT_F32)
      this._sqCacheSig = sig
      this._sqCacheLeafList = leafList
      this._sqCacheNeed = need
      this._sqCacheMaxDepth = maxDepth
      this._sqCacheTex = dataTiles.map((d) => d.tex)
    }
    if ((globalThis as { __xgisDebugSurfaceQuadtreeCache?: boolean }).__xgisDebugSurfaceQuadtreeCache)
      console.warn(`[SURFQT] cache ${cacheHit ? 'HIT (Pass-1 skipped)' : 'MISS (rebuilt)'} leaves=${leaves}`)

    // ── Pass 2: draw each leaf — its tile's group-0 (cached per texture) + its
    //    slot's group-1. (Per-draw uniform delivery proven equivalent to drawDrape
    //    by the iso comparison; no per-leaf bind-group churn needed.) ──
    const vertCount = LEAF_GRIDN * LEAF_GRIDN * 6
    for (let i = 0; i < need; i++) {
      const tex = leafList[i].tex
      let bg0 = this._sqBG0ByTex.get(tex)
      if (!bg0) {
        bg0 = device.createBindGroup({
          layout: this.globalBindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: this._sqGlobalBuf } },
            { binding: 1, resource: tex.createView() },
            { binding: 2, resource: this.linearSampler },
          ],
        })
        this._sqBG0ByTex.set(tex, bg0)
      }
      pass.setBindGroup(0, bg0)
      pass.setBindGroup(1, this._sqSlotBGs[i])
      pass.draw(vertCount)
    }
    return { leaves, maxDepth }
  }

  /** Lazily build a 256×256 RGBA checkerboard for the drape PoC. */
  private ensureChecker(): GPUTexture {
    if (this._checkerTex) return this._checkerTex
    const N = 256, C = 32
    const data = new Uint8Array(N * N * 4)
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const on = (((x / C) | 0) + ((y / C) | 0)) % 2 === 0
        const i = (y * N + x) * 4
        data[i] = on ? 240 : 30; data[i + 1] = on ? 80 : 30; data[i + 2] = on ? 40 : 120; data[i + 3] = 255
      }
    }
    const tex = this.device.createTexture({
      size: { width: N, height: N }, format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      label: 'raster-drape-checker',
    })
    this.device.queue.writeTexture({ texture: tex }, data, { bytesPerRow: N * 4 }, { width: N, height: N })
    this._checkerTex = tex
    return tex
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
    const globalBytes = new ArrayBuffer(160)
    const gf = new Float32Array(globalBytes)
    gf.set(frame.matrix, 0)
    gf.set([projType, projCenterLon, projCenterLat, frame.logDepthFc], 16)
    gf.set([this._opacity, 0, 0, 8], 20)
    gf.set([this._hueRotate, this._brightnessMin, this._brightnessMax, this._saturation], 24)
    gf.set([this._contrast, 0, 0, 0], 28)
    if (projType === 0) gf.set([camera.centerX, camera.centerY, 0, 0], 32)
    else { const c = rasterGlobeCamAnchor(projCenterLon, projCenterLat); gf.set([c[0], c[1], c[2], 0], 32) }

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
    const uniformData = new ArrayBuffer(160)
    new Float32Array(uniformData, 0, 16).set(mvp)
    new Float32Array(uniformData, 64, 4).set([projType, projCenterLon, projCenterLat, frame.logDepthFc])
    // raster_params at offset 80 — x = opacity, y = back-face debug (off),
    // z = drape cull (off for normal tiles), w = grid_n (8 = the 8×8 mesh).
    new Float32Array(uniformData, 80, 4).set([this._opacity, 0, 0, 8])
    // raster_color0 @96 — (hueRotateDeg, brightnessMin, brightnessMax, saturation).
    new Float32Array(uniformData, 96, 4).set([this._hueRotate, this._brightnessMin, this._brightnessMax, this._saturation])
    // raster_color1 @112 — x = contrast, yzw reserved.
    new Float32Array(uniformData, 112, 4).set([this._contrast, 0, 0, 0])
    // cam_ecef_center @128 — camera anchor (ellipsoid) for camera-relative RTC,
    // mirroring polygon's cam_ecef_off. Subtracted in the raster VS so the ECEF
    // vertex projects vertex − cameraCenter through the camera-at-origin MVP.
    // Flat Mercator (projType 0): cam_ecef_center.xy carries the 2D Mercator
    // camera centre — the flat VS computes rel = project(lon,lat) − cam.xy and
    // the ECEF lanes are dead there. 3D / globe: the ECEF anchor (ellipsoid).
    if (projType === 0) {
      new Float32Array(uniformData, 128, 4).set([camera.centerX, camera.centerY, 0, 0])
    } else {
      // ELLIPSOID camera anchor — the raster VS reconstructs each vertex via
      // lonlat_to_ecef (WGS84, E2≠0), so the anchor it subtracts MUST be on the
      // same ellipsoid. getECEFCenter() is the SPHERE (E2=0); subtracting it
      // from ellipsoid vertices left the ellipsoid−sphere discrepancy (~21.5 km
      // at mid-lat) on every vertex → the raster sheet flew off the globe. This
      // is the exact frame-consistency fix the vector tiler already applies to
      // cam_ecef_off (vector-tile-renderer.ts:3627-3638).
      const camC = rasterGlobeCamAnchor(projCenterLon, projCenterLat)
      new Float32Array(uniformData, 128, 4).set([camC[0], camC[1], camC[2], 0])
    }
    // RHI pilot: route the draw through the layered backend seam (non-pick) when
    // enabled. The loop below BUILDS draw items; executeRasterItems issues them.
    const useRhi = (globalThis as { __xgisRasterViaRhi?: boolean }).__xgisRasterViaRhi === true && !isPickEnabled()
    const rhiTiles: RasterTile[] = []
    if (useRhi) {
      if (!this._rasterDraper) this._rasterDraper = new RasterDraper(new WebGpuDevice(this.device), this.format, getSampleCount())
    } else {
      this.device.queue.writeBuffer(this.uniformBuffer, 0, uniformData)
      pass.setPipeline(this.pipeline)
      // Reset per-draw uniform pool index
      this.tileUniformIdx = 0
    }

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
      // Legacy: bind the per-tile global group now. RHI: the executor builds +
      // binds it from item.texture (cached per texture in the material).
      if (!useRhi) {
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
      }

      // iter-188 — world-copy loop. For Mercator, draw the tile in
      // every visible world copy by shifting bounds.x / bounds.z by
      // wo * 360°. The vertex shader's mix(bounds.x, bounds.z, uu)
      // naturally lands lon in the right world copy for lonlat_to_ecef.
      // tile_ecef_center stays unshifted (shared across copies; the
      // RTC subtraction is in 3D ECEF and copy-invariant).
      // Non-Mercator collapses to wo=0 only.
      for (const wo of RASTER_WORLD_COPIES) {
        const tf = this.drawTileF32
        // bounds: shift west/east by wo*360° so the shader's mix(bounds.x, bounds.z, uu)
        // naturally produces the correct world-copy longitude for lonlat_to_ecef.
        tf[0] = west + wo * 360; tf[1] = south; tf[2] = east + wo * 360; tf[3] = north
        // tile_ecef_center: ECEF of SW corner (unshifted; shared across copies).
        tf[4] = swEcef[0]; tf[5] = swEcef[1]; tf[6] = swEcef[2]; tf[7] = 0
        tf[8] = mercSouth        // merc_y.x
        tf[9] = mercDiff         // merc_y.y
        tf[10] = 0; tf[11] = 0   // padding
        tf[12] = 0; tf[13] = 0; tf[14] = 1; tf[15] = 1 // uv_rect = whole texture
        if (useRhi) {
          // Builder: emit a draw item (pure data — tf is reused, so copy).
          rhiTiles.push({ texture: cached.texture, tileBytes: tf.slice(0, 16) })
        } else {
          // Get or create a pooled uniform buffer + matching bind group.
          if (this.tileUniformIdx >= this.tileUniformPool.length) {
            const buf = this.device.createBuffer({
              size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
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
          this.device.queue.writeBuffer(tileBuf, 0, tf)
          pass.setBindGroup(1, tileBG)
          pass.draw(384) // 8×8 grid × 6 verts/cell
        }
      }
    }

    // RHI path: issue the built draw items through the generic executor.
    if (useRhi) this._rasterDraper!.draw(wrapWebGpuPass(pass), uniformData, rhiTiles)

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
