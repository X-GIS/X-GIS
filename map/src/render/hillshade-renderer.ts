// ═══ Hillshade Tile Renderer — raster-dem tiles shaded as relief (#777 Phase II) ═══
//
// Structural mirror of raster-renderer.ts (design §1: a hillshade tile IS a raster tile with a
// DEM-decode → shade fragment). The tile machinery — visible-tile selection, LRU cache, parent
// fallback, WGS84-ellipsoid ECEF anchor, globe pole caps, world-copy handling — is copied verbatim
// from RasterRenderer (the two deliberately stay SEPARATE renderers so the hillshade two-pass
// prepare + terrain displacement upgrade path can diverge without over-coupling raster). What
// differs: • the draw goes through HillshadeDraper (DEM sampled NEAREST); • the global uniform is a
// PAIR — the shared raster 'Uniforms' (vertex + cull, via writeRasterFrameUniform with no-op
// colours) + 'HillshadeUniforms' (lighting + DEM decode + the zoom-independent deriv base,
// writeHillshadeGlobalUniform); • the per-tile pool is the SHARED raster 'TileUniforms'
// (writeRasterTileUniform).

import type { GPUContext } from '@xgis/rhi-webgpu'
import { frameCenterLatOf, type Camera } from '../camera'
import type { TileRowScheme, TileCoord } from '@xgis/data'
import { selectFlatTiles } from './flat-tile-selector'
import { type EvictableTile } from './raster-cache-budget'
import { activeBody } from '@xgis/shared'
import { lonLatToECEF, type ECEF } from '@xgis/shared'
import type { RhiDevice, RhiRenderPass } from '@xgis/engine'
import { HillshadeDraper, type HillshadeTile } from './material/hillshade-material'
import { shaderEmitPending } from '../shaders/emit/shader-emit-pool'
import { routeToSphereSelector, enumerateWorldCopies } from '@xgis/geo'
import { getSampleCount } from '@xgis/engine'
import { globeVisibleTiles } from '@xgis/data'
import { uniformBlock, type UniformBlockOf } from '@xgis/engine'
import {
  rasterGridN,
  rasterU as RASTER_U,
  rasterTileU as RASTER_TILE_U,
} from '../shaders/dsl/raster'
import { hillshadeU as HILLSHADE_U } from '../shaders/dsl/hillshade'
import { FailedTileLedger, leafLoadBudget } from './tile-retry'
import { DemTileStore } from './dem-tile-store'
import { clipTilesToBounds, normalizeSourceBounds, type SourceBounds } from './source-bounds-clip'
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

/** Zoom-INDEPENDENT half of the Sobel derivative scale (design §3 step 2): tileSize / pow(2,
 *  28.2562). The zoom-dependent half — pow(2, zoom − exaggeration_zoom(zoom)) — is a property
 *  of the TILE, not of the frame, so the fragment applies it per tile from the tile's own
 *  Mercator span (`hs_deriv_scale`). A frame-wide scale off the camera zoom mis-shaded every
 *  parent-fallback and every magnified leaf by 2^Δz. */
export function hillshadeDerivBase(tileSize: number): number {
  return tileSize / Math.pow(2, 28.2562)
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
  /** Source-level `maxzoom` — the dataset's deepest real tile level. The cover zoom is clamped
   *  to it, so the selector never asks for a tile that cannot exist. Undefined = unbounded. */
  maxzoom?: number
  /** Source-level `bounds` — the dataset's spatial extent (#1984). The selector drops
   *  every DEM tile that does not overlap it. Undefined = unclipped. */
  bounds?: SourceBounds
}

// Typed uniform blocks (lazy — buildHillshadeModule needs configureProjections()). The vertex
// 'Uniforms' + per-tile 'TileUniforms' are the SHARED raster structs (writeRasterFrameUniform /
// writeRasterTileUniform write them); HillshadeUniforms is the hillshade-only lighting block.
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
    maxzoom?: number
    bounds?: [number, number, number, number]
    scheme?: TileRowScheme
  },
): void {
  // The row origin (#1985) rides the TEMPLATE, not setParams: it is a property of the URL,
  // so re-arming a DEM without one must clear it rather than inherit the previous flip.
  renderer.setUrlTemplate(dem._tileUrl, dem.scheme)
  renderer.setParams({
    // The DATASET's deepest real level. Undefined = unbounded (every source that does
    // not declare it keeps the pre-existing behaviour).
    maxzoom: dem.maxzoom,
    bounds: dem.bounds,
    unpack: demUnpack((dem.encoding as DemEncoding | undefined) ?? 'mapbox', {
      redFactor: dem.redFactor,
      greenFactor: dem.greenFactor,
      blueFactor: dem.blueFactor,
      baseShift: dem.baseShift,
    }),
    tileSize: dem.tileSize ?? 512,
  })
}

