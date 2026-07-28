// ═══ Hillshade Tile Renderer — raster-dem tiles shaded as relief (#777 Phase II) ═══
//
// Structural mirror of raster-renderer.ts (design §1: a hillshade tile IS a raster
// tile with a DEM-decode → shade fragment). The tile machinery — visible-tile
// selection, LRU cache, parent fallback, WGS84-ellipsoid ECEF anchor, globe pole
// caps, world-copy handling — is copied verbatim from RasterRenderer (the two
// deliberately stay SEPARATE renderers so the hillshade two-pass prepare + terrain
// displacement upgrade path can diverge without over-coupling raster). What differs:
//   • the draw goes through HillshadeDraper (DEM sampled NEAREST);
//   • the global uniform is a PAIR — the shared raster 'Uniforms' (vertex + cull,
//     via writeRasterFrameUniform with no-op colours) + 'HillshadeUniforms'
//     (lighting + DEM decode + per-frame deriv scale, writeHillshadeGlobalUniform);
//   • the per-tile pool is the SHARED raster 'TileUniforms' (writeRasterTileUniform).

import type { GPUContext } from '@xgis/rhi-webgpu'
import type { Camera } from '../camera'
import { visibleTilesFrustum, tileUrl, loadImageTexture, loadImageBitmap } from '@xgis/data'
import { mercator as mercatorProj, mercatorYToLat } from '@xgis/geo'
import { activeBody } from '@xgis/shared'
import { lonLatToECEF, type ECEF } from '@xgis/shared'
import type { RhiDevice, RhiRenderPass, RhiTexture } from '@xgis/engine'
import { HillshadeDraper, type HillshadeTile } from './material/hillshade-material'
import { routeToSphereSelector, enumerateWorldCopies } from '@xgis/geo'
import { isPickEnabled, getSampleCount } from '@xgis/engine'
import { globeVisibleTiles } from '@xgis/data'
import { uniformBlock, type UniformBlockOf } from '@xgis/engine'
import {
  rasterGridN,
  rasterU as RASTER_U,
  rasterTileU as RASTER_TILE_U,
} from '../shaders/dsl/raster'
import { hillshadeU as HILLSHADE_U } from '../shaders/dsl/hillshade'
import {
  writeRasterFrameUniform,
  writeRasterTileUniform,
  rasterFrameCamAnchor,
  rasterCoverZoom,
  needsNorthPoleCap,
  needsSouthPoleCap,
} from './raster-renderer'

const DEG2RAD = Math.PI / 180

// ── DEM elevation-pack unpack factors (design §2) ──
// elevation_m = R*redFactor + G*greenFactor + B*blueFactor − baseShift (R/G/B 0..255).
export type DemEncoding = 'mapbox' | 'terrarium' | 'custom'
export interface DemUnpack {
  redFactor: number
  greenFactor: number
  blueFactor: number
  baseShift: number
}
const MAPBOX_UNPACK: DemUnpack = {
  redFactor: 6553.6,
  greenFactor: 25.6,
  blueFactor: 0.1,
  baseShift: 10000,
}
const TERRARIUM_UNPACK: DemUnpack = {
  redFactor: 256,
  greenFactor: 1,
  blueFactor: 1 / 256,
  baseShift: 32768,
}

/** Resolve the RGBA8 elevation unpack factors for a DEM source. `custom` uses the
 *  source-supplied factors (falling back to the mapbox pack for any missing lane). */
export function demUnpack(encoding: DemEncoding, custom?: Partial<DemUnpack>): DemUnpack {
  if (encoding === 'terrarium') return TERRARIUM_UNPACK
  if (encoding === 'custom')
    return {
      redFactor: custom?.redFactor ?? MAPBOX_UNPACK.redFactor,
      greenFactor: custom?.greenFactor ?? MAPBOX_UNPACK.greenFactor,
      blueFactor: custom?.blueFactor ?? MAPBOX_UNPACK.blueFactor,
      baseShift: custom?.baseShift ?? MAPBOX_UNPACK.baseShift,
    }
  return MAPBOX_UNPACK
}

