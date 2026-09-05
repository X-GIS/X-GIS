// ═══ Vector Drape Renderer — globe great-circle vector fill drape (#599 I2) ═══
//
// The globe vector FILL bug: VectorTileRenderer projects a tile's own ECEF
// triangle vertices directly through the ECEF-MVP, so a triangle spanning a big
// lon/lat arc cuts a flat CHORD under the curved sphere (visible faceting on
// large polygons at low globe zoom). Raster tiles never had this: they drape
// onto a finely-tessellated sphere grid so every quad hugs the curve.
//
// This renderer REUSES that proven raster sphere drape (raster-material.ts
// RasterDraper — the fine-grid sphere VS + log-depth material) and swaps ONLY
// the sampled texture SOURCE: instead of a fetched raster tile it samples the
// per-tile offscreen vector-fill bake (VectorTileRenderer.bakeTileToTexture, I1
// #990). No new sphere shader; drape fidelity is inherited from the raster path.
//
// SPHERE-SURFACE ROUTE ONLY — the caller (VectorTileRenderer) gates this behind
// bakesVectorDrape ({3,4,5}∪globeMode; oblique(6) is EXCLUDED → renders direct),
// so the flat / Mercator / oblique vector path stays byte-identical.
// OVER-ZOOM ONLY (#2094) — that same caller also gates on drapesAtChordBudget, so a
// tile the source can supply at the camera's own level renders DIRECT: the direct
// arm's chord error is then under the bake's own resample cost. What is left for the
// bake is the tile too coarse for its camera, where the mesh (cached per tile,
// projection- and zoom-independent by design) has no detail to give and only the
// #2024 windowed sub-tiles can supply it.

import type { RhiDevice, RhiTexture, RhiRenderPass } from '@xgis/engine'
import { uniformBlock, isPickEnabled, type UniformBlockOf } from '@xgis/engine'
import { EARTH, lonLatToECEF } from '@xgis/shared'
import { RasterDraper, type RasterTile } from './material/raster-material'
import { planBakeEvictions, drapeZoomBucket, drapeStrokeWidthScale } from './vector-drape-cache'
import { maxCachedEntriesFor } from './raster-cache-budget'
import {
  rasterU as RASTER_U,
  rasterTileU as RASTER_TILE_U,
  rasterGridN,
} from '../shaders/dsl/raster'
import {
  writeRasterFrameUniform,
  writeRasterTileUniform,
  rasterFrameCamAnchor,
} from './raster-renderer'
import type { GPUTile } from './vector-tile-renderer-types'

const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI
const MERC_LIMIT = 85.051129
const clampLat = (v: number): number => Math.max(-MERC_LIMIT, Math.min(MERC_LIMIT, v))
const mercY = (latDeg: number): number =>
  Math.log(Math.tan(Math.PI / 4 + (clampLat(latDeg) * DEG2RAD) / 2))
// #2024 — the bake's tile-local frame is Mercator METRES on the tiler's sphere
// radius (compiler ecef-packing DSFUN_EARTH_R = EARTH.sphereR; the VTR's bake
// ortho spans TWO_PI_R_EARTH/2^z of the same frame). The window math below must
// live on the SAME radius or every windowed bake shifts by the radius ratio.
const SPHERE_R = EARTH.sphereR
const TWO_PI_R = 2 * Math.PI * SPHERE_R
/** North-edge latitude (deg) of Mercator tile row y at 2^z = tileN. */
const tileRowLat = (y: number, tileN: number): number =>
  Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / tileN))) * RAD2DEG
const BAKE_PX = 512
/** Bytes of one bake — RGBA8 at BAKE_PX², every entry the same size. */
const BAKE_BYTES = BAKE_PX * BAKE_PX * 4

