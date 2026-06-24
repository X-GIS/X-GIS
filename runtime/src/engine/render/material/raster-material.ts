// ═══ Raster adapter over the generic Material ═══
//
// Builds the generic Material from the raster descriptor + owns the raster-only
// bits (linear sampler, the per-texture global bind-group cache) + an inline
// builder that turns visible tiles into generic DrawItems. The pipeline/layouts/
// pool/global-uniform + the draw loop are the shared generic core (material.ts).

import type { RhiDevice, RhiBindGroup } from '../rhi/rhi'
import { wrapWebGpuTextureView } from '../rhi/rhi-webgpu'
import { Material, executeItems, type DrawItem } from './material'
import { emitRasterWgsl } from '../../shaders/dsl'

/** One raster tile to draw: its texture + 64-byte per-tile uniform. */
export interface RasterTile { texture: GPUTexture; tileBytes: Float32Array }

export class RasterDraper {
  private readonly material: Material
  private readonly samplerEntry
  private readonly globalBGByTex = new Map<GPUTexture, RhiBindGroup>()

  constructor(private readonly rhi: RhiDevice, format: string, sampleCount: number) {
    this.material = new Material(rhi, {
      shader: emitRasterWgsl(false), vsEntry: 'vs_tile', fsEntry: 'fs_tile',
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
    this.samplerEntry = { sampler: rhi.createSampler({ mag: 'linear', min: 'linear' }) }
  }

  private globalBG(texture: GPUTexture): RhiBindGroup {
    let bg = this.globalBGByTex.get(texture)
    if (!bg) {
      bg = this.rhi.createBindGroup(this.material.layout(0), [
        { binding: 0, resource: { buffer: this.material.globalUniform! } },
        { binding: 1, resource: { view: wrapWebGpuTextureView(texture.createView()) } },
        { binding: 2, resource: this.samplerEntry },
      ])
      this.globalBGByTex.set(texture, bg)
    }
    return bg
  }

  /** Build draw items from visible tiles + issue them through the generic executor. */
  draw(pass: import('../rhi/rhi').RhiRenderPass, globalBytes: BufferSource, tiles: ReadonlyArray<RasterTile>): void {
    this.material.writeGlobal(globalBytes)
    const items: DrawItem[] = tiles.map((t) => ({
      variant: 0,
      bindGroups: [this.globalBG(t.texture), null],
      poolBytes: t.tileBytes,
      count: 384,
      indexed: false,
    }))
    executeItems(this.material, pass, items)
  }
}
