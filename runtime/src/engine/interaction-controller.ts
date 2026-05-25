// ═══ X-GIS InteractionController — pick / hit-test / coord-convert cluster ═══
//
// Third structural decomposition of XGISMap: the pick + interaction QUERY
// methods (`pickAt` / `getLayerByPickId` / `buildFeatureForEvent` /
// `lookupFeatureProperties` / `clientToLngLat`) live here. XGISMap keeps
// the shared state these methods read (`camera`, `ctx`, `layerIds`,
// `xgisLayers`, `rawDatasets`, `_featureIndex`, `vectorTileShows`,
// `pickTexture`) as the SHARED references — InteractionController receives
// the SAME instances by reference, or reads mutable/lazily-populated ones
// fresh via accessors, so every internal read in renderFrame /
// rebuildLayers / diagnostics stays untouched.
//
// BEHAVIOR + PUBLIC API IDENTICAL — every method below is moved verbatim
// from map.ts; only the dependency wiring changed:
//   - `this.camera` / `this.layerIds` / `this.xgisLayers` /
//     `this.rawDatasets` / `this._featureIndex` → the same instances,
//     held here by reference (none are reassigned on the host).
//   - `this.ctx`                → injected `getCtx()` accessor (lazily
//     populated in run(); must be read fresh, not captured at ctor).
//   - `this.pickTexture`        → injected `getPickTexture()` accessor
//     (allocated/destroyed in the render-target setup, so read fresh).
//   - `this.projectionName`     → injected `getProjectionName()` accessor
//     (mutated by setProjection at runtime).
//   - `this.vectorTileShows`    → injected `getVectorTileShows()` accessor
//     (reassigned to [] at rebuildLayers start, so read fresh).
//   - `this.pickReadbackPool`   → owned here (only pickAt reads/mutates it).

import type { Camera } from './projection/camera'
import { mercatorYToLat } from './projection/projection'
import type { GPUContext } from './gpu/gpu'
import type { LayerIdRegistry, XGISLayer, XGISFeature } from './layer'
import type { SceneCommands } from './interpreter'
import type { GeoJSONFeature, GeoJSONFeatureCollection } from '../loader/geojson'
import { toU32Id } from './id-resolver'

/** A vectorTileShows entry — structural type matching XGISMap's array
 *  element; only the `show` field's `layerName` / `targetName` are read
 *  by buildFeatureForEvent so the rest is left as the host declares it. */
type VectorTileShowEntry = {
  sourceName: string
  show: SceneCommands['shows'][0]
  pipelines: unknown
  layout: GPUBindGroupLayout | null
}

/** Dependencies InteractionController needs from the host XGISMap. */
export interface InteractionControllerDeps {
  /** The Camera instance (stable, created in XGISMap ctor). */
  camera: Camera
  /** Shared with XGISMap — same registry instance, by reference. */
  layerIds: LayerIdRegistry
  /** Shared with XGISMap — same Map instance, by reference. */
  xgisLayers: Map<string, XGISLayer>
  /** Shared with XGISMap — same Map instance, by reference. */
  rawDatasets: Map<string, GeoJSONFeatureCollection>
  /** Shared with XGISMap — same Map instance, by reference. */
  featureIndex: Map<string, Map<number, GeoJSONFeature>>
  /** The WebGPU context, read fresh (populated in run() / runBinary). */
  getCtx(): GPUContext | null
  /** The single-sample pick render-target, read fresh (allocated /
   *  destroyed during render-target setup; null when picking disabled). */
  getPickTexture(): GPUTexture | null
  /** The active projection key, read fresh (mutated by setProjection). */
  getProjectionName(): string
  /** The vectorTileShows array, read fresh (reassigned in rebuildLayers). */
  getVectorTileShows(): VectorTileShowEntry[]
}

export class InteractionController {
  private readonly camera: Camera
  private readonly layerIds: LayerIdRegistry
  private readonly xgisLayers: Map<string, XGISLayer>
  private readonly rawDatasets: Map<string, GeoJSONFeatureCollection>
  private readonly _featureIndex: Map<string, Map<number, GeoJSONFeature>>
  private readonly getCtx: () => GPUContext | null
  private readonly getPickTexture: () => GPUTexture | null
  private readonly getProjectionName: () => string
  private readonly getVectorTileShows: () => VectorTileShowEntry[]