/** #2093 — consecutive drape-free frames after which the WHOLE bake cache is
 *  released.
 *
 *  `planBakeEvictions` only trims ABOVE the cap, so a cache that stops being
 *  sampled freezes at its high-water mark — up to `maxCachedEntriesFor(BAKE_BYTES)`
 *  512² RGBA8 textures (384 desktop / 96 mobile, i.e. ~384 / ~96 MiB) held until
 *  `destroy()`. Before the LOD ceiling the globe drape never went permanently
 *  cold; under `GLOBE_DRAPE_CHORD_BUDGET_PX` the direct arm renders every vector
 *  layer, so nothing re-enters the cache and none of it can ever be sampled again.
 *
 *  30 frames (~0.5 s at 60 fps) is the compromise: an ACTIVE drape only ever
 *  produces a drape-free frame transiently (a frame where every visible tile is
 *  mid-reload, so every bake self-skips), and the cost of being wrong is a re-bake
 *  of the VISIBLE set only — the entries dropped were by definition not on screen.
 *  A map that renders no frames at all keeps its cache until it renders again;
 *  that is the deliberate limit of a frame-counted release. */
export const COLD_RELEASE_FRAMES = 30

/** ECEF-frame view the drape projects with — the SAME matrix + log-depth + eye
 *  the vector / raster paths already compute (camera.getViewForProjection), so
 *  the draped fill registers with the raster basemap. */
export interface DrapeFrame {
  matrix: Float32Array
  logDepthFc: number
  eye?: readonly [number, number, number]
}

/** Minimal bake surface the caller supplies (VectorTileRenderer's I1 offscreen
 *  fill bake). Kept as an interface so this renderer doesn't import the VTR. */
export interface DrapeBakeProvider {
  bakeTileToTexture(
    sliceLayer: string,
    key: number,
    fill: readonly [number, number, number, number],
    sizePx: number,
    /** #1222 zoom-bucket stroke-width compensation; 1 = bake-native. */
    strokeWidthScale?: number,
    /** #2024 — bake only this WINDOW of the tile (parent-local Mercator metres,
     *  origin = tile SW corner): the virtual sub-tile rect at overzoom, so a
     *  512px bake keeps native texel density past the source maxLevel. Absent =
     *  the whole tile (byte-identical to the pre-#2024 bake). */
    window?: BakeWindow,
  ): RhiTexture | null
}

/** #2024 — sub-rect of a tile's local-Mercator frame ([0, E]²) to bake. */
export interface BakeWindow {
  /** Window origin X in tile-local Mercator metres (0 = tile west edge). */
  ox: number
  /** Window origin Y in tile-local Mercator metres (0 = tile SOUTH edge). */
  oy: number
  /** Window extent (square) in tile-local Mercator metres. */
  extent: number
}

/** #2024 — one virtual overzoom tile the drape renders as a windowed bake of
 *  its resident maxLevel ancestor. Emitted by the VTR's globe overzoom
 *  dispatch (globeVisibleTiles at the virtual z), so the set exactly tiles the
 *  viewport — the drape draws EITHER these OR the parent tiles, never both
 *  (double alpha-cover would darken translucent fills). */
export interface DrapeOverzoomTile {
  z: number
  x: number
  y: number
  /** Compiler tileKey of the maxLevel ancestor whose geometry gets windowed. */
  parentKey: number
}

/** Drape baked vector-fill tiles onto the raster sphere grid (#599 I2). Owns the
 *  shared RasterDraper + the raster global uniform + a per-tile baked-texture
 *  cache (validated by uploadEpoch + fill colour, so a static globe re-bakes
 *  nothing). I3 (#599): the cache is bounded by an LRU cap + freed on destroy;
 *  #2093 also releases it in full once it goes COLD (the LOD ceiling can retire
 *  the drape for good, and an LRU cap alone never frees an under-cap cache);
 *  eviction is deferred to beginFrame (see there for the lifecycle rationale). */
