// ═══ Raster Tile Renderer — 텍스처 타일을 GPU 투영으로 렌더링 ═══

import type { GPUContext } from '@xgis/rhi-webgpu'
import type { Camera } from '../camera'
import { visibleTilesFrustum, tileUrl, loadImageTexture, loadImageBitmap } from '@xgis/data'
import { mercator as mercatorProj, mercatorYToLat } from '@xgis/geo'
import { activeBody } from '@xgis/shared'
import { lonLatToECEF, type ECEF } from '@xgis/shared'
import type { RhiDevice, RhiRenderPass, RhiTexture } from '@xgis/engine'
import { RasterDraper, type RasterTile } from './material/raster-material'
import { wrapWebGpuPass } from '@xgis/rhi-webgpu'
import { routeToSphereSelector, enumerateWorldCopies, isGlobeProj } from '@xgis/geo'
import { isPickEnabled, getSampleCount } from '@xgis/engine'
import { DEBUG_OVERDRAW } from '../debug-flags'
import { globeVisibleTiles } from '@xgis/data'
import { uniformBlock, type UniformBlockOf } from '@xgis/engine'
import {
  rasterU as RASTER_U,
  rasterTileU as RASTER_TILE_U,
  rasterGridN,
} from '../shaders/dsl/raster'
import { globeEyeUniform } from './globe-eye-uniform'

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

/** Tile-pyramid cover zoom for a raster source, tileSize-aware.
 *
 *  The camera zoom is the Mapbox/MapLibre 512-px-tile convention (camera.ts:
 *  `mpp = WORLD_MERC / TILE_PX / 2^zoom`, TILE_PX = 512): at zoom Z one z=Z
 *  tile covers 512 CSS px. A 256-px raster tile stretched over that span is
 *  magnified 2× (4× area) — the "raster looks blurry / low-res" class. MapLibre
 *  compensates in Transform#coveringZoomLevel: tile z = round(zoom +
 *  log2(512 / tileSize)), i.e. +1 LOD for the de-facto-standard 256-px XYZ
 *  tiles (OSM, Esri, terrarium), +0 for true 512-px sources. Mirror that here
 *  so a given camera zoom samples raster texels at the same density as
 *  MapLibre. Round (not floor) is the raster roundZoom semantic both engines
 *  share. Clamp stays [0, 18] — the pre-existing pyramid cap.
 *  (exported for the zoom-selection unit gate — raster-cover-zoom.test.ts) */
export function rasterCoverZoom(zoom: number, tileSize: number): number {
  const bias = Math.log2(512 / tileSize)
  return Math.max(0, Math.min(18, Math.round(zoom + bias)))
}

// ── Typed pack targets (#733 P2b) — layout from wgslLayout(U.struct), write()
// typed by the same field record the WGSL is emitted from. LAZY memo (draw time).
let _rasterBlock: UniformBlockOf<typeof RASTER_U> | null = null
function rasterBlock(): UniformBlockOf<typeof RASTER_U> {
  return (_rasterBlock ??= uniformBlock(RASTER_U))
}
let _rasterTileBlock: UniformBlockOf<typeof RASTER_TILE_U> | null = null
function rasterTileBlock(): UniformBlockOf<typeof RASTER_TILE_U> {
  return (_rasterTileBlock ??= uniformBlock(RASTER_TILE_U))
}

export interface RasterColorParams {
  opacity: number
  hueRotate: number
  brightnessMin: number
  brightnessMax: number
  saturation: number
  contrast: number
}

/** Pack the raster global uniform — the SINGLE authority shared by render() and
 *  the forced-WebGL2 checker (renderRhiChecker). The checker's old literal-offset
 *  packer carried raster_params.w = 8 where render() wrote 0 — a dead lane (the
 *  shader reads only raster_params.x), retired by this unification. Completeness
 *  is compile-time (#600 globe_eye class does not compile if omitted); globe_eye
 *  is all-zero off the globe (frame.eye undefined), matching both old packers.
 *  camAnchor: 2D Mercator centre in .xy on the flat path (ECEF lanes dead
 *  there); the WGS84 ELLIPSOID anchor (rasterGlobeCamAnchor) on globe/3D.
 *  (exported for the byte-equality gate — raster-frame-uniform.test.ts) */
