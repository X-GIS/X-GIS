// ═══ Raster Tile Renderer — 텍스처 타일을 GPU 투영으로 렌더링 ═══

import type { GPUContext } from '@xgis/rhi-webgpu'
import { frameCenterLatOf, type Camera } from '../camera'
import { visibleTilesFrustum, tileUrl, loadImageBitmap, type TileRowScheme } from '@xgis/data'
import { mercator as mercatorProj } from '@xgis/geo'
import { activeBody } from '@xgis/shared'
import { lonLatToECEF, type ECEF } from '@xgis/shared'
import type { RhiDevice, RhiRenderPass, RhiTexture } from '@xgis/engine'
import { RasterDraper, type RasterTile } from './material/raster-material'
import { FailedTileLedger, InflightLedger } from './tile-retry'
import { clipTilesToBounds, normalizeSourceBounds, type SourceBounds } from './source-bounds-clip'
import {
  admitTile,
  type EvictableTile,
  evictToBudget,
  overBudget,
  abortLoadingTiles,
  dropAllTiles,
  textureBytesOf,
  mipLevelCountFor,
  type LoadedTexture,
} from './raster-cache-budget'
import { routeToSphereSelector, enumerateWorldCopies, isGlobeProj } from '@xgis/geo'
import { pickTargetsEnabled, getSampleCount } from '@xgis/engine'
import { isOverdrawActive } from '../debug-flags'
import { globeVisibleTiles } from '@xgis/data'
import { uniformBlock, type UniformBlockOf } from '@xgis/engine'
import {
  rasterU as RASTER_U,
  rasterTileU as RASTER_TILE_U,
  rasterGridN,
} from '../shaders/dsl/raster'
import { projectCpu } from '../shaders/dsl/cpu-projections'
import { globeEyeUniform } from './globe-eye-uniform'
import { rasterGridTrig } from './raster-grid-trig'

/** Camera RTC anchor for the raster VS on the globe / 3D surfaces.
 *
 *  MUST be the WGS84 **ellipsoid** ECEF of the camera centre (lonLatToECEF, E2≠0) — the same
 *  frame `lonlat_to_ecef` reconstructs the raster tile vertices in. The camera's
 *  `getECEFCenter()` is the **sphere** (E2=0); subtracting a sphere anchor from ellipsoid
 *  vertices leaves the ellipsoid−sphere discrepancy (~21.5 km at mid-latitude) on every vertex,
 *  which threw the whole raster sheet off the globe. Mirrors the vector tiler's ellipsoid
 *  `cam_ecef_off` (vector-tile-renderer.ts:3627-3638). */
export function rasterGlobeCamAnchor(lonDeg: number, latDeg: number): ECEF {
  return lonLatToECEF(lonDeg, latDeg)
}

/** The DSFUN camera anchor for the raster/hillshade global uniform — the single authority
 *  shared by RasterRenderer + HillshadeRenderer (both drive the shared vs_tile, so both MUST
 *  pack identical lanes). Lanes are PER projType arm (see the cam_ecef_center struct-field
 *  comment in raster.ts): Mercator → 2D Merc centre; flat non-Mercator (1-6) → [clon,
 *  camProj0.x, camProj0.y] where camProj0 = the camera's projected 2D centre in the clon = 0
 *  frame (kills the single-f32 clon/clat shake in every non-Mercator projection); globe →
 *  WGS84 ELLIPSOID ECEF (must match the ellipsoid the VS rebuilds vertices on, not
 *  getECEFCenter()'s sphere). */