/** Per-frame Sobel derivative scale (design §3 step 2):
 *  tileSize / pow(2, exaggeration_zoom + 28.2562 − zoom), where the zoom-exaggeration
 *  term is (zoom−15)·k, k = 0.4 (z<2) | 0.35 (z<4.5) | 0.3 (else), clamped to 0 at/above z15.
 *  Per-frame (from the render zoom): exact for the single-LOD steady state, an
 *  approximation for transient parent-fallback / pitched mixed-LOD tiles (the
 *  single-pass MVP carries no per-tile scale). */
export function hillshadeDerivScale(tileSize: number, zoom: number): number {
  const exaggerationZoom = zoom >= 15 ? 0 : (zoom - 15) * (zoom < 2 ? 0.4 : zoom < 4.5 ? 0.35 : 0.3)
  return tileSize / Math.pow(2, exaggerationZoom + 28.2562 - zoom)
}

/** The Mapbox `hillshade-method` → shader method flag. All five MapLibre v5
 *  methods are implemented in fs_hillshade: 0 standard / 1 basic / 2 combined /
 *  3 igor / 4 multidirectional (unknown strings fall back to standard). */
export function hillshadeMethodFlag(method: string): number {
  switch (method) {
    case 'basic':
      return 1
    case 'combined':
      return 2
    case 'igor':
      return 3
    case 'multidirectional':
      return 4
    default:
      return 0
  }
}

/** One extra illumination source (2..4) for method=multidirectional. */
export interface HillshadeExtraSource {
  /** azimuth, deg from N. */
  direction: number
  /** altitude, deg (0–90). */
  altitude: number
  shadow: readonly [number, number, number, number]
  highlight: readonly [number, number, number, number]
}

/** Resolved hillshade paint + DEM decode, packed into HillshadeUniforms each frame. */
export interface HillshadeParams {
  /** light azimuth, deg from N (paint `hillshade-illumination-direction`, default 335). */
  direction: number
  /** light altitude, deg (paint `hillshade-illumination-altitude`, default 45). */
  altitude: number
  /** anchor=map → data-space light (no bearing); false (viewport) adds camera bearing. */
  anchorMap: boolean
  /** vertical-relief multiplier (paint `hillshade-exaggeration`, default 0.5). */
  exaggeration: number
  shadow: readonly [number, number, number, number]
  highlight: readonly [number, number, number, number]
  accent: readonly [number, number, number, number]
  /** 'standard' | 'basic' | 'combined' | 'igor' | 'multidirectional'. */
  method: string
  /** Illumination sources 2..4 (method=multidirectional; empty otherwise —
   *  the uniform budget carries at most 3 extras, truncated at convert time). */
  extraSources: readonly HillshadeExtraSource[]
  unpack: DemUnpack
  /** native DEM tile pixel size (256 / 512). */
  tileSize: number
}

// Typed uniform blocks (lazy — buildHillshadeModule needs configureProjections()).
// The vertex 'Uniforms' + per-tile 'TileUniforms' are the SHARED raster structs
// (writeRasterFrameUniform / writeRasterTileUniform write them); HillshadeUniforms
// is the hillshade-only lighting block.
let _rasterBlock: UniformBlockOf<typeof RASTER_U> | null = null
function rasterBlock(): UniformBlockOf<typeof RASTER_U> {
  return (_rasterBlock ??= uniformBlock(RASTER_U))
}
let _rasterTileBlock: UniformBlockOf<typeof RASTER_TILE_U> | null = null
function rasterTileBlock(): UniformBlockOf<typeof RASTER_TILE_U> {
  return (_rasterTileBlock ??= uniformBlock(RASTER_TILE_U))
}
let _hsBlock: UniformBlockOf<typeof HILLSHADE_U> | null = null
function hsBlock(): UniformBlockOf<typeof HILLSHADE_U> {
  return (_hsBlock ??= uniformBlock(HILLSHADE_U))
}

/** Pack + append one pole-cap "tile" (grid.y = ±1 flips vs_tile to the band-edge→
 *  pole fan). Local mirror of raster-renderer's private pushRasterCap — reuses the
 *  memoised per-tile block (bytes COPIED for the draw item). */
