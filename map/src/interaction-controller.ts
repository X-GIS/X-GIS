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

import { EARTH } from '@xgis/shared'
import type { Camera } from './camera'
import { unprojectGlobeFromCamera } from './camera'
import { mercatorYToLat } from '@xgis/geo'
import type { GPUContext } from '@xgis/rhi-webgpu'
import type { LayerIdRegistry, XGISLayer, XGISFeature } from './layer'
import type { SceneCommands } from './interpreter'
import type { GeoJSONFeature, GeoJSONFeatureCollection } from '@xgis/data'
import { toU32Id } from '@xgis/data'
import type { RawDataset } from './map-types'

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
  rawDatasets: Map<string, RawDataset>
  /** Shared with XGISMap — same Map instance, by reference. */
  featureIndex: Map<string, Map<number, GeoJSONFeature>>
  /** The WebGPU context, read fresh (populated in run() / runBinary). */
  getCtx(): GPUContext | null
  /** The single-sample pick render-target, read fresh (allocated /
   *  destroyed during render-target setup; null when picking disabled). */
  getPickTexture(): GPUTexture | null
  /** The device the pick render-target was allocated on, read fresh. After a
   *  `map.run()` re-init this lags `getCtx().device` until the first post-swap
   *  frame reallocates the targets; `pickAt` compares the two to skip a
   *  cross-device readback in that window (#792). */
  getPickTextureDevice(): GPUDevice | null
  /** The active projection key, read fresh (mutated by setProjection). */
  getProjectionName(): string
  /** The vectorTileShows array, read fresh (reassigned in rebuildLayers). */
  getVectorTileShows(): VectorTileShowEntry[]
  /** WebGL2 pick seam (#834 M5 s6): the on-demand offscreen pick pass +
   *  synchronous readback (RenderLoop.pickViaRhi). Returns the raw
   *  [featureId, packed] pair or null. Absent on WebGPU-only hosts. */
  pickRhi?(px: number, py: number): [number, number] | null
}

/** Map a CSS-pixel coordinate to the device-pixel index to sample, at the
 *  CENTRE of the CSS pixel (Audit ⑩ B2). `Math.floor(css * scale)` lands on
 *  the TOP-LEFT of a DPR≥2 device-pixel group — a ~0.5px bias at DPR2, ~1px
 *  at DPR3 — so edge clicks miss; adding 0.5 CSS px before scaling samples
 *  the pixel's centre instead. Result is clamped into [0, canvasSpan-1].
 *  Returns -1 when the CSS coord is outside the element (caller → miss).
 *  `cssCoord` is element-relative (clientX - rect.left); `rectSpan` is the
 *  element's CSS width/height; `canvasSpan` is the backing-store width/height. */
export function cssToDevicePixel(cssCoord: number, rectSpan: number, canvasSpan: number): number {
  if (!(cssCoord >= 0) || cssCoord >= rectSpan || rectSpan <= 0) return -1
  const scale = canvasSpan / rectSpan
  const px = Math.floor((cssCoord + 0.5) * scale)
  return px < 0 ? 0 : px >= canvasSpan ? canvasSpan - 1 : px
}

export class InteractionController {
  private readonly camera: Camera
  private readonly layerIds: LayerIdRegistry
  private readonly xgisLayers: Map<string, XGISLayer>
  private readonly rawDatasets: Map<string, RawDataset>
  private readonly _featureIndex: Map<string, Map<number, GeoJSONFeature>>
  private readonly getCtx: () => GPUContext | null
  private readonly getPickTexture: () => GPUTexture | null
  private readonly getPickTextureDevice: () => GPUDevice | null
  private readonly getProjectionName: () => string
  private readonly getVectorTileShows: () => VectorTileShowEntry[]

  /** Reusable MAP_READ buffer pool for pickAt() readbacks. Each entry holds
   *  exactly 8 bytes (one RG32Uint pixel) — a ring keeps mapAsync latency
   *  off the hot path. */
  private pickReadbackPool: { buf: GPUBuffer; inUse: boolean }[] = []

  private readonly pickRhi?: (px: number, py: number) => [number, number] | null