export function writeRasterFrameUniform(
  block: UniformBlockOf<typeof RASTER_U>,
  frame: { matrix: Float32Array; logDepthFc: number; eye?: readonly [number, number, number] },
  projType: number,
  projCenterLon: number,
  projCenterLat: number,
  camAnchor: readonly [number, number, number],
  c: RasterColorParams,
): void {
  const ge = globeEyeUniform(frame.eye)
  // DSFUN hi/lo split of the camera anchor (full rationale: raster.ts
  // Uniforms.cam_ecef_center): the VS subtracts hi (Sterbenz-exact) then lo, so the
  // camera term is df64-precise and no longer jitters as it pans (the z18+ shake).
  // hi is byte-identical to the pre-split single-f32 lane (fround is idempotent).
  const hi = (v: number): number => Math.fround(v)
  const lo = (v: number): number => Math.fround(v - Math.fround(v))
  block.write({
    mvp: frame.matrix,
    proj_params: [projType, projCenterLon, projCenterLat, frame.logDepthFc],
    raster_params: [c.opacity, 0, 0, 0],
    raster_color0: [c.hueRotate, c.brightnessMin, c.brightnessMax, c.saturation],
    raster_color1: [c.contrast, 0, 0, 0],
    cam_ecef_center: [hi(camAnchor[0]), hi(camAnchor[1]), hi(camAnchor[2]), 0],
    cam_ecef_center_l: [lo(camAnchor[0]), lo(camAnchor[1]), lo(camAnchor[2]), 0],
    globe_eye: [ge[0], ge[1], ge[2], ge[3]],
  })
}

/** Pack one raster TileUniforms slot (exported for the byte-equality gate). */
export function writeRasterTileUniform(
  block: UniformBlockOf<typeof RASTER_TILE_U>,
  west: number,
  south: number,
  east: number,
  north: number,
  tileEcef: readonly [number, number, number] | ECEF,
  mercSouth: number,
  mercDiff: number,
  /** #1040 — raster surface grid subdivision N (rasterGridN); shader reads grid.x. */
  gridN: number,
  /** Per-tile fade-in opacity (0..1) → tile_ecef_center.w; the FS multiplies
   *  the sampled alpha by it so a freshly-appeared tile cross-fades over its
   *  cached parent (raster-fade-duration). Default 1 = fully shown (the checker
   *  / cap / instant paths stay byte-identical). */
  tileOpacity = 1,
  /** #1053 — pole-cap sign in the (formerly reserved) grid.y lane: 0 = a normal
   *  Mercator tile (byte-identical), +1 = north cap, −1 = south cap. vs_tile's
   *  select() reads this to fan the band edge to the pole. Default 0. */
  capSign = 0,
): void {
  block.write({
    bounds: [west, south, east, north],
    tile_ecef_center: [tileEcef[0], tileEcef[1], tileEcef[2], tileOpacity],
    merc_y: [mercSouth, mercDiff],
    grid: [gridN, capSign],
  })
}

// ── #1053 — raster globe pole caps ──
// The Web-Mercator raster surface saturates at ±85.0511°, so the topmost (y=0)
// and bottommost (y=2^z−1) tile rows abut an open polar hole. On the GLOBE only
// (isGlobeProj → projType 7, the sole ECEF surface arm; every flat/Mercator
// projection is a plane with no geographic pole), those rows get an extra cap
// "tile" that fans their band edge to the pole. Cheap pure predicates, zero
// allocation — the render loop calls them per tile.
/** North cap needed? Globe + topmost tile row (north edge = +85.0511°). */
export function needsNorthPoleCap(projType: number, tileY: number): boolean {
  return isGlobeProj(projType) && tileY === 0
}
/** South cap needed? Globe + bottommost tile row (south edge = −85.0511°).
 *  `tilesPerAxis` = 2^z at the tile's render zoom. */