export class VectorDrapeRenderer {
  private readonly draper: RasterDraper
  private readonly global: UniformBlockOf<typeof RASTER_U>
  private readonly tileScratch: UniformBlockOf<typeof RASTER_TILE_U>
  private readonly baked = new Map<
    string,
    {
      tex: RhiTexture
      uploadEpoch: number
      fillKey: number
      strokeKey: number
      /** #1222 — quarter-zoom bucket the strokes were baked at (0 for fill-only). */
      zoomBucket: number
      lastCall: number
    }
  >()
  private calls = 0
  /** Cache keys draped THIS frame — the eviction skip-set (like the raster
   *  renderer's lastVisibleKeys). Accumulated in renderGlobeFills, consumed +
   *  cleared at the next beginFrame so eviction never drops an on-screen tile. */
  private readonly visibleKeys = new Set<string>()
  /** Frame-monotonic base into the shared RasterDraper.material pool (#1142). All
   *  drape-eligible slice-layers of one source share THIS renderer's single
   *  RasterDraper, and each issues its own draper.draw() into the ONE per-frame
   *  submit. WebGPU's queue.writeBuffer is deferred to that submit, so if two
   *  slice draws reuse the same pool slot the earlier draw reads the later slice's
   *  per-tile uniform (a draped tile lands at another tile's position). Handing
   *  each draw a distinct base — advanced by its tile count, reset per frame in
   *  beginFrame() — gives every slice its own pool buffers. */
  private _framePoolBase = 0
  /** #2249 — scratch for the fill-translate-shifted MVP. `frame.matrix` is a
   *  camera-OWNED preallocated buffer that the next `getViewForProjection`
   *  overwrites (camera.ts), so the shifted copy must live here rather than
   *  mutating the caller's. Allocated once; the drape draws once per slice
   *  layer per frame. */
  private readonly _mvpScratch = new Float32Array(16)
  /** Bake textures retired by eviction / re-bake, destroyed on the NEXT beginFrame
   *  — the post-submit safe window (mirrors gpu-tile-store's _retiredArenaBuffers).
   *  queue.submit() returning ≠ the GPU having drained the command buffer, so a
   *  same-frame (or one-frame-early) destroy can free a texture the prior in-flight
   *  submit still references ("Destroyed texture used in a submit"). One more frame
   *  guarantees the referencing submit has completed. */
  private readonly _retiredBakes: RhiTexture[] = []
  /** #2093 — consecutive beginFrame()s that saw NO bake draped. Drives the
   *  cold-cache release (see COLD_RELEASE_FRAMES). */
  private _coldFrames = 0

  constructor(
    private readonly rhi: RhiDevice,
    format: string,
    sampleCount: number,
  ) {
    this.draper = new RasterDraper(rhi, format, sampleCount)
    this.global = uniformBlock(RASTER_U)
    this.tileScratch = uniformBlock(RASTER_TILE_U)
  }