  constructor(deps: InteractionControllerDeps) {
    this.camera = deps.camera
    this.layerIds = deps.layerIds
    this.xgisLayers = deps.xgisLayers
    this.rawDatasets = deps.rawDatasets
    this._featureIndex = deps.featureIndex
    this.getCtx = deps.getCtx
    this.getPickTexture = deps.getPickTexture
    this.getPickTextureDevice = deps.getPickTextureDevice
    this.getProjectionName = deps.getProjectionName
    this.getVectorTileShows = deps.getVectorTileShows
    this.pickRhi = deps.pickRhi
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
  async pickAt(
    clientX: number,
    clientY: number,
  ): Promise<{ featureId: number; layerId: number; instanceId: number } | null> {
    const ctx = this.getCtx()
    if (!ctx) return null
    // #834 M5 s6 — forced-WebGL2: no continuous pick MRT exists (the frame
    // renders to FBO 0); the injected seam renders an on-demand offscreen
    // pick pass and reads the texel synchronously. Same decode + resolve.
    if (ctx.rhi?.backend === 'webgl2') {
      if (!this.pickRhi) return null
      const canvas = ctx.canvas
      const rect = canvas.getBoundingClientRect()
      const px = cssToDevicePixel(clientX - rect.left, rect.width, canvas.width)
      const py = cssToDevicePixel(clientY - rect.top, rect.height, canvas.height)
      if (px < 0 || py < 0) return null
      const rg = this.pickRhi(px, py)
      if (!rg) return null
      const [featureId, packed] = rg
      return this.resolvePick(featureId, packed & 0xffff, (packed >>> 16) & 0xffff)
    }
    const pickTexture = this.getPickTexture()
    if (!pickTexture) return null
    // #792 — the pick RT is minted inside `RenderTargets.ensure*` on that
    // class's tracked device. After a `map.run()` re-init the context swaps to
    // a NEW device but the pick RT is not reallocated until the first
    // post-swap frame's `ensure()`; in that window `pickTexture` still belongs
    // to the DESTROYED prior device while `ctx.device` is the new one, so the
    // `copyTextureToBuffer` below would be a cross-device copy WebGPU rejects.
    // Skip the readback (treat as a miss) until the render targets catch up.
    if (this.getPickTextureDevice() !== ctx.device) return null
    const canvas = ctx.canvas
    const rect = canvas.getBoundingClientRect()
    // Convert CSS coords → physical pixels, sampling the CENTRE of the CSS
    // pixel (Audit ⑩ B2 — a plain floor biases toward the top-left of the
    // DPR≥2 device-pixel group, ~0.5px at DPR2, causing edge misses).
    // Out-of-element → -1 → miss.
    const px = cssToDevicePixel(clientX - rect.left, rect.width, canvas.width)
    const py = cssToDevicePixel(clientY - rect.top, rect.height, canvas.height)
    if (px < 0 || py < 0) return null

    // Rent a staging buffer. Each slot is 8 bytes (one RG32Uint pixel,
    // padded to minimum 256-byte row per WebGPU's copy alignment). We
    // over-allocate to 256 so bytesPerRow is valid.
    let slot = this.pickReadbackPool.find((s) => !s.inUse)
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
      // Re-check: destroy() may have landed during the ~1-frame mapAsync
      // window. If so, getCtx() now returns null (map.ts closes over
      // `_destroyed`). Bail before touching the dead buffer.
      if (!this.getCtx()) return null
      const view = new Uint32Array(slot.buf.getMappedRange(0, 8))
      const featureId = view[0]
      // G channel packs (instanceId << 16) | layerId — see LayerIdRegistry.
      const packed = view[1]
      slot.buf.unmap()
      const layerId = packed & 0xffff
      const instanceId = (packed >>> 16) & 0xffff
      return this.resolvePick(featureId, layerId, instanceId)
    } catch {
      // mapAsync rejects when the buffer is still mapped (rapid re-pick) or
      // the device is lost. Swallow — the slot is freed in finally, and the
      // caller gets null (no-pick) rather than an unhandled rejection.
      return null
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

  /** Resolve a raw pick sample into a hit or a miss. Two reasons for a miss:
   *    1. the no-feature sentinels — featureId=0 ("no feature drew here":
   *       raster-only / background), layerId=0 ("no pickable layer drew
   *       here": graticule, or a `pointer-events:none` writeMask=0 slot that
   *       was never written);
   *    2. Audit ⑩ B1 — the hit landed on a layer the author HID
   *       (`visible === false`). The render pass already filters hidden VT
   *       layers out of BOTH colour and pick (the opaque + label passes write
   *       the pick texture from the same visibility-filtered show list), so
   *       this closes the 1-frame window where the pick texture is still from
   *       the frame BEFORE a `layer.visible = false`, and pins the
   *       invisible⇒unclickable contract at the readback boundary. */
  resolvePick(
    featureId: number,
    layerId: number,
    instanceId: number,
  ): { featureId: number; layerId: number; instanceId: number } | null {
    if (featureId === 0 || layerId === 0) return null
    if (this.getLayerByPickId(layerId)?.visible === false) return null
    return { featureId, layerId, instanceId }
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
    const entry = this.getVectorTileShows().find(
      (e) => (e.show.layerName ?? e.show.targetName) === layerName,
    )
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
    // The feature-index pick path is GeoJSON-only by construction: an index is
    // built solely for FeatureCollection sources. A tile marker here is a
    // caller bug (this method's contract returns null for non-GeoJSON), so the
    // single-hop cast preserves the prior FC-typed access.
    const data = this.rawDatasets.get(sourceName) as GeoJSONFeatureCollection | undefined
    if (!data) return null
    let index = this._featureIndex.get(sourceName)
    if (!index) {
      index = new Map()
      for (let i = 0; i < data.features.length; i++) {
        const f = data.features[i]
        // +1 on the fallback index branch mirrors the encode chokepoint
        // (geojson-compile-worker.ts:resolveIdResolver) so a feature that
        // encodes to i+1 in the GPU pick buffer looks up at i+1 here.
        const id = toU32Id(f.id ?? f.properties?.id ?? i + 1)
        index.set(id, f)
      }
      this._featureIndex.set(sourceName, index)
    }
    const feature = index.get(featureId)
    return (feature?.properties as Record<string, unknown>) ?? null
  }

  /** Convert a CSS-coordinate point to longitude/latitude using the
   *  current camera. Mercator, the flat non-merc set (1/2/6) and globe mode
   *  (true globe 7 + tilted discs promoted to the sphere) return real
   *  coordinates; the UNTILTED disc set (3/4/5) returns null (deferred #9)
   *  and the dispatcher coerces to [NaN, NaN]. */
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
    // Globe mode (#10/#11): the true globe AND the tilted azimuthal discs
    // (promoted to projType 7 + globeMode by the render loop) invert via the
    // ray↔sphere inverse on the RENDERED sphere — the flat-plane unprojects
    // below describe a phantom Mercator plane in globe mode. Off the limb →
    // null (no ground under the cursor), same as a missed ground-plane ray.
    if (this.camera.globeMode) {
      return unprojectGlobeFromCamera(this.camera, px, py, canvas.width, canvas.height, dpr)
    }
    // Flat non-merc set (#8: equirectangular 1 / natural_earth 2 /
    // oblique_mercator 6) is now invertible via the shared camera composer,
    // which recovers TRUE geographic lon/lat (not the wrong flat-Mercator
    // interpretation). The UNTILTED disc set (3/4/5) stays unsupported
    // (return null) pending the flat-disc inverse (#9).
    const pt = this.camera.projType
    if (pt === 1 || pt === 2 || pt === 6) {
      return this.camera.unprojectToLonLat(px, py, canvas.width, canvas.height, dpr)
    }
    const rtc = this.camera.unprojectToZ0(px, py, canvas.width, canvas.height, dpr)
    if (!rtc) return null
    // RTC coords are camera-relative meters in projection space. For
    // Mercator (the most common path) we add cameraCenter to get
    // absolute Mercator meters then invert to lng/lat. Other projections
    // need a per-projection inverse — Phase 5 work.
    if (this.getProjectionName() !== 'mercator') return null
    const R = EARTH.sphereR
    const merc_x = rtc[0] + this.camera.centerX
    const merc_y = rtc[1] + this.camera.centerY
    const lon = (merc_x / R) * (180 / Math.PI)
    const lat = mercatorYToLat(merc_y)
    return [lon, lat]
  }
}