export function needsSouthPoleCap(projType: number, tileY: number, tilesPerAxis: number): boolean {
  return isGlobeProj(projType) && tileY === tilesPerAxis - 1
}

/** Pack + append one pole-cap "tile" to the raster batch (#1053). Reuses the
 *  memoised per-tile block (write repacks all lanes; the bytes are COPIED for
 *  the draw item, since the block is overwritten by the next push). Identical
 *  to a ground tile except grid.y = capSign (±1), which flips vs_tile to the
 *  band-edge→pole cap fan. Module-level (no per-frame closure allocation). */
function pushRasterCap(
  out: RasterTile[],
  block: UniformBlockOf<typeof RASTER_TILE_U>,
  // Indexed-access type: no NEW raw-WebGPU identifier (raw-webgpu ratchet, #991).
  texture: RasterTile['texture'],
  west: number,
  south: number,
  east: number,
  north: number,
  swEcef: readonly [number, number, number] | ECEF,
  mercSouth: number,
  mercDiff: number,
  gridN: number,
  capSign: number,
  tileOpacity = 1,
): void {
  writeRasterTileUniform(
    block,
    west,
    south,
    east,
    north,
    swEcef,
    mercSouth,
    mercDiff,
    gridN,
    tileOpacity,
    capSign,
  )
  out.push({ texture, tileBytes: new Float32Array(block.buffer.slice(0)), gridN })
}

interface CachedTile {
  texture: GPUTexture | RhiTexture
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
  /** Source `tileSize` (px) — drives the cover-zoom bias (rasterCoverZoom).
   *  Default 256: the de-facto XYZ raster standard (OSM / Esri / terrarium all
   *  serve 256-px tiles; MapLibre's own raster examples author tileSize: 256).
   *  An authored `tileSize: 512` opts a true-512 source back to +0 bias. */
  private _tileSize = 256
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
  /** Raster tile fade-in duration (ms) — a freshly-appeared tile cross-fades
   *  0→1 over this window, MapLibre `raster-fade-duration`. 0 = instant pop-in
   *  (byte-identical to the pre-fade path); the map lowers it to 0 under
   *  prefers-reduced-motion. Default 300 ms. */
  private _fadeDurationMs = 300
  /** Set by render() when ANY tile is mid-fade — the map keep-alive
   *  (shouldRenderThisFrame) pumps the next frame so the ramp advances. */
  private _hasFadingTiles = false
  // (per-tile packing goes through rasterTileBlock() — #733 P2b)
  private colorParams(): RasterColorParams {
    return {
      opacity: this._opacity,
      hueRotate: this._hueRotate,
      brightnessMin: this._brightnessMin,
      brightnessMax: this._brightnessMax,
      saturation: this._saturation,
      contrast: this._contrast,
    }
  }

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
    // Forced-WebGL2 is the single-sample isolated screen pass (slice-1
    // topology) — a getSampleCount()=4 pipeline would mismatch it.
    return (this._rasterDraper ??= new RasterDraper(
      this.rhi,
      this.format,
      Math.min(getSampleCount(), this.rhi.caps.maxSampleCount),
    ))
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