function pushCap(
  out: HillshadeTile[],
  block: UniformBlockOf<typeof RASTER_TILE_U>,
  texture: HillshadeTile['texture'],
  west: number,
  south: number,
  east: number,
  north: number,
  swEcef: readonly [number, number, number] | ECEF,
  mercSouth: number,
  mercDiff: number,
  gridN: number,
  capSign: number,
  tileOpacity: number,
): void {
  // writeRasterTileUniform's tail is (gridN, tileOpacity, capSign) — capSign was
  // being passed POSITIONALLY into tileOpacity, so the cap flag never reached the
  // shader (globe pole caps rendered as ordinary tiles) and the south cap wrote
  // tileOpacity = −1. Pass both, in order, like raster's pushRasterCap.
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

/** Premultiply an RGBA (rgb·a) — the shader output is premultiplied-alpha (design §3). */
function premul(c: readonly [number, number, number, number]): [number, number, number, number] {
  return [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]]
}

/** Arm a HillshadeRenderer from a `raster-dem` `_dem` source marker: the DEM
 *  tile URL + the decode (encoding → unpack factors + tileSize). The per-frame
 *  paint (direction / altitude / colours / …) is resolved separately by the
 *  HillshadePass. Extracted so map.ts's rebuildLayers stays a thin dispatch. */
export function armHillshadeSource(
  renderer: HillshadeRenderer,
  dem: {
    _tileUrl: string
    encoding?: string
    tileSize?: number
    redFactor?: number
    greenFactor?: number
    blueFactor?: number
    baseShift?: number
  },
): void {
  renderer.setUrlTemplate(dem._tileUrl)
  renderer.setParams({
    unpack: demUnpack((dem.encoding as DemEncoding | undefined) ?? 'mapbox', {
      redFactor: dem.redFactor,
      greenFactor: dem.greenFactor,
      blueFactor: dem.blueFactor,
      baseShift: dem.baseShift,
    }),
    tileSize: dem.tileSize ?? 512,
  })
}

/** Pack the HillshadeUniforms (lighting + DEM decode + per-frame deriv scale).
 *  SINGLE authority shared by render() + the byte-equality gate. `bearingRad` is
 *  the camera bearing (radians); folded into the azimuth only for anchor=viewport.
 *  Exported for the byte-equality test (hillshade-frame-uniform.test.ts). */
export function writeHillshadeGlobalUniform(
  block: UniformBlockOf<typeof HILLSHADE_U>,
  p: HillshadeParams,
  zoom: number,
  bearingRad: number,
): void {
  // azimuth = direction_rad + π (design §3 step 4), + camera bearing for the
  // viewport anchor (light stays fixed to screen as the map rotates, design §4).
  // The SAME prefold applies per extra multidirectional source (MapLibre folds
  // the bearing into every u_azimuths[i] before upload).
  const azimuthOf = (directionDeg: number): number =>
    directionDeg * DEG2RAD + Math.PI + (p.anchorMap ? 0 : bearingRad)
  const texel = 1 / p.tileSize
  // Sources 2..4 (multidirectional). Unused lanes zero-fill; the shader gates
  // them off via the count in hs_light2.z (1..4).
  const ex = (i: number): HillshadeExtraSource | undefined => p.extraSources[i]
  const count = Math.min(4, 1 + p.extraSources.length)
  const lightOf = (
    s: HillshadeExtraSource | undefined,
    z: number,
  ): [number, number, number, number] =>
    s ? [azimuthOf(s.direction), s.altitude * DEG2RAD, z, 0] : [0, 0, z, 0]
  const ZERO4: readonly [number, number, number, number] = [0, 0, 0, 0]
  block.write({
    hs_unpack: [p.unpack.redFactor, p.unpack.greenFactor, p.unpack.blueFactor, p.unpack.baseShift],
    hs_light: [
      azimuthOf(p.direction),
      p.altitude * DEG2RAD,
      p.exaggeration,
      hillshadeMethodFlag(p.method),
    ],
    hs_shadow: premul(p.shadow),
    hs_highlight: premul(p.highlight),
    hs_accent: premul(p.accent),
    hs_texel: [texel, hillshadeDerivScale(p.tileSize, zoom), 0, 0],
    hs_light2: lightOf(ex(0), count),
    hs_light3: lightOf(ex(1), 0),
    hs_light4: lightOf(ex(2), 0),
    hs_shadow2: ex(0) ? premul(ex(0)!.shadow) : ZERO4,
    hs_highlight2: ex(0) ? premul(ex(0)!.highlight) : ZERO4,
    hs_shadow3: ex(1) ? premul(ex(1)!.shadow) : ZERO4,
    hs_highlight3: ex(1) ? premul(ex(1)!.highlight) : ZERO4,
    hs_shadow4: ex(2) ? premul(ex(2)!.shadow) : ZERO4,
    hs_highlight4: ex(2) ? premul(ex(2)!.highlight) : ZERO4,
  })
}

