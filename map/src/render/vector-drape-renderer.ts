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
// SPHERE ROUTE ONLY — the caller (VectorTileRenderer) gates this behind
// routeToSphereSelector, so the flat / Mercator vector path stays byte-identical.

import type { RhiDevice, RhiTexture, RhiRenderPass } from '@xgis/engine'
import { uniformBlock, isPickEnabled, type UniformBlockOf } from '@xgis/engine'
import { lonLatToECEF } from '@xgis/shared'
import { RasterDraper, type RasterTile } from './material/raster-material'
import { planBakeEvictions } from './vector-drape-cache'
import {
  rasterU as RASTER_U,
  rasterTileU as RASTER_TILE_U,
  rasterGridN,
} from '../shaders/dsl/raster'
import {
  writeRasterFrameUniform,
  writeRasterTileUniform,
  rasterGlobeCamAnchor,
} from './raster-renderer'
import type { GPUTile } from './vector-tile-renderer-types'

const DEG2RAD = Math.PI / 180
const MERC_LIMIT = 85.051129
const clampLat = (v: number): number => Math.max(-MERC_LIMIT, Math.min(MERC_LIMIT, v))
const mercY = (latDeg: number): number =>
  Math.log(Math.tan(Math.PI / 4 + (clampLat(latDeg) * DEG2RAD) / 2))
const BAKE_PX = 512
// Hard cap on resident baked-fill textures — the drape's analogue of the raster
// tile cache's MAX_CACHED_TILES (raster-renderer.ts). Each bake is BAKE_PX²
// RGBA8 (~1 MB at 512px), so this LRU-bounds baked-fill VRAM the same way the
// raster path bounds fetched tiles. Enforced at the frame boundary (beginFrame).
const MAX_CACHED_BAKES = 256

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
  ): RhiTexture | null
}

/** Drape baked vector-fill tiles onto the raster sphere grid (#599 I2). Owns the
 *  shared RasterDraper + the raster global uniform + a per-tile baked-texture
 *  cache (validated by uploadEpoch + fill colour, so a static globe re-bakes
 *  nothing). I3 (#599): the cache is bounded by an LRU cap + freed on destroy;
 *  eviction is deferred to beginFrame (see there for the lifecycle rationale). */
export class VectorDrapeRenderer {
  private readonly draper: RasterDraper
  private readonly global: UniformBlockOf<typeof RASTER_U>
  private readonly tileScratch: UniformBlockOf<typeof RASTER_TILE_U>
  private readonly baked = new Map<
    string,
    { tex: RhiTexture; uploadEpoch: number; fillKey: number; strokeKey: number; lastCall: number }
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
  /** Bake textures retired by eviction / re-bake, destroyed on the NEXT beginFrame
   *  — the post-submit safe window (mirrors gpu-tile-store's _retiredArenaBuffers).
   *  queue.submit() returning ≠ the GPU having drained the command buffer, so a
   *  same-frame (or one-frame-early) destroy can free a texture the prior in-flight
   *  submit still references ("Destroyed texture used in a submit"). One more frame
   *  guarantees the referencing submit has completed. */
  private readonly _retiredBakes: RhiTexture[] = []

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
    opacity: number,
    fill: readonly [number, number, number, number],
    /** #599 line-drape — a 32-bit key over the show's stroke style (VTR.strokeBakeKey). Part of the
     *  bake cache key so a stroke-style change re-bakes the tile texture. 0 when there is no stroke. */
    strokeKey: number,
    sliceLayer: string,
    neededKeys: number[],
    worldOffDeg: number[] | undefined,
    layerCache: Map<number, GPUTile>,
    provider: DrapeBakeProvider,
  ): void {
    this.calls++
    // Cache-invalidation key: quantized fill RGBA. A colour change re-bakes; a
    // stable colour reuses the texture across frames + world copies.
    const q = (c: number): number => (c * 255) & 0xff
    const fillKey = q(fill[0]) | (q(fill[1]) << 8) | (q(fill[2]) << 16) | (q(fill[3]) << 24)

    const tiles: RasterTile[] = []
    for (let ki = 0; ki < neededKeys.length; ki++) {
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
      let entry = this.baked.get(cacheKey)
      if (
        !entry ||
        entry.uploadEpoch !== cached.uploadEpoch ||
        entry.fillKey !== fillKey ||
        entry.strokeKey !== strokeKey
      ) {
        const tex = provider.bakeTileToTexture(sliceLayer, key, fill, BAKE_PX)
        if (!tex) continue
        if (entry) {
          this.draper.dropTexture(entry.tex) // invalidate the draper cache before freeing
          this._retiredBakes.push(entry.tex) // destroy next frame — the prior submit may still reference it
        }
        entry = { tex, uploadEpoch: cached.uploadEpoch, fillKey, strokeKey, lastCall: this.calls }
        this.baked.set(cacheKey, entry)
      }
      entry.lastCall = this.calls

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
      // Mark this bake as draped this frame — the beginFrame eviction skip-set.
      this.visibleKeys.add(cacheKey)
      // The scratch block is reused per tile — COPY its bytes for the batch entry.
      tiles.push({
        texture: entry.tex,
        tileBytes: new Float32Array(this.tileScratch.buffer.slice(0)),
        gridN,
      })
    }

    if (tiles.length > 0) {
      writeRasterFrameUniform(
        this.global,
        frame,
        projType,
        projCenterLon,
        projCenterLat,
        rasterGlobeCamAnchor(projCenterLon, projCenterLat),
        { opacity, hueRotate: 0, brightnessMin: 0, brightnessMax: 1, saturation: 0, contrast: 0 },
      )
      this.draper.draw(pass, this.global.buffer, tiles, false, isPickEnabled(), this._framePoolBase)
      // Advance so the NEXT slice-layer's draw() this frame gets fresh pool slots
      // (its draws share this one per-frame submit; see _framePoolBase). #1142
      this._framePoolBase += tiles.length
    }
  }

  /** Frame-boundary cache maintenance — MUST run once per frame BEFORE this
   *  frame's renderGlobeFills calls (VTR.beginFrame drives it). Evicts the
   *  least-recently-draped bakes past MAX_CACHED_BAKES, skipping the previous
   *  frame's visible set, then rolls the visible set forward.
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
    if (this.baked.size > MAX_CACHED_BAKES) {
      for (const k of planBakeEvictions(this.baked, this.visibleKeys, MAX_CACHED_BAKES)) {
        const tex = this.baked.get(k)!.tex
        this.draper.dropTexture(tex) // invalidate the draper cache before freeing
        this._retiredBakes.push(tex) // destroy next frame — the prior submit may still reference it
        this.baked.delete(k)
      }
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