  /** Set the source's tile size in px (256 | 512). Values other than 256/512
   *  keep the current setting — same validation the hillshade arm uses. */
  setTileSize(tileSize: number | undefined): void {
    if (tileSize === 256 || tileSize === 512) this._tileSize = tileSize
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

  /** Set the raster tile fade-in duration (ms). 0 disables the fade (instant
   *  pop-in, byte-identical to the pre-fade path); the map passes 0 under
   *  prefers-reduced-motion. Non-finite / negative inputs are ignored. */
  setRasterFadeDurationMs(ms: number): void {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return
    this._fadeDurationMs = ms
  }

  /** True when the LAST render() left any tile mid-fade — the map's
   *  shouldRenderThisFrame ORs this in so frames keep coming until the ramp
   *  completes (mirrors the label ledger's hasActive() keep-alive). */
  hasFadingTiles(): boolean {
    return this._hasFadingTiles
  }

  /** Set the per-frame Mapbox raster colour adjustments. Caller resolves
   *  each `paintShapes.raster.*` PropertyShape<number> before render().
   *  Non-finite inputs fall back to the spec default (a no-op) so a
   *  malformed value can't NaN-poison the texel like opacity used to. */
  setColorAdjust(
    hueRotate: number,
    brightnessMin: number,
    brightnessMax: number,
    saturation: number,
    contrast: number,
  ): void {
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
  /** True once a raster source's URL template is configured (#834 M5 slice 2
   *  — the forced-WebGL2 frame draws real tiles instead of the analytic
   *  checker when a source exists). */
  hasSource(): boolean {
    return this.urlTemplate !== ''
  }

  hasPendingLoads(): boolean {
    return this.loadingTiles.size > 0
  }

  /** Count of raster tiles currently mid-fetch (the set `hasPendingLoads`
   *  tests). Feeds the map's per-frame `getMissingTileCount()` so a loading
   *  affordance covers network raster sources, not just vector tiles. */
  pendingLoadCount(): number {
    return this.loadingTiles.size
  }

  /** Lazily build the 256×256 RGBA checker as an RHI texture (WebGl2Device path). */
  private ensureRhiChecker(rhi: RhiDevice): RhiTexture {
    if (this._rhiChecker) return this._rhiChecker
    const N = 256,
      C = 32
    const data = new Uint8Array(N * N * 4)
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const on = (((x / C) | 0) + ((y / C) | 0)) % 2 === 0
        const i = (y * N + x) * 4
        data[i] = on ? 240 : 30
        data[i + 1] = on ? 80 : 30
        data[i + 2] = on ? 40 : 120
        data[i + 3] = 255
      }
    }
    const tex = rhi.createTexture({
      width: N,
      height: N,
      format: 'rgba8unorm',
      usage: ['sample', 'copy-dst'],
      label: 'rhi-raster-checker',
    })
    rhi.writeTexture(tex, data, N * 4, N, N)
    this._rhiChecker = tex
    return tex
  }

  /** US-003: render the analytic checker tile on WebGl2Device through the engine's RHI
   *  screen pass — a real raster tile (a z0 world tile, AA-free, asymmetric for the
   *  orientation gate) drawn via the SAME RasterDraper the WebGPU pilot uses, now backed
   *  by the WebGl2Device. globalBytes/tileBytes mirror the live render() packing. */
  renderRhiChecker(
    rhi: RhiDevice,
    pass: RhiRenderPass,
    camera: Camera,
    projType: number,
    projCenterLon: number,
    projCenterLat: number,
    w: number,
    h: number,
    dpr: number,
  ): void {
    this._rhiDraper ??= new RasterDraper(rhi, 'rgba8unorm', 1)
    const checker = this.ensureRhiChecker(rhi)
    const frame = camera.getViewForProjection(projType, w, h, dpr)

    // Global uniform through the SAME packer render() uses (#733 P2b single
    // authority — the old literal-offset copy here carried raster_params.w = 8,
    // a dead lane the shader never reads; now uniformly 0).
    // cam_ecef_center: the slice renders a FLAT z0 tile (single-sample, projType-0 scope —
    // the globe/ECEF anchor is Story-5/6), so pack the 2D Mercator camera centre. No projType
    // branch here keeps the forced-WebGL2 path off the projType-comparison arch ratchet.
    const B = rasterBlock()
    writeRasterFrameUniform(
      B,
      frame,
      projType,
      projCenterLon,
      projCenterLat,
      [camera.centerX, camera.centerY, 0],
      this.colorParams(),
    )

    // One z0 world tile (whole Mercator band).
    const west = -180,
      south = -85.051129,
      east = 180,
      north = 85.051129
    const swEcef = lonLatToECEF(west, south)
    const DEG2RAD = Math.PI / 180
    const mercSouth = Math.log(Math.tan(Math.PI / 4 + (south * DEG2RAD) / 2))
    const mercNorth = Math.log(Math.tan(Math.PI / 4 + (north * DEG2RAD) / 2))
    const TB = rasterTileBlock()
    // #1040 — the checker is a whole-world z0 tile; on the globe it densifies to 128×128.
    const gridN = rasterGridN(projType, 0)
    writeRasterTileUniform(
      TB,
      west,
      south,
      east,
      north,
      swEcef,
      mercSouth,
      mercNorth - mercSouth,
      gridN,
    )

    this._rhiDraper.draw(pass, B.buffer, [
      { texture: checker, tileBytes: new Float32Array(TB.buffer.slice(0)), gridN },
    ])
  }