interface CachedTile {
  texture: GPUTexture | RhiTexture
  lastUsedFrame: number
  firstShownFrame: number
}

const MAX_CACHED_TILES = 256
const MAX_CONCURRENT_LOADS = 6

const DEFAULT_PARAMS: HillshadeParams = {
  direction: 335,
  altitude: 45,
  anchorMap: false,
  exaggeration: 0.5,
  shadow: [0, 0, 0, 1],
  highlight: [1, 1, 1, 1],
  accent: [0, 0, 0, 1],
  method: 'standard',
  extraSources: [],
  unpack: MAPBOX_UNPACK,
  tileSize: 512,
}

export class HillshadeRenderer {
  private device: GPUDevice
  private readonly rhi: RhiDevice
  private format: GPUTextureFormat = 'bgra8unorm'

  private tileCache = new Map<string, CachedTile>()
  private loadingTiles = new Map<string, AbortController>()
  private frameCount = 0
  private lastZoom = -1
  private lastVisibleKeys: Set<string> = new Set()

  private urlTemplate = ''
  /** Resolved hillshade paint + DEM decode, set per frame by the orchestrator. */
  private _params: HillshadeParams = { ...DEFAULT_PARAMS }
  /** The drawing layer's opacity paint (0..1); default 1. Applied in the fragment via
   *  the raster-frame uniform's raster_params.x (#777 gap — was hardcoded 1). */
  private _opacity = 1
  /** Set the layer opacity (resolved from the hillshade show's paintShapes.common.opacity
   *  by applyHillshadePaint, shared by the native pass + the WebGL2 twin). */
  setOpacity(o: number): void {
    if (Number.isFinite(o)) this._opacity = Math.max(0, Math.min(1, o))
  }

  // ── Tile fade-in (ported from RasterRenderer) ──
  // A DEM tile used to POP to full opacity the frame it arrived, so a streaming
  // relief flickered coarse→sharp tile by tile while the raster basemap under it
  // cross-faded smoothly. Same machinery, same paint: the ramp rides the SHARED
  // TileUniforms fade lane (tile_ecef_center.w → VsOut.vis), which vs_tile already
  // interpolates — fs_hillshade just never read it.
  /** DEM tile fade-in duration (ms); 0 = instant pop-in (byte-identical to the
   *  pre-fade path), which is what reduced-motion selects. */
  private _fadeDurationMs = 300
  /** True when the LAST render() left any tile mid-fade — the map's keep-alive
   *  reads it so the ramp keeps advancing on a still camera. */
  private _hasFadingTiles = false
  /** The previous frame's target (exact-tile) key set. A tile RE-ENTERING the set
   *  re-arms its ramp, so zooming back out fades in instead of snapping. */
  private _lastTargetKeys: Set<string> = new Set()

  /** Set the DEM tile fade-in duration (ms). 0 disables the fade; the map passes 0
   *  under prefers-reduced-motion (mirror of setRasterFadeDurationMs). */
  setHillshadeFadeDurationMs(ms: number): void {
    if (Number.isFinite(ms)) this._fadeDurationMs = Math.max(0, ms)
  }

  /** True while any DEM tile is mid-cross-fade (render-loop keep-alive). */
  hasFadingTiles(): boolean {
    return this._hasFadingTiles
  }

  private _hillshadeDraper?: HillshadeDraper
  private ensureHillshadeDraper(): HillshadeDraper {
    // Clamp to the device cap (mirrors RasterDraper): a getSampleCount()=4
    // pipeline against caps.maxSampleCount=1 frame targets (SwiftShader /
    // software adapters) validation-fails every draw — silently black relief.
    return (this._hillshadeDraper ??= new HillshadeDraper(
      this.rhi,
      this.format,
      this.rhi.backend === 'webgl2' ? 1 : Math.min(getSampleCount(), this.rhi.caps.maxSampleCount),
    ))
  }

