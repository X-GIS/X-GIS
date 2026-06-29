// ═══ Raster adapter over the generic Material ═══
//
// Builds the generic Material from the raster descriptor + owns the raster-only
// bits (linear sampler, the per-texture global bind-group cache) + an inline
// builder that turns visible tiles into generic DrawItems. The pipeline/layouts/
// pool/global-uniform + the draw loop are the shared generic core (material.ts).

import type { RhiDevice, RhiBindGroup, RhiTexture, RhiTextureView } from '../rhi/rhi'
import { wrapWebGpuTextureView } from '../rhi/rhi-webgpu'
import { Material, executeItems, type DrawItem } from './material'
import { emitRasterWgsl, buildRasterModule } from '../../shaders/dsl'
import { emitGlslModule } from '@xgis/shader-dsl'

/** One raster tile to draw: its texture + 64-byte per-tile uniform. The texture is
 *  backend-agnostic: a raw `GPUTexture` (the WebGPU pilot — bridged to a view here)
 *  or an `RhiTexture` (the forced-WebGL2 path — built via `rhi.createTexture`). The
 *  draper resolves either to an `RhiTextureView` once per texture (cached). */
export interface RasterTile { texture: GPUTexture | RhiTexture; tileBytes: Float32Array }

export class RasterDraper {
  private readonly material: Material
  private readonly linearSampler
  private readonly nearestSampler
  // Cached global bind group per texture, holding the linear + nearest variants
  // (Mapbox `raster-resampling` toggles between them; chosen per render call).
  private readonly globalBGByTex = new Map<GPUTexture | RhiTexture, { linear?: RhiBindGroup; nearest?: RhiBindGroup }>()
  /** View cache keyed on the (stable) texture handle — a `GPUTexture.createView()`
   *  or `rhi.createView(rhiTex)` is made ONCE per texture, not per frame. */
  private readonly viewByTex = new Map<GPUTexture | RhiTexture, RhiTextureView>()

  constructor(private readonly rhi: RhiDevice, format: string, sampleCount: number) {
    // WGSL for WebGPU; split GLSL ES for WebGl2Device (createPipeline picks by backend).
    // Raster is texture-only (uniform + texture + sampler) — no storage buffers — so the
    // GLSL emit needs no data-texture emulation, and group 0's single UBO + single texture
    // bind correctly by ORDER (no reflection name needed).
    const rasterModule = buildRasterModule(false)
    this.material = new Material(rhi, {
      shader: emitRasterWgsl(false), vsEntry: 'vs_tile', fsEntry: 'fs_tile',
      vsCode: emitGlslModule(rasterModule, 'vertex'),
      fsCode: emitGlslModule(rasterModule, 'fragment'),
      format: format as 'bgra8unorm', sampleCount,
      groups: [
        [{ binding: 0, kind: 'uniform' }, { binding: 1, kind: 'texture' }, { binding: 2, kind: 'sampler' }],
        [{ binding: 0, kind: 'uniform' }],
      ],
      colorTargets: [{ format: format as 'bgra8unorm', blend: 'alpha' }],
      variants: [{ depthWrite: false, depthCompare: 'always', label: 'raster-pipeline-rhi' }],
      pool: { group: 1, slotSize: 64 },
      globalUniformSize: 160,
    })
    this.linearSampler = { sampler: rhi.createSampler({ mag: 'linear', min: 'linear' }) }
    this.nearestSampler = { sampler: rhi.createSampler({ mag: 'nearest', min: 'nearest' }) }
  }

  /** Resolve a tile texture to an RHI view, once per texture. A WebGPU `GPUTexture`
   *  is bridged via `wrapWebGpuTextureView(createView())`; an `RhiTexture` (forced-
   *  WebGL2) goes through `rhi.createView`. Discriminated by the presence of the native
   *  `.createView` method — the `__rhi` brand is COMPILE-TIME only (the runtime WebGl2Device
   *  handle has no such property), so `'__rhi' in texture` is always false at runtime. */
  private viewOf(texture: GPUTexture | RhiTexture): RhiTextureView {
    let view = this.viewByTex.get(texture)
    if (!view) {
      view = typeof (texture as { createView?: unknown }).createView === 'function'
        ? wrapWebGpuTextureView((texture as GPUTexture).createView())
        : this.rhi.createView(texture as RhiTexture)
      this.viewByTex.set(texture, view)
    }
    return view
  }

  private globalBG(texture: GPUTexture | RhiTexture, nearest: boolean): RhiBindGroup {
    let entry = this.globalBGByTex.get(texture)
    if (!entry) { entry = {}; this.globalBGByTex.set(texture, entry) }
    const key = nearest ? 'nearest' : 'linear'
    let bg = entry[key]
    if (!bg) {
      bg = this.rhi.createBindGroup(this.material.layout(0), [
        { binding: 0, resource: { buffer: this.material.globalUniform! } },
        { binding: 1, resource: { view: this.viewOf(texture) } },
        { binding: 2, resource: nearest ? this.nearestSampler : this.linearSampler },
      ])
      entry[key] = bg
    }
    return bg
  }

  /** Build draw items from visible tiles + issue them through the generic executor. */
  draw(pass: import('../rhi/rhi').RhiRenderPass, globalBytes: BufferSource, tiles: ReadonlyArray<RasterTile>, nearest = false): void {
    this.material.writeGlobal(globalBytes)
    const items: DrawItem[] = tiles.map((t) => ({
      variant: 0,
      bindGroups: [this.globalBG(t.texture, nearest), null],
      poolBytes: t.tileBytes,
      count: 384,
      indexed: false,
    }))
    executeItems(this.material, pass, items)
  }
}
