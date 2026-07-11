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
import { rasterU as RASTER_U, rasterTileU as RASTER_TILE_U } from '../shaders/dsl/raster'
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
const STALE_CALLS = 120

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
 *  nothing). */
export class VectorDrapeRenderer {
  private readonly draper: RasterDraper
  private readonly global: UniformBlockOf<typeof RASTER_U>
  private readonly tileScratch: UniformBlockOf<typeof RASTER_TILE_U>
  private readonly baked = new Map<
    string,
    { tex: RhiTexture; uploadEpoch: number; fillKey: number; lastCall: number }
  >()
  private calls = 0

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
      if (!cached || cached.indexCount === 0 || cached.extruded) continue

      // Bake ONCE per key (the baked texture is tile-local — world-copy
      // invariant); reuse across frames + world copies while unchanged.
      const cacheKey = `${sliceLayer}:${key}`
      let entry = this.baked.get(cacheKey)
      if (!entry || entry.uploadEpoch !== cached.uploadEpoch || entry.fillKey !== fillKey) {
        const tex = provider.bakeTileToTexture(sliceLayer, key, fill, BAKE_PX)
        if (!tex) continue
        if (entry) this.rhi.destroyTexture(entry.tex)
        entry = { tex, uploadEpoch: cached.uploadEpoch, fillKey, lastCall: this.calls }
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
      writeRasterTileUniform(
        this.tileScratch,
        west,
        south,
        east,
        north,
        swEcef,
        mercSouth,
        mercY(north) - mercSouth,
      )
      // The scratch block is reused per tile — COPY its bytes for the batch entry.
      tiles.push({
        texture: entry.tex,
        tileBytes: new Float32Array(this.tileScratch.buffer.slice(0)),
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
      this.draper.draw(pass, this.global.buffer, tiles, false, isPickEnabled())
    }

    // Evict baked textures not visited for STALE_CALLS draws (LRU-ish) — bounds
    // the cache the way the raster tile cache is capped.
    for (const [k, e] of this.baked) {
      if (this.calls - e.lastCall > STALE_CALLS) {
        this.rhi.destroyTexture(e.tex)
        this.baked.delete(k)
      }
    }
  }
}