export function rasterFrameCamAnchor(
  camera: Pick<Camera, 'centerX' | 'centerY'>,
  projType: number,
  projCenterLon: number,
  projCenterLat: number,
): readonly [number, number, number] {
  if (projType === 0) return [camera.centerX, camera.centerY, 0]
  if (isGlobeProj(projType)) return rasterGlobeCamAnchor(projCenterLon, projCenterLat)
  // Single authority: the generated CPU projection, byte-mirror of the GPU project.
  const camProj0 = projectCpu(projType, 0, projCenterLat, 0, projCenterLat)
  return [projCenterLon, camProj0[0], camProj0[1]]
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
 *
 *  `sourceMaxzoom` is the DATASET's deepest level, and clamping to it is what stops the
 *  selector asking for tiles that cannot exist. The AWS terrarium bucket stops at z15,
 *  and the +1 bias above means a 256-px source outruns it from about camera z14.5 — so
 *  every visible tile 404s (verified against a reported failure:
 *  `terrarium/16/13651/25075` → 404, its z15 parent `15/6825/12537` → 200, 101 KB).
 *  Clamping instead keeps requesting the deepest REAL level and lets it draw magnified,
 *  which is exactly MapLibre's Transform#coveringZoomLevel behaviour. The #1405 backoff
 *  then goes back to being a safety net for genuinely-missing tiles rather than the only
 *  defence against a storm the selector created.
 *  (exported for the zoom-selection unit gate — raster-cover-zoom.test.ts) */
export function rasterCoverZoom(zoom: number, tileSize: number, sourceMaxzoom?: number): number {
  const bias = Math.log2(512 / tileSize)
  const cap = sourceMaxzoom === undefined ? 18 : Math.min(18, sourceMaxzoom)
  return Math.max(0, Math.min(cap, Math.round(zoom + bias)))
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

/** Pack the raster global uniform — the SINGLE authority shared by render() and the
 *  forced-WebGL2 checker (renderRhiChecker). The checker's old literal-offset packer carried
 *  raster_params.w = 8 where render() wrote 0 — a dead lane (the shader reads only
 *  raster_params.x), retired by this unification. Completeness is compile-time (#600 globe_eye
 *  class does not compile if omitted); globe_eye is all-zero off the globe (frame.eye
 *  undefined), matching both old packers. camAnchor: 2D Mercator centre in .xy on the flat path
 *  (ECEF lanes dead there); the WGS84 ELLIPSOID anchor (rasterGlobeCamAnchor) on globe/3D.
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
  const trig = rasterGridTrig(west, east, mercSouth, mercDiff, gridN)
  block.write({
    bounds: [west, south, east, north],
    tile_ecef_center: [tileEcef[0], tileEcef[1], tileEcef[2], tileOpacity],
    merc_y: [mercSouth, mercDiff],
    grid: [gridN, capSign],
    row_trig: trig.rows,
    col_trig: trig.cols,
  })
}

// ── #1053 — raster globe pole caps ──
// The Web-Mercator raster surface saturates at ±85.0511°, so the topmost (y=0) and bottommost
// (y=2^z−1) tile rows abut an open polar hole. On the GLOBE only (isGlobeProj → projType 7, the
// sole ECEF surface arm; every flat/Mercator projection is a plane with no geographic pole),
// those rows get an extra cap "tile" that fans their band edge to the pole. Cheap pure
// predicates, zero allocation — the render loop calls them per tile.
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

interface CachedTile extends EvictableTile {
  /** Bind group referencing this tile's texture view. Immutable after load —
   *  cached here so the hot render loop doesn't build one per tile per frame. */
  globalBG?: GPUBindGroup
}

const MAX_CACHED_TILES = 256
const MAX_CONCURRENT_LOADS = 6

export class RasterRenderer {
  /** The injected backend RHI device (ctx.rhi) — the RasterDraper routes resource
   *  creation through it (WebGpuDevice on WebGPU, WebGl2Device under ?forcegl2=1). */
  private readonly rhi: RhiDevice
  private format: GPUTextureFormat = 'bgra8unorm'

  // LRU tile cache
  private tileCache = new Map<string, CachedTile>()
  /** Running sum of `tileCache`'s texture bytes (#1352) — `_cacheTile` and
   *  `evictTiles` are the only writers, so it cannot drift. */
  private _cachedBytes = 0
  private loadingTiles = new InflightLedger()
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
  /** The target-tile keys drawn last frame. A tile that ENTERS this set (first
   *  appearance OR re-entry — e.g. zooming back out to a parent shown before)
   *  re-arms its fade ramp, so a zoom-out cross-fades in instead of snapping to
   *  full opacity. Updated every render(); a continuing tile keeps its ramp. */
  private _lastTargetKeys = new Set<string>()
  /** Tiles whose load resolved null, with the backoff state that stops them being
   *  re-requested every frame (policy in tile-retry.ts). Cleared when the source is
   *  re-armed — a new URL template is a new coverage. Same wiring as the hillshade arm. */
  readonly failedTiles = new FailedTileLedger()
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

  // ── Analytic checker (US-003, ?debug=checker); draper shared since #1046 Inc-F2d.
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
    this.rhi = ctx.rhi
    this.format = ctx.format

    // The raster draw goes through the RHI Material seam (RasterDraper, lazily built in
    // ensureRasterDraper): it owns the pipelines (non-pick + pick MRT), bind-group layouts,
    // the linear/nearest samplers, the global uniform + the per-tile pool. The renderer keeps
    // only its tile cache + the per-frame paint params (_opacity/_nearest/…).
  }

  /** A quality flip RELEASES the raster draper (#1578) and drops it; next render rebuilds. */
  rebuildForQuality(): void {
    this._rasterDraper?.destroy()
    this._rasterDraper = undefined
  }

  /** The source's row origin (#1985) — `'tms'` numbers tile rows from the BOTTOM, so
   *  `tileUrl` substitutes `2^z − 1 − y` for `{y}`. It rides `setUrlTemplate` rather than
   *  a setter of its own because it is a property OF the template: re-arming a different
   *  source without a scheme MUST clear it, and a separate setter could leave a stale flip
   *  on the new URL. Undefined = `'xyz'`, the pre-existing behaviour. */
  private _scheme: TileRowScheme | undefined
  /** The template the cached tiles were fetched from (#2384 F-4). Distinct
   *  from `urlTemplate`, which round-trips through '' on every rebuild. */
  private _cachedTemplate = ''
  setUrlTemplate(url: string, scheme?: TileRowScheme): void {
    // #2384 F-4 — a different template is a different SOURCE, and the key is
    // `z/x/y` with no url, so its tiles answered for the new one; visible tiles
    // are eviction-exempt, so it never self-healed. Aborting is the other half:
    // an old-url read resolving after this would land under the new key.
    if (url !== this.urlTemplate) this.failedTiles.clearAll()
    // The flush is keyed on the template the CACHE belongs to, not on
    // `urlTemplate`: `rebuildLayers()` resets every raster renderer with
    // `setUrlTemplate('')` before re-arming the live one (map.ts:3485), so a
    // plain `url !== this.urlTemplate` would destroy every visible tile on each
    // projection change or layer rebuild — a correctness fix paid for with a
    // full re-download. Empty is that reset, never a source, so it drops nothing.
    if (url !== '' && url !== this._cachedTemplate) {
      abortLoadingTiles(this.loadingTiles)
      this._cachedBytes = dropAllTiles(this.tileCache, this.rhi, this._rasterDraper)
      this._cachedTemplate = url
    }
    this.urlTemplate = url
    this._scheme = scheme
  }

  /** Set the source's tile size in px (256 | 512). Values other than 256/512
   *  keep the current setting — same validation the hillshade arm uses. */
  /** Source-level `maxzoom` — the dataset's deepest real tile level, clamping the cover
   *  zoom so the selector never asks for a tile that cannot exist. Undefined = unbounded
   *  (the pre-existing behaviour for a source that does not declare one). */
  private _sourceMaxzoom: number | undefined
  setSourceMaxzoom(maxzoom: number | undefined): void {
    this._sourceMaxzoom =
      typeof maxzoom === 'number' && Number.isFinite(maxzoom) ? maxzoom : undefined
  }

  /** Source-level `bounds` — the dataset's spatial extent (#1984). Outside it the source
   *  HAS no data, so `render()` drops those tiles before requesting. `normalizeSourceBounds`
   *  re-validates, so an unusable box means "no clip", never a blanked source. */
  private _sourceBounds: SourceBounds | undefined
  setSourceBounds(bounds: [number, number, number, number] | undefined): void {
    this._sourceBounds = normalizeSourceBounds(bounds)
  }

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
  /** True once a raster source's URL template is configured (#834 M5 slice 2 — the
   *  forced-WebGL2 frame draws real tiles instead of the analytic checker when one exists). */
  hasSource(): boolean {
    return this.urlTemplate !== ''
  }

  hasPendingLoads(): boolean {
    return this.loadingTiles.liveCount() > 0
  }

  /** Count of raster tiles currently mid-fetch, DEADLINE-BOUNDED (#2149 — a hung fetch
   *  stops counting past RASTER_INFLIGHT_KEEP_WARM_MS). Feeds `getMissingTileCount()`
   *  and the pending-work registry's `raster-fetch` kind. */
  pendingLoadCount(): number {
    return this.loadingTiles.liveCount()
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
    // The SAME draper the live raster path uses, so the pipeline is derived from
    // the target rather than assumed. It baked ('rgba8unorm', 1) — inert on the
    // WebGL2 twin, a validation error on a WebGPU frame (bgra8unorm, MSAA 4),
    // and why the chain port first reached for a device fork (Inc-F2d review F3).
    const draper = this.ensureRasterDraper()
    const checker = this.ensureRhiChecker(rhi)
    const frame = camera.getViewForProjection(projType, w, h, dpr)

    // Global uniform through the SAME packer + anchor authority render() uses
    // (#733 P2b — the old literal-offset copy here carried raster_params.w = 8, a
    // dead lane the shader never reads; now uniformly 0). frameCamAnchor packs
    // the per-arm DSFUN anchor so the checker draws correctly under any
    // projection override, not just Mercator.
    const B = rasterBlock()
    writeRasterFrameUniform(
      B,
      frame,
      projType,
      projCenterLon,
      projCenterLat,
      rasterFrameCamAnchor(camera, projType, projCenterLon, projCenterLat),
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

    const tiles = [{ texture: checker, tileBytes: new Float32Array(TB.buffer.slice(0)), gridN }]
    draper.draw(pass, B.buffer, tiles, false, pickTargetsEnabled(this.rhi.caps))
  }

  /** Tile load, through the RHI on BOTH backends (#1579 — WebGPU used to bypass the RHI
   *  entirely via the raw-device `loadImageTexture`, which allocates ONE mip level;
   *  #1436's crawl fix was landed on the WebGL2 arm only, so the far-field minification
   *  fix it exists for was still live for the default backend, and every render gate CI
   *  runs is WebGL2 — the fork was invisible to the gate built to catch exactly this.
   *  `rhi.createTexture` / `copyExternalImage` / `generateMipmaps` are generic over both
   *  backends by construction, so unifying costs nothing and removes a fork that could
   *  only drift again. */
  private async loadTileTexture(url: string, signal: AbortSignal): Promise<LoadedTexture | null> {
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
        // #1436 — a full chain. A basemap tile is the minified-appearance texture par excellence:
        // on a pitched globe the far field IS most of the frame, and there a single-level
        // bilinear tap averages 4 texels out of the many the pixel covers, picking a different 4
        // next frame. That is the crawl.
        mipLevelCount: mipLevelCountFor(bitmap.width, bitmap.height),
        label: 'raster-tile',
      })
      this.rhi.copyExternalImage(tex, bitmap, bitmap.width, bitmap.height)
      // AFTER the base has content — a chain generated from an empty base is empty.
      this.rhi.generateMipmaps(tex)
    } catch {
      bitmap.close()
      if (tex) this.rhi.destroyTexture(tex)
      return null
    }
    const bytes = textureBytesOf(bitmap.width, bitmap.height, true)
    bitmap.close()
    return { texture: tex, bytes }
  }

  render(
    pass: RhiRenderPass,
    camera: Camera,
    projType: number,
    projCenterLon: number,
    projCenterLat: number,
    canvasWidth: number,
    canvasHeight: number,
    /** Wall-clock ms (host `_elapsedMs`) — the tile fade ramp's clock (#1477: was frames). */
    nowMs: number,
    /** Backing-buffer:CSS pixel ratio. Forwarded to the tile selector
     *  so a DPR=3 phone doesn't load 9× more raster tiles than DPR=1. */
    dpr: number = 1,
  ): void {
    if (!this.urlTemplate) return
    // Overdraw-debug v1: raster renderer has no debug pipeline yet, so
    // its contribution would mismatch the r16float accumulator format.
    // Skip entirely — raster tiles produce uniform 1× overdraw which
    // the heatmap can do without for now.
    if (isOverdrawActive(this.rhi.caps)) return
    this.frameCount++

    const frame = camera.getViewForProjection(projType, canvasWidth, canvasHeight, dpr)
    const { zoom } = camera

    const currentZ = rasterCoverZoom(zoom, this._tileSize, this._sourceMaxzoom)

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
    const centerLat = frameCenterLatOf(camera, projType) // #2315/#2500 — sphere family reads centerLatDeg
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
    // Spatial clip (#1984). Applied to the SELECTION, so the drop reaches every consumer
    // below at once — the leaf request loop, the parent-fallback prefetch, the eviction
    // protection set and the draw list. A no-op (same array) without declared bounds.
    tiles = clipTilesToBounds(tiles, this._sourceBounds)

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
      // A failed load leaves the key in neither map, so without this guard the next
      // frame re-requests it — forever, at ~60 fps, pinning every concurrency slot
      // with requests that can never succeed (tile-retry.ts explains the shape).
      if (!this.failedTiles.requestable(key)) continue
      if (this.loadingTiles.size >= MAX_CONCURRENT_LOADS) break // respect concurrency limit

      const ctrl = new AbortController()
      this.loadingTiles.set(key, ctrl)
      const url = tileUrl(this.urlTemplate, coord, this._scheme)

      this.loadTileTexture(url, ctrl.signal)
        // #1153 P2 R4 — narrow the release to the LOAD promise: an expected load failure (bitmap
        // fetch reject, or createTexture throw on a lost context) resolves to null so the .then
        // ALWAYS frees the loadingTiles slot (else the key wedges, pinning all MAX_CONCURRENT slots
        // → raster stalls). Scoped here so a throw from the .then bookkeeping still surfaces —
        // through the terminal handler below, not as an unhandled rejection (#1565: this leaf chain
        // floated while its parent-fallback sibling 50 lines down already terminated; two siblings,
        // two error channels, and no rule enforcing either until now).
        .catch(() => null)
        .then((texture) => {
          this.loadingTiles.delete(key)
          if (!texture) {
            this.failedTiles.noteOutcome(key, ctrl.signal.aborted)
            return
          }
          this.failedTiles.clear(key)
          this._cacheTile(key, texture)
          this.evictTiles(visibleKeys)
        })
        .catch((e) => console.error('[X-GIS] raster tile post-load bookkeeping failed', e))
    }

    // Write global uniforms through the typed block (#733 P2b — the single authority shared with
    // the forced-WebGL2 checker). proj_params.w = log_depth_fc so the raster grid shader can
    // apply/read the log-depth transform uniformly with the vector pipelines. The DSFUN camera
    // anchor is packed per projType arm by frameCamAnchor (see there + raster.ts cam_ecef_center).
    const camAnchor = rasterFrameCamAnchor(camera, projType, projCenterLon, projCenterLat)
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
        if (!this.failedTiles.requestable(parentKey)) continue
        if (this.loadingTiles.size >= MAX_CONCURRENT_LOADS) break
        const ctrl = new AbortController()
        this.loadingTiles.set(parentKey, ctrl)
        const parentCoord = { z: parentZ, x: parentX, y: parentY, ox: parentX }
        this.loadTileTexture(tileUrl(this.urlTemplate, parentCoord, this._scheme), ctrl.signal)
          // #1153 P2 R4 — same un-wedge backstop for the parent-fallback chain, with
          // the catch scoped to the LOAD promise so a .then-body throw still surfaces.
          .catch(() => null)
          .then((texture) => {
            this.loadingTiles.delete(parentKey)
            if (!texture) {
              this.failedTiles.noteOutcome(parentKey, ctrl.signal.aborted)
              return
            }
            this.failedTiles.clear(parentKey)
            this._cacheTile(parentKey, texture)
          })
          .catch((e) => console.error('[X-GIS] raster parent-tile post-load bookkeeping failed', e))
      }
    }

    // World-copy fan-out is the SELECTOR's job (ADR-0006: one copy-set per pipeline).
    // `visibleTilesFrustum` enumerates the visible copies for the cylindrical family
    // (worldCopiesFor → WORLD_COPIES) and bakes each copy's offset into the tile's `ox` — so the
    // bounds derived from `ox` below (`west = ox/rn*360 - 180`) already sit in their own world
    // copy. Re-looping `camera.getVisibleWorldCopies()` here shifted those already-placed bounds
    // AGAIN by wo*360, drawing every selected tile at every (ox + wo) position: the same logical
    // world tile rasterised multiple times at the same screen location (raster-opacity<1 then
    // COMPOUNDED the alpha; opacity=1 was wasted over-draw). The VTR vector path reads the selector
    // ox ONCE (tile-selection-cache worldOffDeg) and draws each tile once — mirror that
    // single-source pattern here. Globe / ECEF (projType ≥ 0.5) and the cylindrical non-Mercator
    // flat set (1/2/6, routed through the mercator-named selector shim) were already collapsed to
    // [0] and stay unchanged.
    const RASTER_WORLD_COPIES = [0]
    // Per-frame draw dedup, keyed by the RENDER coord + world copy (ox). Parent fallback maps every
    // uncached child onto the same parent at the parent's FULL bounds — without this, four missing
    // z+1 children draw the identical parent quad four times at one world position (wasted fill;
    // with raster-opacity < 1 the alpha COMPOUNDS, the same defect class the world-copy
    // single-source fix removed for ox×wo).
    const drawnKeys = new Set<string>()
    // Per-tile fade-in: a freshly-appeared tile ramps opacity 0→1 over `fadeMs` — the WALL CLOCK,
    // not a frame count (#1477 fixed a ramp that ran 2× long at 30fps) — cross-fading over its
    // cached parent (drawn beneath). Measured from the tile's FIRST DRAW (firstShownMs, lazily
    // stamped below), so a tile pre-loaded off-screen still fades when first shown. fadeMs 0
    // (rasterFadeDuration 0 / reduced-motion) ⇒ instant full.
    const fadeMs = this._fadeDurationMs
    let anyFading = false

    // Emit one cached tile at `renderCoord` (bounds from the coord) with the supplied texture +
    // per-tile opacity, in every visible world copy plus its globe pole caps. Honours the per-frame
    // `drawnKeys` dedup so a parent shared by several children draws once. Extracted from the
    // inline loop so the fade path can emit BOTH a parent (opacity 1, beneath) and its fading child
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

    // The cached DIRECT children (one zoom level down) covering `coord`. On a zoom-OUT the
    // just-departed higher-detail tiles are still cached; drawing them beneath a fading-in parent
    // retains their detail until the parent is opaque, so the parent cross-fades in over them
    // instead of popping them out. On a zoom-IN the target's children aren't loaded yet, so this is
    // empty (no-op) and the parent-underlay above handles the fill.
    const findCachedChildren = (coord: {
      z: number
      x: number
      y: number
      ox?: number
    }): { renderCoord: { z: number; x: number; y: number; ox: number }; entry: CachedTile }[] => {
      const out: {
        renderCoord: { z: number; x: number; y: number; ox: number }
        entry: CachedTile
      }[] = []
      const cz = coord.z + 1
      const cx0 = coord.x << 1
      const cy0 = coord.y << 1
      const cox0 = (coord.ox ?? coord.x) << 1
      for (let dx = 0; dx <= 1; dx++)
        for (let dy = 0; dy <= 1; dy++) {
          const entry = this.tileCache.get(`${cz}/${cx0 + dx}/${cy0 + dy}`)
          if (entry)
            out.push({
              renderCoord: { z: cz, x: cx0 + dx, y: cy0 + dy, ox: cox0 + dx },
              entry,
            })
        }
      return out
    }

    // Render tiles: exact tile (with its fade-in + cross-fade underlay beneath),
    // else the already-shown parent fallback at full opacity.
    const curTargetKeys = new Set<string>()
    for (const coord of tiles) {
      const key = `${coord.z}/${coord.x}/${coord.y}`
      curTargetKeys.add(key)
      const exact = this.tileCache.get(key)
      if (exact) {
        // Re-arm the ramp when the tile ENTERS the target set — first appearance
        // (firstShownMs -1 from load) OR re-entry, e.g. zooming back out to a
        // parent shown before. A tile continuing across frames keeps its ramp, so
        // it doesn't re-fade every frame; a re-entering one fades in instead of
        // snapping to full opacity (the zoom-out pop).
        if (exact.firstShownMs < 0 || !this._lastTargetKeys.has(key)) exact.firstShownMs = nowMs
        const fadeAlpha = fadeMs > 0 ? Math.min(1, (nowMs - exact.firstShownMs) / fadeMs) : 1
        if (fadeAlpha < 1) {
          anyFading = true
          // Underlay beneath the fading tile so detail is retained until it is opaque (all pushed
          // BEFORE the fading tile = under it). The coarse cached ancestor FIRST (zoom-IN fill /
          // background-gap safety — the gap the reverted vector-tile fade hit), THEN any cached
          // direct children (zoom-OUT: the just-departed higher-detail tiles) so a zoom-out
          // cross-fades sharp→native instead of popping the children out. dedup (drawnKeys)
          // collapses a shared underlay tile to one draw. Marking each lastUsedFrame keeps it alive
          // across the ramp so the LRU can't evict it mid-fade.
          const parent = findCachedParent(coord)
          if (parent) {
            emitTileAt(parent.renderCoord, parent.entry.texture, 1)
            parent.entry.lastUsedFrame = this.frameCount
          }
          for (const child of findCachedChildren(coord)) {
            emitTileAt(child.renderCoord, child.entry.texture, 1)
            child.entry.lastUsedFrame = this.frameCount
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
    this._lastTargetKeys = curTargetKeys
    this._hasFadingTiles = anyFading

    // Issue every collected tile in ONE draper.draw — the sole raster draw path (P1.4),
    // byte-identical to the legacy multi-tile loop. uniformData is the 160B global; the draper
    // owns the per-tile pool + the global/texture/sampler bind group. pick = the opaque-pass MRT.
    // Always called (even with 0 visible tiles) so the global uniform is written every frame —
    // matching the legacy path (it wrote the global before the loop): 0 tiles → global write, no draws.
    // Both frame shapes hand in an RhiRenderPass (Inc-2d) — the old
    // backend-keyed re-wrap was the 34d4695 double-wrap class.
    const pick = pickTargetsEnabled(this.rhi.caps)
    this.ensureRasterDraper().draw(pass, B.buffer, tilesArr, this._nearest, pick)

    // Capture this frame's visible set; deferred eviction runs in the next beginFrame(). Eviction
    // used to run inline here, but destroying tile textures mid-frame trips "Destroyed texture used
    // in submit" because bind groups created earlier in this same render() still reference them at
    // queue.submit() time. Same lifecycle hazard the buffer fix (da4f26f) addressed for
    // VectorTileRenderer.evictGPUTiles().
    this.lastVisibleKeys = visibleKeys
  }

  /** Drop LRU tiles past MAX_CACHED_TILES and destroy their GPU textures.
   *  ONLY called from `beginFrame()` so the previous frame's queue.submit()
   *  has already returned — destroying textures here cannot poison an
   *  in-flight submit. Mirrors VectorTileRenderer.evictGPUTiles(). */
  beginFrame(): void {
    if (overBudget(this.tileCache.size, this._cachedBytes, MAX_CACHED_TILES))
      this.evictTiles(this.lastVisibleKeys)
  }

  /** Drop LRU tiles until back under the count AND byte caps (#1352).
   *  Policy lives in raster-cache-budget so both renderers share one copy. */
  private _cacheTile(k: string, t: LoadedTexture): void {
    this._cachedBytes = admitTile(this.tileCache, k, t, this.frameCount, this._cachedBytes)
  }

  destroy(): void {
    abortLoadingTiles(this.loadingTiles) // #1570 — teardown must CANCEL, not just unschedule
    // #2286 — the draper's ONLY destroy used to be in rebuildForQuality(), so a
    // quality toggle released it and map teardown never did.
    this._rasterDraper?.destroy()
    this._rasterDraper = undefined
  }

  private evictTiles(vis: Set<string>): void {
    const b = this._cachedBytes
    const d = this._rasterDraper
    this._cachedBytes = evictToBudget(this.tileCache, vis, MAX_CACHED_TILES, b, this.rhi, d)
  }
}