  /** Backend-appropriate raster tile load (#834 M5 slice 2): the WebGPU path
   *  is the verbatim loadImageTexture (byte-identical); WebGl2Device decodes
   *  via the shared SSRF-guarded loadImageBitmap and uploads through the RHI
   *  copyExternalImage seam (texSubImage2D — no CPU readback). */
  private async loadTileTexture(
    url: string,
    signal: AbortSignal,
  ): Promise<GPUTexture | RhiTexture | null> {
    if (this.rhi.backend !== 'webgl2') return loadImageTexture(this.device, url, signal)
    const bitmap = await loadImageBitmap(url, signal)
    if (!bitmap) return null
    // #1153 P2 R4 — createTexture throws on a lost context (rhi-webgl2 :963) and
    // copyExternalImage can throw too. Release the decoded bitmap + any
    // half-created texture and normalise to the WebGPU null contract
    // (loadImageTexture returns null on failure) so the caller's loadingTiles key
    // is released rather than wedged; the chain's .catch is the outer backstop.
    let tex: RhiTexture | null = null
    try {
      tex = this.rhi.createTexture({
        width: bitmap.width,
        height: bitmap.height,
        format: 'rgba8unorm',
        usage: ['sample', 'copy-dst'],
        label: 'raster-tile',
      })
      this.rhi.copyExternalImage(tex, bitmap, bitmap.width, bitmap.height)
    } catch {
      bitmap.close()
      if (tex) this.rhi.destroyTexture(tex)
      return null
    }
    bitmap.close()
    return tex
  }