/** Pack the HillshadeUniforms (lighting + DEM decode + the zoom-independent deriv
 *  base). SINGLE authority shared by render() + the byte-equality gate. `bearingRad`
 *  is the camera bearing (radians); folded into the azimuth only for anchor=viewport.
 *  Exported for the byte-equality test (hillshade-frame-uniform.test.ts). */
export function writeHillshadeGlobalUniform(
  block: UniformBlockOf<typeof HILLSHADE_U>,
  p: HillshadeParams,
  bearingRad: number,
): void {
  // azimuth = direction_rad + π (design §3 step 4), + camera bearing for the viewport anchor (light
  // stays fixed to screen as the map rotates, design §4). The SAME prefold applies per extra
  // multidirectional source (MapLibre folds the bearing into every u_azimuths[i] before upload).
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
    hs_texel: [texel, hillshadeDerivBase(p.tileSize), 0, 0],
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

type CachedTile = EvictableTile

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
  private readonly rhi: RhiDevice
  private format: GPUTextureFormat = 'bgra8unorm'

  /** DEM residency — the tile cache, both ledgers, the URL template and the whole
   *  fetch path (#2268 / D5 INC-0). The draper is passed as a THUNK, not a
   *  reference: `rebuildForQuality` destroys and replaces it, so a stored one
   *  would leave the store dropping bind groups on a dead object. */
  private readonly dem: DemTileStore
  /** The DEM store's backoff ledger, re-exposed because `pending-work.ts` reads it
   *  off the renderer (`hasPendingRetries`). */
  get failedTiles(): FailedTileLedger {
    return this.dem.failedTiles
  }
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
  // A DEM tile used to POP to full opacity the frame it arrived, so a streaming relief flickered
  // coarse→sharp tile by tile while the raster basemap under it cross-faded smoothly. Same
  // machinery, same paint: the ramp rides the SHARED TileUniforms fade lane (tile_ecef_center.w →
  // VsOut.vis), which vs_tile already interpolates — fs_hillshade just never read it.
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
    // A shader still being emitted off-thread counts as "converging": the draper draws
    // NOTHING until it lands, so a loop that idled on tile-count alone would leave the
    // relief permanently blank with its tiles already cached — the same freeze class as
    // a fade ramp stranded mid-way, which is why it rides the same signal.
    return this._hasFadingTiles || shaderEmitPending()
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
    this.rhi = ctx.rhi
    this.format = ctx.format
    // Built HERE, not as a field initialiser: `rhi` has no initialiser of its own,
    // and field initialisers run before this body — a `new DemTileStore(this.rhi, …)`
    // at the field would capture `undefined` forever. That is the #2165 / coverage-source
    // defect shape exactly, and tsc cannot see it (`rhi` is definitely-assigned here).
    this.dem = new DemTileStore(this.rhi, () => this._hillshadeDraper)
  }

  /** A quality flip RELEASES the draper (#1578) and drops it; the next render() rebuilds. */
  rebuildForQuality(): void {
    this._hillshadeDraper?.destroy()
    this._hillshadeDraper = undefined
  }

  setUrlTemplate(url: string, scheme?: TileRowScheme): void {
    this.dem.setUrlTemplate(url, scheme)
  }

  /** Merge resolved hillshade params over the current set. The DEM decode (unpack / tileSize /
   *  maxzoom) is set once at arm-time (map.ts, from the `_dem` source marker); the paint
   *  (direction / altitude / exaggeration / colours / method) is resolved per-frame by the
   *  HillshadePass. Merging lets the two compose without one clobbering the other. Non-finite
   *  scalars keep the current value (a value can't NaN-poison the shade). */
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
      maxzoom: p.maxzoom ?? cur.maxzoom, // #1983 — without this key the arm's value was dropped
      // #1984 — normalised at this ONE merge chokepoint, so no caller can blank the DEM.
      bounds: p.bounds === undefined ? cur.bounds : normalizeSourceBounds(p.bounds),
    }
  }

  hasSource(): boolean {
    return this.dem.hasSource()
  }

  hasPendingLoads(): boolean {
    return this.dem.hasPendingLoads()
  }

  /** Count of DEM tiles currently mid-fetch, DEADLINE-BOUNDED (#2149 — mirrors the
   *  raster arm through the shared InflightLedger). Feeds `getMissingTileCount()`
   *  and the pending-work registry's `dem-fetch` kind. */
  pendingLoadCount(): number {
    return this.dem.pendingLoadCount()
  }

  render(
    // RhiRenderPass ONLY (#1046 F3b review): both callers supply RHI handles; the old
    // native union hid a backend-keyed re-wrap (double wrap ⇒ undefined). Narrowed.
    pass: RhiRenderPass,
    camera: Camera,
    projType: number,
    projCenterLon: number,
    projCenterLat: number,
    canvasWidth: number,
    canvasHeight: number,
    /** Wall-clock ms (host `_elapsedMs`) — the tile fade ramp's clock (#1477: was frames). */
    nowMs: number,
    dpr: number = 1,
  ): void {
    if (!this.dem.hasSource()) return
    this.dem.nextFrame()

    const frame = camera.getViewForProjection(projType, canvasWidth, canvasHeight, dpr)
    const { zoom } = camera
    // tileSize-aware cover zoom (rasterCoverZoom): a 256-px DEM (terrarium)
    // needs z+1 tiles under the 512-px-tile camera-zoom convention, same as
    // the raster path — one LOD short samples the DEM at half density.
    const currentZ = rasterCoverZoom(zoom, this._params.tileSize, this._params.maxzoom)

    this.dem.abortAboveZoom(currentZ)

    // Tile selection — mirror raster: sphere selector on the globe, flat frustum otherwise.
    const R = activeBody().sphereR
    const centerLon = (camera.centerX / R) * (180 / Math.PI)
    const centerLat = frameCenterLatOf(camera, projType) // #2315/#2500 — sphere family reads centerLatDeg
    const cssW = canvasWidth / dpr
    const cssH = canvasHeight / dpr
    let tiles: TileCoord[]
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
      // Flat projections: cull space == draw space (#2302) — mirror of the raster twin.
      tiles = selectFlatTiles(
        camera,
        projType,
        projCenterLon,
        projCenterLat,
        currentZ,
        canvasWidth,
        canvasHeight,
        dpr,
      )
    }
    // Spatial clip (#1984) — applied to the SELECTION, so the leaf loop, the parent-fallback
    // prefetch, the eviction set and the draw list all see it. Mirror of the raster twin.
    tiles = clipTilesToBounds(tiles, this._params.bounds)

    tiles.sort((a, b) => (a.z !== b.z ? a.z - b.z : 0))
    const visibleKeys = new Set(tiles.map((c) => `${c.z}/${c.x}/${c.y}`))

    // Load missing tiles (leaf-first so near tiles win the concurrency budget) — except
    // on a cold start, where leafLoadBudget holds two slots back so the parent-fallback
    // prefetch below can put a coarse tile on screen first (tile-retry.ts).
    const leafBudget = leafLoadBudget(MAX_CONCURRENT_LOADS, this.dem.size)
    const loadOrder = [...tiles].sort((a, b) => b.z - a.z)
    for (const coord of loadOrder) {
      // The budget test moved to the loop TOP. Equivalent by construction: the
      // original tested it after the cache/backoff skips, so it could only ever
      // break on the first tile that would otherwise have been requested — and
      // the skipped iterations issue nothing and mutate nothing. Same requests,
      // same ledger state, one less pass over already-resident keys.
      if (this.dem.atBudget(leafBudget)) break
      // Passing `visibleKeys` is what selects the LEAF behaviour: evict right
      // after admitting. The parent-fallback call below omits it, so a prefetch
      // can never evict a tile this frame is about to draw.
      this.dem.request(`${coord.z}/${coord.x}/${coord.y}`, coord, leafBudget, visibleKeys)
    }

    // Parent-fallback prefetch (1–2 levels up) — mirror raster.
    for (const coord of tiles) {
      for (let pz = 1; pz <= 2; pz++) {
        const parentZ = coord.z - pz
        if (parentZ < 0) break
        if (this.dem.atBudget(MAX_CONCURRENT_LOADS)) break
        const px = coord.x >> pz
        const py = coord.y >> pz
        this.dem.request(
          `${parentZ}/${px}/${py}`,
          { z: parentZ, x: px, y: py, ox: px },
          MAX_CONCURRENT_LOADS,
          undefined,
          'hillshade parent-tile',
        )
      }
    }

    // Global uniforms: the shared raster 'Uniforms' (vertex + cull, no-op colours) + the hillshade
    // lighting/decode 'HillshadeUniforms'. The DSFUN camera anchor is the SHARED per-arm authority
    // (rasterFrameCamAnchor) — hillshade drives the same vs_tile, so its lanes MUST match raster's
    // (Mercator 2D centre / flat non-Mercator clon+camProj0 / globe ECEF); a mismatch would shake
    // or misplace the DEM sheet in every non-Mercator projection exactly as the basemap did.
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
    writeHillshadeGlobalUniform(HB, this._params, (camera.bearing ?? 0) * DEG2RAD)

    const tilesArr: HillshadeTile[] = []
    const RASTER_WORLD_COPIES = [0]
    // Per-frame draw dedup keyed by render coord + ox — parent fallback maps
    // every uncached child onto the same parent quad (see raster-renderer).
    const drawnKeys = new Set<string>()
    // fadeMs — the WALL CLOCK (#1477, mirrors raster-renderer.ts). 0 ⇒ instant
    // full opacity, byte-identical to the pre-fade path (reduced motion / off).
    const fadeMs = this._fadeDurationMs
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
        const entry = this.dem.get(`${parentZ}/${px}/${py}`)
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
          const entry = this.dem.get(`${cz}/${cx0 + dx}/${cy0 + dy}`)
          if (entry) fn({ z: cz, x: cx0 + dx, y: cy0 + dy, ox: cox0 + dx }, entry)
        }
    }

    // Exact tile (with its fade-in + cross-fade underlay beneath), else the cached
    // parent fallback at full opacity.
    const curTargetKeys = new Set<string>()
    for (const coord of tiles) {
      const key = `${coord.z}/${coord.x}/${coord.y}`
      curTargetKeys.add(key)
      const exact = this.dem.get(key)
      if (exact) {
        // Re-arm the ramp when the tile ENTERS the target set — first appearance
        // (firstShownMs -1 from load) OR re-entry (zooming back out to a parent
        // shown before). A tile continuing across frames keeps its ramp.
        if (exact.firstShownMs < 0 || !this._lastTargetKeys.has(key)) exact.firstShownMs = nowMs
        const fadeAlpha = fadeMs > 0 ? Math.min(1, (nowMs - exact.firstShownMs) / fadeMs) : 1
        if (fadeAlpha < 1) {
          anyFading = true
          // Underlay pushed BEFORE the fading tile = drawn under it. Coarse ancestor first (zoom-IN
          // fill), then cached direct children (zoom-OUT retention). Marking lastUsedFrame keeps
          // them alive across the ramp so the LRU can't evict an underlay mid-fade.
          //
          // The underlay fades OUT (1 − fadeAlpha) where raster holds its at 1 — forced by
          // hillshade's TRANSLUCENT output (flat terrain is transparent): an underlay at 1 shows
          // THROUGH the tile above and is still contributing when the ramp ends, so dropping it at
          // fadeAlpha = 1 snaps the relief lighter. Raster's opaque tiles hide theirs by then.
          // Settled frame is unchanged either way (the underlay contributes nothing at 1).
          const underlay = 1 - fadeAlpha
          const parent = findCachedParent(coord)
          if (parent) {
            emitTileAt(parent.renderCoord, parent.entry.texture, underlay)
            parent.entry.lastUsedFrame = this.dem.frameCount
          }
          eachCachedChild(coord, (rc, entry) => {
            emitTileAt(rc, entry.texture, underlay)
            entry.lastUsedFrame = this.dem.frameCount
          })
        }
        emitTileAt(coord, exact.texture, fadeAlpha)
        exact.lastUsedFrame = this.dem.frameCount
      } else {
        const parent = findCachedParent(coord)
        if (parent) {
          emitTileAt(parent.renderCoord, parent.entry.texture, 1)
          parent.entry.lastUsedFrame = this.dem.frameCount
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
      false, // #2314 — the pass opens ONE colour attachment (see the parity gate)
      // The method is a per-LAYER constant, so it selects a SPECIALISED pipeline
      // rather than branching per fragment (see buildHillshadeModule).
      hillshadeMethodFlag(this._params.method),
    )

    this.dem.noteVisible(visibleKeys)
  }

  /** Deferred eviction, delegated: the previous frame's queue.submit() has
   *  returned by now, so destroying textures cannot poison a submit. */
  beginFrame(): void {
    this.dem.beginFrame()
  }

  destroy(): void {
    // The store owns the cache and the in-flight aborts (#1570); the DRAPER is this
    // renderer's, so its teardown stays here — the store only borrows it via a thunk.
    this.dem.destroy()
    // #2286 — raster twin: the draper was released by the quality rebuild only.
    this._hillshadeDraper?.destroy()
    this._hillshadeDraper = undefined
  }
}