  /** Drape a show's resident globe-visible flat fills onto the sphere. For each
   *  visible tile: bake its fill (I1, cached by uploadEpoch + fill), pack the
   *  raster per-tile drape uniform (bounds + SW-corner ECEF anchor + Mercator-Y
   *  span, world-copy aware), then draw through the shared raster sphere-grid
   *  material. The bake self-submits its own command buffer (ownsSubmit), ordered
   *  before this frame's encoder, so the drape samples it in the same frame. */
  renderGlobeFills(
    pass: RhiRenderPass,
    frame: DrapeFrame,
    projType: number,
    projCenterLon: number,
    projCenterLat: number,
    /** Camera 2D centre — feeds rasterFrameCamAnchor's Mercator/flat lanes (#2022).
     *  Only centerX/centerY are read; the globe arm ignores them. */
    camera: { centerX: number; centerY: number },
    opacity: number,
    fill: readonly [number, number, number, number],
    /** #599 line-drape — a 32-bit key over the show's stroke style (VTR.strokeBakeKey). Part of the
     *  bake cache key so a stroke-style change re-bakes the tile texture. 0 when there is no stroke. */
    strokeKey: number,
    /** #1222 — the camera's CONTINUOUS zoom. Strokes are baked at a fixed mpp, so the camera's
     *  magnification within a tile level must re-bake them (quarter-zoom buckets) with the width
     *  compensated — otherwise the stroke width scales with the camera instead of staying screen-px. */
    camZoom: number,
    sliceLayer: string,
    neededKeys: number[],
    worldOffDeg: number[] | undefined,
    layerCache: Map<number, GPUTile>,
    provider: DrapeBakeProvider,
    /** #2024 — when present and non-empty (globe overzoom past the source
     *  maxLevel), drape THESE virtual sub-tiles — each a 512px WINDOWED bake of
     *  its resident maxLevel ancestor — INSTEAD of neededKeys, restoring native
     *  texel density at any camera depth. The caller passes this only when
     *  every parentKey is resident, so the parent→virtual switch is atomic per
     *  frame: parent and child cover are never mixed (double alpha cover would
     *  darken translucent fills). */
    overzoom?: DrapeOverzoomTile[],
    /** #2249 — the show's `fill-translate`, already anchor-rotated, in NDC
     *  units (the #2240 single producer `fillTranslateNdc`). The DIRECT fill
     *  draw applies this in the polygon VS; the drape's sphere draw has no
     *  such site — its tile textures are baked with the offset deliberately at
     *  0 (the bake's ortho has clip.w === 1 over one tile, so a canvas-pixel
     *  NDC offset is dimensionally wrong there and would seam between tiles).
     *  So it is applied HERE instead, to the camera MVP, one stage earlier —
     *  which is the same operation and needs no shader change. Default [0,0]
     *  keeps every existing caller and every unauthored scene byte-identical. */
    fillTranslateNdc: readonly [number, number] = [0, 0],
  ): void {
    this.calls++
    // Cache-invalidation key: quantized fill RGBA. A colour change re-bakes; a
    // stable colour reuses the texture across frames + world copies.
    const q = (c: number): number => (c * 255) & 0xff
    const fillKey = q(fill[0]) | (q(fill[1]) << 8) | (q(fill[2]) << 16) | (q(fill[3]) << 24)

    const tiles: RasterTile[] = []
    const useOverzoom = overzoom !== undefined && overzoom.length > 0
    if (useOverzoom) {
      // ─── #2024 virtual overzoom sub-tiles (globe route) ───
      // The set comes from globeVisibleTiles at the virtual z, so it exactly
      // tiles the viewport; the globe is SINGLE_WORLD, so no world-copy offsets.
      for (const vt of overzoom) {
        const cached = layerCache.get(vt.parentKey)
        if (!cached || cached.extruded) continue
        // Stroke rebake bucket vs the VIRTUAL z: the windowed bake magnifies
        // 2^(vz − parentZ) less than the parent bake would, so camZoom − vz is
        // the residual magnification the #1222 width compensation must cancel.
        const zoomBucket =
          strokeKey !== 0 && (cached.outlineSegmentCount > 0 || cached.lineSegmentCount > 0)
            ? drapeZoomBucket(camZoom, vt.z)
            : 0
        // Virtual tile bounds — the standard Mercator tile formulas (matches
        // tile-catalog.ts), NOT derived from the parent's f32-quantized fields.
        const tileN = Math.pow(2, vt.z)
        const west = (vt.x / tileN) * 360 - 180
        const east = ((vt.x + 1) / tileN) * 360 - 180
        const north = tileRowLat(vt.y, tileN)
        const south = tileRowLat(vt.y + 1, tileN)
        // Bake window in the PARENT's tile-local Mercator-metre frame (origin =
        // parent SW corner, the frame the packed vertex local_merc lanes live
        // in). extent is exact (E / 2^Δz); the origin comes from the f64 bounds.
        const parentE = TWO_PI_R / Math.pow(2, cached.tileZoom)
        const extent = parentE / Math.pow(2, vt.z - cached.tileZoom)
        const window: BakeWindow = {
          ox: (west - cached.tileWest) * DEG2RAD * SPHERE_R,
          oy: (mercY(south) - mercY(cached.tileSouth)) * SPHERE_R,
          extent,
        }
        const cacheKey = `${sliceLayer}:${vt.parentKey}:${vt.z}/${vt.x}/${vt.y}`
        const tex = this._obtainBake(
          provider,
          sliceLayer,
          vt.parentKey,
          cached,
          fill,
          fillKey,
          strokeKey,
          zoomBucket,
          cacheKey,
          window,
        )
        if (!tex) continue
        const swEcef = lonLatToECEF(west, south)
        const mercSouth = mercY(south)
        const gridN = rasterGridN(projType, vt.z)
        writeRasterTileUniform(
          this.tileScratch,
          west,
          south,
          east,
          north,
          swEcef,
          mercSouth,
          mercY(north) - mercSouth,
          gridN,
        )
        tiles.push({
          texture: tex,
          tileBytes: new Float32Array(this.tileScratch.buffer.slice(0)),
          gridN,
        })
      }
    }
    for (let ki = 0; !useOverzoom && ki < neededKeys.length; ki++) {
      const key = neededKeys[ki]!
      const cached = layerCache.get(key)
      // #599 line-drape — bake fill tiles AND line-only tiles (indexCount 0 but non-empty stroke
      // segments); bakeTileToTexture returns null when a tile has neither, self-skipping empties.
      if (!cached || cached.extruded) continue

      // Bake ONCE per key (the baked texture is tile-local — world-copy
      // invariant); reuse across frames + world copies while unchanged. `key` is
      // the compiler tileKey (4^z + morton(x,y)), so ZOOM is already part of the
      // cache key — a different z is a distinct entry and a zoom-level change can
      // never drape a stale-z bake (the old-z keys just drop out of neededKeys).
      const cacheKey = `${sliceLayer}:${key}`
      // #1222 — strokes bake a SCREEN-px width at a fixed mpp, so the camera's
      // continuous zoom re-buckets them. Fill-only content is area-styled — its
      // magnification is benign — so the bucket applies only when THIS tile has
      // stroke geometry to re-rasterise: an interior tile of a stroked polygon
      // show (fill triangles, no outline segments) keeps bucket 0 and never
      // zoom-rebakes.
      const zoomBucket =
        strokeKey !== 0 && (cached.outlineSegmentCount > 0 || cached.lineSegmentCount > 0)
          ? drapeZoomBucket(camZoom, cached.tileZoom)
          : 0
      const tex = this._obtainBake(
        provider,
        sliceLayer,
        key,
        cached,
        fill,
        fillKey,
        strokeKey,
        zoomBucket,
        cacheKey,
      )
      if (!tex) continue

      // Per-tile drape bounds — the raster tile formula (tile-catalog.ts). The
      // world-copy offset shifts lon so the tile lands in its own copy; the
      // Mercator-Y span (lat) is copy-invariant.
      const worldOff = worldOffDeg?.[ki] ?? 0
      const west = cached.tileWest + worldOff
      const east = cached.tileWest + cached.tileWidth + worldOff
      const south = cached.tileSouth
      const north = cached.tileSouth + cached.tileHeight
      const swEcef = lonLatToECEF(west, south)
      const mercSouth = mercY(south)
      // #1040 — this drape reuses the raster sphere grid, so it inherits the same
      // per-tile density ladder: a low-z globe drape densifies (z0:128 … z4+:8).
      const gridN = rasterGridN(projType, cached.tileZoom)
      writeRasterTileUniform(
        this.tileScratch,
        west,
        south,
        east,
        north,
        swEcef,
        mercSouth,
        mercY(north) - mercSouth,
        gridN,
      )
      // The scratch block is reused per tile — COPY its bytes for the batch entry.
      tiles.push({
        texture: tex,
        tileBytes: new Float32Array(this.tileScratch.buffer.slice(0)),
        gridN,
      })
    }

    if (tiles.length > 0) {
      // #2249 — fold `fill-translate` into the MVP. clip = M·v, so shifting
      // clip.xy by t·clip.w is exactly adding t·(row 3) into rows 0/1 of M.
      // Column-major (WGSL `mat4x4<f32>`): element (row r, col c) is m[c*4+r],
      // so row 3 is m[3], m[7], m[11], m[15].
      //
      // The SIGN mirrors the polygon VS, which is the authority for what this
      // property means on screen — `clip.x.add(fillTx·w)` but
      // `clip.y.sub(fillTy·w)` (shaders/dsl/polygon.ts:607-608). Symmetric
      // `+=` on both axes would put the y offset the wrong way and show up
      // only on the globe, where nothing else draws this property.
      const [ftx, fty] = fillTranslateNdc
      let mvpFrame = frame
      if (ftx !== 0 || fty !== 0) {
        const m = this._mvpScratch
        m.set(frame.matrix)
        for (let c = 0; c < 4; c++) {
          const w = m[c * 4 + 3]!
          m[c * 4 + 0] = m[c * 4 + 0]! + ftx * w
          m[c * 4 + 1] = m[c * 4 + 1]! - fty * w
        }
        mvpFrame = {
          matrix: m,
          logDepthFc: frame.logDepthFc,
          ...(frame.eye ? { eye: frame.eye } : {}),
        }
      }
      writeRasterFrameUniform(
        this.global,
        mvpFrame,
        projType,
        projCenterLon,
        projCenterLat,
        // #2022 — the SAME per-projType anchor authority raster + hillshade pack.
        // The drape serves {3,4,5} ∪ globeMode; on the flat-disc trio vs_tile's
        // flat arm reads [clon, camProj0.x, camProj0.y], and the unconditional
        // globe ECEF anchor put planet-scale metres in those lanes — every
        // draped fill landed off-screen (fills invisible on ortho/azi/stereo).
        rasterFrameCamAnchor(camera, projType, projCenterLon, projCenterLat),
        { opacity, hueRotate: 0, brightnessMin: 0, brightnessMax: 1, saturation: 0, contrast: 0 },
      )
      this.draper.draw(pass, this.global.buffer, tiles, false, isPickEnabled(), this._framePoolBase)
      // Advance so the NEXT slice-layer's draw() this frame gets fresh pool slots
      // (its draws share this one per-frame submit; see _framePoolBase). #1142
      this._framePoolBase += tiles.length
    }
  }