  constructor(ctx: GPUContext) {
    this.device = ctx.device
    this.rhi = ctx.rhi
    this.format = ctx.format
  }

  /** A quality (MSAA / picking) change invalidates the draper so the next render()
   *  lazily rebuilds its pipelines with the new getSampleCount() / isPickEnabled(). */
  rebuildForQuality(): void {
    this._hillshadeDraper = undefined
  }

  setUrlTemplate(url: string): void {
    this.urlTemplate = url
  }

  /** Merge resolved hillshade params over the current set. The DEM decode
   *  (unpack / tileSize) is set once at arm-time (map.ts, from the `_dem`
   *  source marker); the paint (direction / altitude / exaggeration / colours /
   *  method) is resolved per-frame by the HillshadePass. Merging lets the two
   *  compose without one clobbering the other. Non-finite scalars keep the
   *  current value (a value can't NaN-poison the shade). */
  setParams(p: Partial<HillshadeParams>): void {
    const cur = this._params
    const f = (v: number | undefined, d: number) =>
      typeof v === 'number' && Number.isFinite(v) ? v : d
    this._params = {
      direction: f(p.direction, cur.direction),
      altitude:
        p.altitude === undefined
          ? cur.altitude
          : Math.max(0, Math.min(90, f(p.altitude, cur.altitude))),
      anchorMap: p.anchorMap ?? cur.anchorMap,
      exaggeration:
        p.exaggeration === undefined
          ? cur.exaggeration
          : Math.max(0, f(p.exaggeration, cur.exaggeration)),
      shadow: p.shadow ?? cur.shadow,
      highlight: p.highlight ?? cur.highlight,
      accent: p.accent ?? cur.accent,
      method: p.method ?? cur.method,
      extraSources: p.extraSources ?? cur.extraSources,
      unpack: p.unpack ?? cur.unpack,
      tileSize: p.tileSize === 256 || p.tileSize === 512 ? p.tileSize : cur.tileSize,
    }
  }

  hasSource(): boolean {
    return this.urlTemplate !== ''
  }

  hasPendingLoads(): boolean {
    return this.loadingTiles.size > 0
  }

  /** Count of DEM tiles currently mid-fetch (the set `hasPendingLoads`
   *  tests). Feeds the map's per-frame `getMissingTileCount()` so a loading
   *  affordance covers hillshade DEM sources too. */
  pendingLoadCount(): number {
    return this.loadingTiles.size
  }

