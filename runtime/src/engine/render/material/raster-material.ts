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
import { rasterTileBytes } from '../raster-uniform-slots'
import { emitGlslModule } from '@xgis/shader-dsl'

/** One raster tile to draw: its texture + 64-byte per-tile uniform. The texture is
 *  backend-agnostic: a raw `GPUTexture` (the WebGPU pilot — bridged to a view here)
 *  or an `RhiTexture` (the forced-WebGL2 path — built via `rhi.createTexture`). The
 *  draper resolves either to an `RhiTextureView` once per texture (cached). */
export interface RasterTile { texture: GPUTexture | RhiTexture; tileBytes: Float32Array }

export class RasterDraper {
  private readonly material: Material  // non-pick: single colour target
  // pick pass: colour + rg32uint pick MRT (writes 0 — raster isn't pickable). LAZY — built on the
  // first pick draw so the non-pick path (incl. the WebGl2 checker, which fail-closes on an
  // rg32uint MRT) never triggers the pick pipeline.
  private _pickMaterial?: Material
  private readonly linearSampler
  private readonly nearestSampler
  // Cached global bind group per texture → per `${pick}${resampling}` key. The non-pick /
  // pick Materials have distinct global uniforms + layouts, and `raster-resampling` toggles
  // the sampler, so the bind group is keyed by both.
  private readonly globalBGByTex = new Map<GPUTexture | RhiTexture, Map<string, RhiBindGroup>>()
  /** View cache keyed on the (stable) texture handle — a `GPUTexture.createView()`
   *  or `rhi.createView(rhiTex)` is made ONCE per texture, not per frame. */
  private readonly viewByTex = new Map<GPUTexture | RhiTexture, RhiTextureView>()

  constructor(private readonly rhi: RhiDevice, private readonly format: string, private readonly sampleCount: number) {
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
      pool: { group: 1, slotSize: rasterTileBytes() }, // 48 — the canonical TileUniforms size
      globalUniformSize: 160,
    })
    this.linearSampler = { sampler: rhi.createSampler({ mag: 'linear', min: 'linear' }) }
    this.nearestSampler = { sampler: rhi.createSampler({ mag: 'nearest', min: 'nearest' }) }
  }

  /** Lazily build the pick-pass Material (colour + rg32uint MRT). Deferred so the non-pick path —
   *  including the WebGl2 checker, which fail-closes on an rg32uint MRT — never builds it. */
  private pickMat(): Material {
    return (this._pickMaterial ??= new Material(this.rhi, {
      shader: emitRasterWgsl(true), vsEntry: 'vs_tile', fsEntry: 'fs_tile',
      vsCode: emitGlslModule(buildRasterModule(true), 'vertex'),
      fsCode: emitGlslModule(buildRasterModule(true), 'fragment'),
      format: this.format as 'bgra8unorm', sampleCount: this.sampleCount,
      groups: [
        [{ binding: 0, kind: 'uniform' }, { binding: 1, kind: 'texture' }, { binding: 2, kind: 'sampler' }],
        [{ binding: 0, kind: 'uniform' }],
      ],
      colorTargets: [{ format: this.format as 'bgra8unorm', blend: 'alpha' }, { format: 'rg32uint' }],
      variants: [{ depthWrite: false, depthCompare: 'always', label: 'raster-pick-pipeline-rhi' }],
      pool: { group: 1, slotSize: rasterTileBytes() }, // 48 — the canonical TileUniforms size
      globalUniformSize: 160,
    }))
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

  private globalBG(material: Material, texture: GPUTexture | RhiTexture, nearest: boolean, pick: boolean): RhiBindGroup {
    let m = this.globalBGByTex.get(texture)
    if (!m) { m = new Map(); this.globalBGByTex.set(texture, m) }
    const key = `${pick ? 'p' : 'n'}${nearest ? 'N' : 'L'}`
    let bg = m.get(key)
    if (!bg) {
      bg = this.rhi.createBindGroup(material.layout(0), [
        { binding: 0, resource: { buffer: material.globalUniform! } },
        { binding: 1, resource: { view: this.viewOf(texture) } },
        { binding: 2, resource: nearest ? this.nearestSampler : this.linearSampler },
      ])
      m.set(key, bg)
    }
    return bg
  }

  /** Build draw items from visible tiles + issue them through the generic executor. */
  draw(pass: import('../rhi/rhi').RhiRenderPass, globalBytes: BufferSource, tiles: ReadonlyArray<RasterTile>, nearest = false, pick = false): void {
    const material = pick ? this.pickMat() : this.material
    material.writeGlobal(globalBytes)
    const items: DrawItem[] = tiles.map((t) => ({
      variant: 0,
      bindGroups: [this.globalBG(material, t.texture, nearest, pick), null],
      poolBytes: t.tileBytes,
      count: 384,
      indexed: false,
    }))
    executeItems(material, pass, items)
  }
}