  render(
    pass: GPURenderPassEncoder | RhiRenderPass,
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
    const { zoom } = camera

    const currentZ = rasterCoverZoom(zoom, this._tileSize)

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
    const R = activeBody().sphereR
    const centerLon = (camera.centerX / R) * (180 / Math.PI)
    const centerLat = mercatorYToLat(camera.centerY)
    const cssW = canvasWidth / dpr
    const cssH = canvasHeight / dpr
    let tiles: ReturnType<typeof visibleTilesFrustum>
    if (routeToSphereSelector(projType, camera.globeMode)) {
      const globeTiles = globeVisibleTiles(
        centerLon,
        centerLat,
        camera.zoom,
        currentZ,
        cssW,
        cssH,
        camera.pitch ?? 0,
        camera.bearing ?? 0,
      )
      if (enumerateWorldCopies(projType, camera.zoom)) {
        tiles = []
        for (const wc of [-2, -1, 0, 1, 2]) {
          for (const t of globeTiles) {
            tiles.push({ z: t.z, x: t.x, y: t.y, ox: t.x + wc * (1 << t.z) })
          }
        }
      } else {
        tiles = globeTiles.map((t) => ({ z: t.z, x: t.x, y: t.y, ox: t.ox }))
      }
    } else {
      // Flat projections: pass projection name so the selector's world-copy
      // gate (worldCopiesFor()) picks single-world for non-Mercator.
      const selectorProj =
        projType === 0
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
    const visibleKeys = new Set(tiles.map((c) => `${c.z}/${c.x}/${c.y}`))

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

      this.loadTileTexture(url, ctrl.signal)
        // #1153 P2 R4 — narrow the release to the LOAD promise: an expected load
        // failure (bitmap fetch reject, or createTexture throw on a lost context)
        // resolves to null so the .then ALWAYS frees the loadingTiles slot (else the
        // key wedges, pinning all MAX_CONCURRENT slots → raster stalls). Scoped here so
        // a throw from the .then bookkeeping stays a visible unhandled rejection, not swallowed.
        .catch(() => null)
        .then((texture) => {
          this.loadingTiles.delete(key)
          if (!texture) return
          this.tileCache.set(key, {
            texture,
            lastUsedFrame: this.frameCount,
            firstShownFrame: -1,
          })
          this.evictTiles(visibleKeys)
        })
    }

    // Write global uniforms through the typed block (#733 P2b — the single
    // authority shared with the forced-WebGL2 checker). proj_params.w =
    // log_depth_fc so the raster grid shader can apply/read the log-depth
    // transform uniformly with the vector pipelines.
    // cam_ecef_center: Flat Mercator (projType 0) packs the 2D Mercator camera
    // centre in .xy (the flat VS computes rel = project(lon,lat) − cam.xy; the
    // ECEF lanes are dead there). 3D / globe packs the WGS84 ELLIPSOID anchor —
    // the raster VS reconstructs each vertex via lonlat_to_ecef (E2≠0), so the
    // anchor it subtracts MUST be on the same ellipsoid; getECEFCenter() is the
    // SPHERE (E2=0), and subtracting it left the ellipsoid−sphere discrepancy
    // (~21.5 km at mid-lat) on every vertex → the raster sheet flew off the
    // globe. Mirrors the vector tiler's cam_ecef_off fix.
    const camAnchor: readonly [number, number, number] =
      projType === 0
        ? [camera.centerX, camera.centerY, 0]
        : rasterGlobeCamAnchor(projCenterLon, projCenterLat)
    const B = rasterBlock()
    writeRasterFrameUniform(
      B,
      frame,
      projType,
      projCenterLon,
      projCenterLat,
      camAnchor,
      this.colorParams(),
    )
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
        this.loadTileTexture(
          tileUrl(this.urlTemplate, { z: parentZ, x: parentX, y: parentY, ox: parentX }),
          ctrl.signal,
        )
          // #1153 P2 R4 — same un-wedge backstop for the parent-fallback chain, with
          // the catch scoped to the LOAD promise so a .then-body throw still surfaces.
          .catch(() => null)
          .then((texture) => {
            this.loadingTiles.delete(parentKey)
            if (texture)
              this.tileCache.set(parentKey, {
                texture,
                lastUsedFrame: this.frameCount,
                firstShownFrame: -1,
              })
          })
          .catch((e) => console.error('[X-GIS] raster parent-tile post-load bookkeeping failed', e))
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
    // Per-frame draw dedup, keyed by the RENDER coord + world copy (ox).
    // Parent fallback maps every uncached child onto the same parent at the
    // parent's FULL bounds — without this, four missing z+1 children draw
    // the identical parent quad four times at one world position (wasted
    // fill; with raster-opacity < 1 the alpha COMPOUNDS, the same defect
    // class the world-copy single-source fix removed for ox×wo).
    const drawnKeys = new Set<string>()
    // Per-tile fade-in: a freshly-appeared tile ramps opacity 0→1 over
    // `fadeFrames`, cross-fading over its cached parent (drawn beneath). The ramp
    // is measured from the tile's FIRST DRAW (firstShownFrame, lazily stamped
    // below), so a tile pre-loaded off-screen still fades when it first shows.
    // fadeFrames 0 (rasterFadeDuration 0 / reduced-motion) ⇒ instant full
    // opacity, byte-identical to the pre-fade path. ~60 fps → durationMs·0.06.
    const fadeFrames = this._fadeDurationMs > 0 ? this._fadeDurationMs * 0.06 : 0
    let anyFading = false

    // Emit one cached tile at `renderCoord` (bounds from the coord) with the
    // supplied texture + per-tile opacity, in every visible world copy plus its
    // globe pole caps. Honours the per-frame `drawnKeys` dedup so a parent shared
    // by several children draws once. Extracted from the inline loop so the fade
    // path can emit BOTH a parent (opacity 1, beneath) and its fading child
    // (opacity < 1, over) for one visible coord.
    const emitTileAt = (
      renderCoord: { z: number; x: number; y: number; ox?: number },
      texture: RasterTile['texture'],
      tileOpacity: number,
    ): void => {
      const rn = Math.pow(2, renderCoord.z)
      const ox = renderCoord.ox ?? renderCoord.x
      const drawKey = `${renderCoord.z}/${renderCoord.x}/${renderCoord.y}/${ox}`
      if (drawnKeys.has(drawKey)) return
      drawnKeys.add(drawKey)
      const west = (ox / rn) * 360 - 180
      const east = ((ox + 1) / rn) * 360 - 180
      const north = (Math.atan(Math.sinh(Math.PI * (1 - (2 * renderCoord.y) / rn))) * 180) / Math.PI
      const south =
        (Math.atan(Math.sinh(Math.PI * (1 - (2 * (renderCoord.y + 1)) / rn))) * 180) / Math.PI
      // ECEF anchor: SW corner in WGS84 ECEF (unshifted across copies); the shader
      // subtracts it from lonlat_to_ecef(vertex) for the RTC offset. f64 here, f32
      // in the uniform — fine because tile SW is close to the vertices.
      const swEcef = lonLatToECEF(west, south)
      // Mercator Y bounds in f64 — store merc_south + the small diff separately to
      // avoid f32 cancellation at high zoom where the two are nearly equal.
      const DEG2RAD = Math.PI / 180
      const MERC_LIMIT = 85.051129
      const clampMerc = (v: number) => Math.max(-MERC_LIMIT, Math.min(MERC_LIMIT, v))
      const mercSouth = Math.log(Math.tan(Math.PI / 4 + (clampMerc(south) * DEG2RAD) / 2))
      const mercNorth = Math.log(Math.tan(Math.PI / 4 + (clampMerc(north) * DEG2RAD) / 2))
      const mercDiff = mercNorth - mercSouth
      // iter-188 world-copy loop; #1040 grid N from the render (fallback-aware) zoom.
      const gridN = rasterGridN(projType, renderCoord.z)
      for (const wo of RASTER_WORLD_COPIES) {
        const TB = rasterTileBlock() // memoised — write() repacks every lane each iteration
        writeRasterTileUniform(
          TB,
          west + wo * 360,
          south,
          east + wo * 360,
          north,
          swEcef,
          mercSouth,
          mercDiff,
          gridN,
          tileOpacity,
        )
        // The block buffer is reused every iteration — COPY it for the batch entry.
        tilesArr.push({ texture, tileBytes: new Float32Array(TB.buffer.slice(0)), gridN })
        // #1053 — globe pole cap: fan the top/bottom band edge to the geographic
        // pole (grid.y = ±1). Flat/Mercator stays byte-identical (no cap). The cap
        // inherits the tile's fade opacity so it cross-fades with its band.
        // prettier-ignore
        if (needsNorthPoleCap(projType, renderCoord.y))
          pushRasterCap(tilesArr, TB, texture, west + wo * 360, south, east + wo * 360, north, swEcef, mercSouth, mercDiff, gridN, 1, tileOpacity)
        // prettier-ignore
        if (needsSouthPoleCap(projType, renderCoord.y, rn))
          pushRasterCap(tilesArr, TB, texture, west + wo * 360, south, east + wo * 360, north, swEcef, mercSouth, mercDiff, gridN, -1, tileOpacity)
      }
    }

    // Walk up from a coord to its nearest cached ancestor (1–4 levels): the
    // render coord + cache entry, or null. Shared by the missing-tile fallback
    // AND the cross-fade (parent drawn beneath a fading child).
    const findCachedParent = (coord: {
      z: number
      x: number
      y: number
      ox?: number
    }): {
      renderCoord: { z: number; x: number; y: number; ox: number }
      entry: CachedTile
    } | null => {
      for (let pz = 1; pz <= 4; pz++) {
        const parentZ = coord.z - pz
        if (parentZ < 0) break
        const px = coord.x >> pz
        const py = coord.y >> pz
        const entry = this.tileCache.get(`${parentZ}/${px}/${py}`)
        if (entry)
          return {
            renderCoord: { z: parentZ, x: px, y: py, ox: (coord.ox ?? coord.x) >> pz },
            entry,
          }
      }
      return null
    }

    // Render tiles: exact tile (with its fade-in + parent cross-fade beneath),
    // else the already-shown parent fallback at full opacity.
    for (const coord of tiles) {
      const exact = this.tileCache.get(`${coord.z}/${coord.x}/${coord.y}`)
      if (exact) {
        // Stamp the first-draw frame lazily (load leaves it -1) so the ramp
        // starts when the tile actually appears, not when it loaded.
        if (exact.firstShownFrame < 0) exact.firstShownFrame = this.frameCount
        const fadeAlpha =
          fadeFrames > 0 ? Math.min(1, (this.frameCount - exact.firstShownFrame) / fadeFrames) : 1
        if (fadeAlpha < 1) {
          anyFading = true
          // Cross-fade: draw the cached parent BENEATH the fading child (pushed
          // first = under) so no background flashes through during the ramp — the
          // gap the reverted vector-tile fade hit. dedup collapses a shared parent.
          const parent = findCachedParent(coord)
          if (parent) {
            emitTileAt(parent.renderCoord, parent.entry.texture, 1)
            parent.entry.lastUsedFrame = this.frameCount
          }
        }
        emitTileAt(coord, exact.texture, fadeAlpha)
        exact.lastUsedFrame = this.frameCount
      } else {
        const parent = findCachedParent(coord)
        if (parent) {
          emitTileAt(parent.renderCoord, parent.entry.texture, 1)
          parent.entry.lastUsedFrame = this.frameCount
        }
      }
    }
    this._hasFadingTiles = anyFading

    // Issue every collected tile in ONE draper.draw — the sole raster draw path (P1.4),
    // byte-identical to the legacy multi-tile loop. uniformData is the 160B global; the draper
    // owns the per-tile pool + the global/texture/sampler bind group. pick = the opaque-pass MRT.
    // Always called (even with 0 visible tiles) so the global uniform is written every frame —
    // matching the legacy path (it wrote the global before the loop): 0 tiles → global write, no draws.
    // A WebGl2Device frame hands in an RhiRenderPass already; the WebGPU frame
    // still passes the raw encoder (wrapped here, flips with its cluster).
    this.ensureRasterDraper().draw(
      this.rhi.backend === 'webgl2'
        ? (pass as RhiRenderPass)
        : wrapWebGpuPass(pass as GPURenderPassEncoder),
      B.buffer,
      tilesArr,
      this._nearest,
      isPickEnabled(),
    )

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
      if (this.rhi.backend === 'webgl2') this.rhi.destroyTexture(tile.texture as RhiTexture)
      else (tile.texture as GPUTexture).destroy()
      this._rasterDraper?.dropTexture(tile.texture) // invalidate the draper cache before freeing
      this.tileCache.delete(key)
    }
  }
}