  /** Reusable MAP_READ buffer pool for pickAt() readbacks. Each entry holds
   *  exactly 8 bytes (one RG32Uint pixel) — a ring keeps mapAsync latency
   *  off the hot path. */
  private pickReadbackPool: { buf: GPUBuffer; inUse: boolean }[] = []

  constructor(deps: InteractionControllerDeps) {
    this.camera = deps.camera
    this.layerIds = deps.layerIds
    this.xgisLayers = deps.xgisLayers
    this.rawDatasets = deps.rawDatasets
    this._featureIndex = deps.featureIndex
    this.getCtx = deps.getCtx
    this.getPickTexture = deps.getPickTexture
    this.getProjectionName = deps.getProjectionName
    this.getVectorTileShows = deps.getVectorTileShows
  }

  /** Read the feature + instance ID under the given CSS pixel coordinate.
   *  Requires the map to be built with `?picking=1` — otherwise returns
   *  null immediately (no pick RT exists). Async because readback from a
   *  GPU texture has a ~1-frame latency via `mapAsync`.
   *
   *  - Returns `{ featureId, instanceId }` when a feature covers the pixel
   *  - Returns `null` when the pick pixel is (0, 0) (no feature / basemap)
   *  - `featureId` matches what `lower.ts` assigned to the geometry part
   *    (usually the feature's index in its source GeoJSON / tile)
   *  - `instanceId` is 0 until WORLD_COPIES instancing ships (future)
   *
   *  Pool reuse: the staging buffer ring avoids allocating per call, so
   *  hover scenarios (60 Hz pickAt) stay cheap. */
  async pickAt(clientX: number, clientY: number): Promise<{ featureId: number; layerId: number; instanceId: number } | null> {
    const pickTexture = this.getPickTexture()
    const ctx = this.getCtx()
    if (!pickTexture || !ctx) return null
    const canvas = ctx.canvas
    const rect = canvas.getBoundingClientRect()
    // Convert CSS coords → physical pixels (match the dpr used for the
    // framebuffer size). Clamp into bounds; out-of-canvas → null.
    const px = Math.floor((clientX - rect.left) * (canvas.width / rect.width))
    const py = Math.floor((clientY - rect.top) * (canvas.height / rect.height))
    if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return null

    // Rent a staging buffer. Each slot is 8 bytes (one RG32Uint pixel,
    // padded to minimum 256-byte row per WebGPU's copy alignment). We
    // over-allocate to 256 so bytesPerRow is valid.
    let slot = this.pickReadbackPool.find(s => !s.inUse)
    if (!slot) {
      slot = {
        buf: ctx.device.createBuffer({
          size: 256,
          usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
          label: 'pick-readback',
        }),
        inUse: false,
      }
      this.pickReadbackPool.push(slot)
    }
    slot.inUse = true

    const encoder = ctx.device.createCommandEncoder({ label: 'pick-copy' })
    encoder.copyTextureToBuffer(
      { texture: pickTexture, origin: { x: px, y: py } },
      { buffer: slot.buf, bytesPerRow: 256, rowsPerImage: 1 },
      { width: 1, height: 1 },
    )
    ctx.device.queue.submit([encoder.finish()])

    try {
      await slot.buf.mapAsync(GPUMapMode.READ, 0, 8)
      const view = new Uint32Array(slot.buf.getMappedRange(0, 8))
      const featureId = view[0]
      // G channel packs (instanceId << 16) | layerId — see LayerIdRegistry.
      const packed = view[1]
      slot.buf.unmap()
      const layerId = packed & 0xffff
      const instanceId = (packed >>> 16) & 0xffff
      // Both featureId=0 and layerId=0 are sentinels: featureId=0 means "no
      // feature drew here" (raster-only / background), layerId=0 means "no
      // pickable layer drew here" (e.g., graticule, or Phase 3's
      // pointer-events:none with writeMask=0 yields 0 because the slot was
      // never written). Either is a miss.
      if (featureId === 0 || layerId === 0) return null
      return { featureId, layerId, instanceId }
    } finally {
      slot.inUse = false
    }
  }