  /** Bake-cache lookup/refresh shared by the primary and #2024 virtual-overzoom
   *  loops. Bakes (or re-bakes on any invalidation-key change), retires the
   *  replaced texture into the post-submit-safe queue, marks the entry draped
   *  this frame (the beginFrame eviction skip-set), and returns the texture —
   *  null when the tile has nothing to bake (provider self-skips empties). */
  private _obtainBake(
    provider: DrapeBakeProvider,
    sliceLayer: string,
    providerKey: number,
    cached: GPUTile,
    fill: readonly [number, number, number, number],
    fillKey: number,
    strokeKey: number,
    zoomBucket: number,
    cacheKey: string,
    window?: BakeWindow,
  ): RhiTexture | null {
    let entry = this.baked.get(cacheKey)
    if (
      !entry ||
      entry.uploadEpoch !== cached.uploadEpoch ||
      entry.fillKey !== fillKey ||
      entry.strokeKey !== strokeKey ||
      entry.zoomBucket !== zoomBucket
    ) {
      const tex = provider.bakeTileToTexture(
        sliceLayer,
        providerKey,
        fill,
        BAKE_PX,
        drapeStrokeWidthScale(zoomBucket),
        window,
      )
      if (!tex) return null
      if (entry) {
        this.draper.dropTexture(entry.tex) // invalidate the draper cache before freeing
        this._retiredBakes.push(entry.tex) // destroy next frame — the prior submit may still reference it
      }
      entry = {
        tex,
        uploadEpoch: cached.uploadEpoch,
        fillKey,
        strokeKey,
        zoomBucket,
        lastCall: this.calls,
      }
      this.baked.set(cacheKey, entry)
    }
    entry.lastCall = this.calls
    // Mark this bake as draped this frame — the beginFrame eviction skip-set.
    this.visibleKeys.add(cacheKey)
    return entry.tex
  }