  /** Backend-appropriate DEM tile load — verbatim raster loadTileTexture (a DEM
   *  is an RGBA8 PNG; the NEAREST decode is a sampler concern, in the draper). */
  private async loadTileTexture(
    url: string,
    signal: AbortSignal,
  ): Promise<GPUTexture | RhiTexture | null> {
    if (this.rhi.backend !== 'webgl2') return loadImageTexture(this.device, url, signal)
    const bitmap = await loadImageBitmap(url, signal)
    if (!bitmap) return null
    // #1153 P2 R4 (ported from raster — hillshade was the pre-fix copy):
    // createTexture throws on a lost context (rhi-webgl2 :963) and
    // copyExternalImage can throw too. Release the decoded bitmap + any
    // half-created texture and normalise to the WebGPU null contract
    // (loadImageTexture returns null on failure) so the caller's loadingTiles key
    // is released rather than wedged; the chains' .catch is the outer backstop.
    let tex: RhiTexture | null = null
    try {
      tex = this.rhi.createTexture({
        width: bitmap.width,
        height: bitmap.height,
        format: 'rgba8unorm',
        usage: ['sample', 'copy-dst'],
        label: 'hillshade-dem-tile',
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
    // RhiRenderPass ONLY (#1046 F3b review): both callers supply RHI handles,
    // and the former native union hid a backend-keyed re-wrap (double wrap ⇒
    // undefined at the native encoder). Narrowed = unrepresentable.
    pass: RhiRenderPass,
    camera: Camera,
    projType: number,
    projCenterLon: number,
    projCenterLat: number,
    canvasWidth: number,
    canvasHeight: number,
    dpr: number = 1,
  ): void {
    if (!this.urlTemplate) return
    this.frameCount++

    const frame = camera.getViewForProjection(projType, canvasWidth, canvasHeight, dpr)
    const { zoom } = camera
    // tileSize-aware cover zoom (rasterCoverZoom): a 256-px DEM (terrarium)
    // needs z+1 tiles under the 512-px-tile camera-zoom convention, same as
    // the raster path — one LOD short samples the DEM at half density.
    const currentZ = rasterCoverZoom(zoom, this._params.tileSize)

    if (currentZ !== this.lastZoom) {
      for (const [key, ctrl] of this.loadingTiles) {
        const tileZ = parseInt(key.split('/')[0])
        if (tileZ > currentZ) {
          ctrl.abort()
          this.loadingTiles.delete(key)
        }
      }
      this.lastZoom = currentZ
    }

    // Tile selection — mirror raster: sphere selector on the globe, flat frustum otherwise.
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
        for (const wc of [-2, -1, 0, 1, 2])
          for (const t of globeTiles)
            tiles.push({ z: t.z, x: t.x, y: t.y, ox: t.x + wc * (1 << t.z) })
      } else {
        tiles = globeTiles.map((t) => ({ z: t.z, x: t.x, y: t.y, ox: t.ox }))
      }
    } else {
      const selectorProj =
        projType === 0
          ? mercatorProj
          : { name: 'non-mercator', forward: mercatorProj.forward, inverse: mercatorProj.inverse }
      tiles = visibleTilesFrustum(camera, selectorProj, currentZ, canvasWidth, canvasHeight, 0, dpr)
    }

    tiles.sort((a, b) => (a.z !== b.z ? a.z - b.z : 0))
    const visibleKeys = new Set(tiles.map((c) => `${c.z}/${c.x}/${c.y}`))

    // Load missing tiles (leaf-first so near tiles win the concurrency budget).
    const loadOrder = [...tiles].sort((a, b) => b.z - a.z)
    for (const coord of loadOrder) {
      const key = `${coord.z}/${coord.x}/${coord.y}`
      if (this.tileCache.has(key) || this.loadingTiles.has(key)) continue
      if (this.loadingTiles.size >= MAX_CONCURRENT_LOADS) break
      const ctrl = new AbortController()
      this.loadingTiles.set(key, ctrl)
      this.loadTileTexture(tileUrl(this.urlTemplate, coord), ctrl.signal)
        // #1153 P2 R4 — narrow the release to the LOAD promise: an expected load
        // failure resolves to null so the .then ALWAYS frees the loadingTiles slot
        // (else the key wedges, pinning all MAX_CONCURRENT slots → the DEM stream
        // stalls). Scoped here so a throw from the .then bookkeeping stays a visible
        // unhandled rejection, not swallowed.
        .catch(() => null)
        .then((texture) => {
          this.loadingTiles.delete(key)
          if (!texture) return
          // firstShownFrame -1 = "never drawn yet"; the draw loop stamps it on the
          // tile's FIRST appearance so an off-screen prefetch still fades in.
          this.tileCache.set(key, {
            texture,
            lastUsedFrame: this.frameCount,
            firstShownFrame: -1,
          })
          this.evictTiles(visibleKeys)
        })
    }

    // Parent-fallback prefetch (1–2 levels up) — mirror raster.
    for (const coord of tiles) {
      for (let pz = 1; pz <= 2; pz++) {
        const parentZ = coord.z - pz
        if (parentZ < 0) break
        const parentKey = `${parentZ}/${coord.x >> pz}/${coord.y >> pz}`
        if (this.tileCache.has(parentKey) || this.loadingTiles.has(parentKey)) continue
        if (this.loadingTiles.size >= MAX_CONCURRENT_LOADS) break
        const ctrl = new AbortController()
        this.loadingTiles.set(parentKey, ctrl)
        this.loadTileTexture(
          tileUrl(this.urlTemplate, {
            z: parentZ,
            x: coord.x >> pz,
            y: coord.y >> pz,
            ox: coord.x >> pz,
          }),
          ctrl.signal,
        )
          // #1153 P2 R4 — same un-wedge backstop for the parent-fallback chain.
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
          .catch((e) =>
            console.error('[X-GIS] hillshade parent-tile post-load bookkeeping failed', e),
          )
      }
    }

    // Global uniforms: the shared raster 'Uniforms' (vertex + cull, no-op colours)
    // + the hillshade lighting/decode 'HillshadeUniforms'. The DSFUN camera anchor
    // is the SHARED per-arm authority (rasterFrameCamAnchor) — hillshade drives the
    // same vs_tile, so its lanes MUST match raster's (Mercator 2D centre / flat
    // non-Mercator clon+camProj0 / globe ECEF); a mismatch would shake or misplace
    // the DEM sheet in every non-Mercator projection exactly as the basemap did.
    const camAnchor = rasterFrameCamAnchor(camera, projType, projCenterLon, projCenterLat)
    const B = rasterBlock()
    writeRasterFrameUniform(B, frame, projType, projCenterLon, projCenterLat, camAnchor, {
      opacity: this._opacity,
      hueRotate: 0,
      brightnessMin: 0,
      brightnessMax: 1,
      saturation: 0,
      contrast: 0,
    })
    const HB = hsBlock()
    writeHillshadeGlobalUniform(HB, this._params, zoom, (camera.bearing ?? 0) * DEG2RAD)

    const tilesArr: HillshadeTile[] = []
    const RASTER_WORLD_COPIES = [0]
    // Per-frame draw dedup keyed by render coord + ox — parent fallback maps
    // every uncached child onto the same parent quad (see raster-renderer).
    const drawnKeys = new Set<string>()
    // ~60 fps → durationMs·0.06 frames. 0 ⇒ instant full opacity, byte-identical
    // to the pre-fade path (reduced motion / fade disabled).
    const fadeFrames = this._fadeDurationMs > 0 ? this._fadeDurationMs * 0.06 : 0
    let anyFading = false

    // Emit one cached tile at `renderCoord` with the supplied texture + per-tile
    // opacity, in every world copy plus its globe pole caps. Extracted (mirror of
    // raster's emitTileAt) so the fade path can emit BOTH an underlay at opacity 1
    // and the fading tile over it for one visible coord.
    const emitTileAt = (
      renderCoord: { z: number; x: number; y: number; ox?: number },
      texture: HillshadeTile['texture'],
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
      const swEcef = lonLatToECEF(west, south)

      const MERC_LIMIT = 85.051129
      const clampMerc = (v: number) => Math.max(-MERC_LIMIT, Math.min(MERC_LIMIT, v))
      const mercSouth = Math.log(Math.tan(Math.PI / 4 + (clampMerc(south) * DEG2RAD) / 2))
      const mercNorth = Math.log(Math.tan(Math.PI / 4 + (clampMerc(north) * DEG2RAD) / 2))
      const mercDiff = mercNorth - mercSouth
      const gridN = rasterGridN(projType, renderCoord.z)

      for (const wo of RASTER_WORLD_COPIES) {
        const TB = rasterTileBlock()
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
        tilesArr.push({
          texture,
          tileBytes: new Float32Array(TB.buffer.slice(0)),
          gridN,
        })
        // prettier-ignore
        if (needsNorthPoleCap(projType, renderCoord.y))
          pushCap(tilesArr, TB, texture, west + wo * 360, south, east + wo * 360, north, swEcef, mercSouth, mercDiff, gridN, 1, tileOpacity)
        // prettier-ignore
        if (needsSouthPoleCap(projType, renderCoord.y, rn))
          pushCap(tilesArr, TB, texture, west + wo * 360, south, east + wo * 360, north, swEcef, mercSouth, mercDiff, gridN, -1, tileOpacity)
      }
    }

    // Nearest cached ancestor (1–4 levels up) — the missing-tile fallback AND the
    // zoom-IN cross-fade underlay.
    const findCachedParent = (coord: { z: number; x: number; y: number; ox?: number }) => {
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

    // Cached DIRECT children — on a zoom-OUT the just-departed higher-detail tiles
    // are still cached; drawing them beneath a fading-in parent retains their detail
    // until it is opaque (cross-fade sharp→coarse instead of a pop). Callback form
    // (not an array) so the hot draw loop allocates nothing per visible tile.
    const eachCachedChild = (
      coord: { z: number; x: number; y: number; ox?: number },
      fn: (rc: { z: number; x: number; y: number; ox: number }, entry: CachedTile) => void,
    ): void => {
      const cz = coord.z + 1
      const cx0 = coord.x << 1
      const cy0 = coord.y << 1
      const cox0 = (coord.ox ?? coord.x) << 1
      for (let dx = 0; dx <= 1; dx++)
        for (let dy = 0; dy <= 1; dy++) {
          const entry = this.tileCache.get(`${cz}/${cx0 + dx}/${cy0 + dy}`)
          if (entry) fn({ z: cz, x: cx0 + dx, y: cy0 + dy, ox: cox0 + dx }, entry)
        }
    }

    // Exact tile (with its fade-in + cross-fade underlay beneath), else the cached
    // parent fallback at full opacity.
    const curTargetKeys = new Set<string>()
    for (const coord of tiles) {
      const key = `${coord.z}/${coord.x}/${coord.y}`
      curTargetKeys.add(key)
      const exact = this.tileCache.get(key)
      if (exact) {
        // Re-arm the ramp when the tile ENTERS the target set — first appearance
        // (firstShownFrame -1 from load) OR re-entry (zooming back out to a parent
        // shown before). A tile continuing across frames keeps its ramp.
        if (exact.firstShownFrame < 0 || !this._lastTargetKeys.has(key))
          exact.firstShownFrame = this.frameCount
        const fadeAlpha =
          fadeFrames > 0 ? Math.min(1, (this.frameCount - exact.firstShownFrame) / fadeFrames) : 1
        if (fadeAlpha < 1) {
          anyFading = true
          // Underlay pushed BEFORE the fading tile = drawn under it. Coarse ancestor
          // first (zoom-IN fill), then cached direct children (zoom-OUT retention).
          // Marking lastUsedFrame keeps them alive across the ramp so the LRU can't
          // evict an underlay mid-fade.
          //
          // The underlay fades OUT (1 − fadeAlpha) where raster holds its at 1 —
          // forced by hillshade's TRANSLUCENT output (flat terrain is transparent):
          // an underlay at 1 shows THROUGH the tile above and is still contributing
          // when the ramp ends, so dropping it at fadeAlpha = 1 snaps the relief
          // lighter. Raster's opaque tiles hide theirs by then. Settled frame is
          // unchanged either way (the underlay contributes nothing at 1).
          const underlay = 1 - fadeAlpha
          const parent = findCachedParent(coord)
          if (parent) {
            emitTileAt(parent.renderCoord, parent.entry.texture, underlay)
            parent.entry.lastUsedFrame = this.frameCount
          }
          eachCachedChild(coord, (rc, entry) => {
            emitTileAt(rc, entry.texture, underlay)
            entry.lastUsedFrame = this.frameCount
          })
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

    this.ensureHillshadeDraper().draw(
      pass,
      B.buffer,
      HB.buffer,
      tilesArr,
      isPickEnabled(),
      // The method is a per-LAYER constant, so it selects a SPECIALISED pipeline
      // rather than branching per fragment (see buildHillshadeModule).
      hillshadeMethodFlag(this._params.method),
    )

    this.lastVisibleKeys = visibleKeys
  }

  /** Deferred eviction — runs from beginFrame() only (the previous frame's
   *  queue.submit() has returned, so destroying textures can't poison a submit). */
  beginFrame(): void {
    if (this.tileCache.size > MAX_CACHED_TILES) this.evictTiles(this.lastVisibleKeys)
  }

  private evictTiles(visibleKeys: Set<string>): void {
    if (this.tileCache.size <= MAX_CACHED_TILES) return
    const entries = [...this.tileCache.entries()]
      .filter(([key]) => !visibleKeys.has(key))
      .sort((a, b) => a[1].lastUsedFrame - b[1].lastUsedFrame)
    const toEvict = this.tileCache.size - MAX_CACHED_TILES
    for (let i = 0; i < toEvict && i < entries.length; i++) {
      const [key, tile] = entries[i]
      if (this.rhi.backend === 'webgl2') this.rhi.destroyTexture(tile.texture as RhiTexture)
      else (tile.texture as GPUTexture).destroy()
      this._hillshadeDraper?.dropTexture(tile.texture)
      this.tileCache.delete(key)
    }
  }
}