  /** Reverse-resolve a layerId from the pick texture into its public
   *  XGISLayer wrapper. Returns null for the sentinel `0` and any ID
   *  that no longer maps to a registered layer (post-clearLayers). */
  getLayerByPickId(layerId: number): XGISLayer | null {
    if (layerId === 0) return null
    const name = this.layerIds.getName(layerId)
    if (!name) return null
    return this.xgisLayers.get(name) ?? null
  }

  /** Build the rich feature payload for an event hit. Falls back to an
   *  ID-only feature when the source's `_featureIndex` doesn't carry
   *  full properties (e.g., .xgvt-loaded tile sources without a parsed
   *  property table). */
  buildFeatureForEvent(layerId: number, featureId: number): XGISFeature | null {
    const layerName = this.layerIds.getName(layerId)
    if (!layerName) return null
    const layer = this.xgisLayers.get(layerName)
    if (!layer) return null
    // Find the source by walking vectorTileShows for the show this layer
    // wraps. Phase 4 only supports GeoJSON sources (in `_featureIndex`);
    // .xgvt sources land in Phase 5 with property-table reverse mapping.
    const entry = this.getVectorTileShows().find(e => (e.show.layerName ?? e.show.targetName) === layerName)
    const sourceName = entry?.show.targetName ?? layerName
    const props = this.lookupFeatureProperties(sourceName, featureId)
    return {
      id: featureId,
      source: sourceName,
      layer: layerName,
      properties: props ?? {},
    }
  }

  /** Look up properties for `featureId` in `sourceName`'s GeoJSON
   *  feature index. Builds the index on first access using the same
   *  `feature-id-fallback` resolver the compile worker uses
   *  (`feature.id` → `properties.id` → array index), so the IDs the
   *  GPU encoded into the pick texture match the lookup keys here.
   *  Returns null when the source isn't a GeoJSON dataset or the ID
   *  isn't found. */
  lookupFeatureProperties(sourceName: string, featureId: number): Record<string, unknown> | null {
    const data = this.rawDatasets.get(sourceName)
    if (!data) return null
    let index = this._featureIndex.get(sourceName)
    if (!index) {
      index = new Map()
      for (let i = 0; i < data.features.length; i++) {
        const f = data.features[i]
        const id = toU32Id(f.id ?? f.properties?.id ?? i)
        index.set(id, f)
      }
      this._featureIndex.set(sourceName, index)
    }
    const feature = index.get(featureId)
    return (feature?.properties as Record<string, unknown>) ?? null
  }

  /** Convert a CSS-coordinate point to longitude/latitude using the
   *  current camera. Mercator-only; other projections return null and
   *  the dispatcher coerces to [NaN, NaN]. */
  clientToLngLat(clientX: number, clientY: number): readonly [number, number] | null {
    const ctx = this.getCtx()
    if (!ctx) return null
    const canvas = ctx.canvas
    const rect = canvas.getBoundingClientRect()
    // Map CSS coords → physical pixels for unproject (which works in
    // physical-pixel framebuffer space).
    const px = (clientX - rect.left) * (canvas.width / rect.width)
    const py = (clientY - rect.top) * (canvas.height / rect.height)
    const dpr = canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : 1
    const rtc = this.camera.unprojectToZ0(px, py, canvas.width, canvas.height, dpr)
    if (!rtc) return null
    // RTC coords are camera-relative meters in projection space. For
    // Mercator (the most common path) we add cameraCenter to get
    // absolute Mercator meters then invert to lng/lat. Other projections
    // need a per-projection inverse — Phase 5 work.
    if (this.getProjectionName() !== 'mercator') return null
    const R = 6378137
    const merc_x = rtc[0] + this.camera.centerX
    const merc_y = rtc[1] + this.camera.centerY
    const lon = (merc_x / R) * (180 / Math.PI)
    const lat = mercatorYToLat(merc_y)
    return [lon, lat]
  }
}