  /** Frame-boundary cache maintenance — MUST run once per frame BEFORE this
   *  frame's renderGlobeFills calls (VTR.beginFrame drives it). Evicts the
   *  least-recently-draped bakes past the viewport-aware cap (#1579 —
   *  `maxCachedEntriesFor`, sharing the raster cache's byte ceiling instead of a
   *  flat desktop-sized count), skipping the previous frame's visible set, then
   *  rolls the visible set forward. #2093 adds the cold-cache release below the
   *  cap eviction: the same visible set that gates eviction also says whether the
   *  cache was sampled AT ALL, and COLD_RELEASE_FRAMES drape-free frames drop it
   *  entirely (through the same retire queue).
   *
   *  Eviction is DEFERRED here rather than run inline in renderGlobeFills for
   *  the SAME lifecycle reason the raster tile cache (raster-renderer.evictTiles)
   *  and the VTR tile-buffer eviction defer to the next frame: the drape encodes
   *  every sphere-route fill layer into ONE render pass, so destroying a texture
   *  mid-frame can free one still referenced by an encoded-but-not-yet-submitted
   *  draw ("Destroyed texture used in submit"). Deferring to beginFrame alone was
   *  NOT enough on WebGPU — queue.submit() returning ≠ the GPU having drained it —
   *  so evicted textures are RETIRED and destroyed on the NEXT beginFrame, one frame
   *  later, once the referencing submit has completed (see _retiredBakes). */
  beginFrame(): void {
    // Drain last frame's retired bakes FIRST — retired a frame ago, so the submit
    // that referenced them has now drained (the post-submit safe window).
    if (this._retiredBakes.length > 0) {
      for (const t of this._retiredBakes) this.rhi.destroyTexture(t)
      this._retiredBakes.length = 0
    }
    const cap = maxCachedEntriesFor(BAKE_BYTES)
    if (this.baked.size > cap) {
      for (const k of planBakeEvictions(this.baked, this.visibleKeys, cap)) {
        const tex = this.baked.get(k)!.tex
        this.draper.dropTexture(tex) // invalidate the draper cache before freeing
        this._retiredBakes.push(tex) // destroy next frame — the prior submit may still reference it
        this.baked.delete(k)
      }
    }
    // #2093 cold-cache release. `visibleKeys` is the set of bakes the frame that
    // just ended actually draped, so an empty set means the cache went unsampled.
    // The cap eviction above cannot free it — it only trims ABOVE the cap — so a
    // cache that goes permanently cold (the LOD ceiling hands every vector layer
    // to the direct arm) would sit at its high-water mark until destroy(). Drop
    // the whole thing through the SAME retire queue the eviction uses, so the
    // textures are destroyed one frame later, after the referencing submit has
    // drained. The VTR's lazy `this._drape ??=` re-creates nothing — this
    // renderer stays alive and simply re-bakes if draping resumes.
    if (this.visibleKeys.size > 0 || this.baked.size === 0) {
      this._coldFrames = 0
    } else if (++this._coldFrames >= COLD_RELEASE_FRAMES) {
      for (const e of this.baked.values()) {
        this.draper.dropTexture(e.tex) // invalidate the draper cache before freeing
        this._retiredBakes.push(e.tex) // destroy next frame — same deferred-retire discipline
      }
      this.baked.clear()
      this._coldFrames = 0
    }
    this.visibleKeys.clear()
    // Restart the shared-pool base for the new frame (see _framePoolBase). #1142
    this._framePoolBase = 0
  }

  /** Free every baked texture + drop the cache. Called from VTR.destroy when the
   *  source / map is torn down (the drape's own GPU-resource teardown). After
   *  destroy() the renderer is dead — create a new one if draping resumes. */
  destroy(): void {
    for (const t of this._retiredBakes) this.rhi.destroyTexture(t)
    this._retiredBakes.length = 0
    for (const e of this.baked.values()) {
      this.draper.dropTexture(e.tex) // invalidate the draper cache before freeing
      this.rhi.destroyTexture(e.tex)
    }
    this.baked.clear()
    this.visibleKeys.clear()
  }
}
