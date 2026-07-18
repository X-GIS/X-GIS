// ═══ Hillshade adapter over the generic Material (#777 Phase II) ═══
//
// Mirror of raster-material.ts (RasterDraper): builds the generic Material from
// the hillshade shader + owns the hillshade-only bits (the NEAREST DEM sampler,
// the second global uniform HillshadeUniforms, the per-DEM-texture global
// bind-group cache) + turns visible DEM tiles into DrawItems. The
// pipeline/layouts/pool/draw-loop are the shared generic core (material.ts).
//
// Two things differ from raster:
//  1. group 0 carries a SECOND global uniform (HillshadeUniforms @binding 3) —
//     lighting + DEM decode + per-frame deriv scale. Material owns one global
//     buffer (the raster 'Uniforms' @binding 0, for the shared vs_tile); the
//     draper owns the hillshade buffer and binds it at binding 3.
//  2. The DEM is sampled NEAREST always (bilinear over packed RGB corrupts the
//     decode, design §2) — no linear sampler.
// The per-tile pool is the SHARED raster 'TileUniforms' (RasterTile bytes from
// writeRasterTileUniform), so vs_tile + the per-tile packer are reused verbatim.

import type { RhiDevice, RhiBindGroup, RhiTexture, RhiTextureView, RhiBuffer } from '@xgis/engine'
import { wrapWebGpuTextureView } from '@xgis/rhi-webgpu'
import { Material, executeItems, type DrawItem } from '@xgis/engine'
import { emitHillshadeWgsl, buildHillshadeModule, rasterGridVertexCount } from '@xgis/map'
import { rasterTileBytes } from '../raster-uniform-slots'
import { hillshadeUniformBytes } from '../hillshade-uniform-slots'
import type { RasterTile } from './raster-material'
import { emitGlslModule } from '@xgis/shader-dsl'

/** One hillshade DEM tile to draw. Structurally identical to a raster tile — the
 *  per-tile bytes are the SHARED raster 'TileUniforms' (writeRasterTileUniform),
 *  and the texture is the DEM. Aliased for call-site clarity. */
export type HillshadeTile = RasterTile

const HS_GLOBAL_BINDING = 3

export class HillshadeDraper {
  private readonly material: Material // non-pick: single colour target
  private _pickMaterial?: Material // lazy — built on the first pick draw
  private readonly nearestSampler
  /** The hillshade lighting/decode global uniform (HillshadeUniforms @binding 3),
   *  owned here (Material owns only the binding-0 'Uniforms'). One stable buffer,
   *  rewritten per frame — cached bind groups referencing it stay valid. */
  private readonly hsUniform: RhiBuffer
  private readonly hsPickUniform: RhiBuffer
  // Cached global bind group per DEM texture → per `${pick}` key (the DEM is
  // always nearest, so resampling is not part of the key). The non-pick / pick
  // Materials have distinct global uniforms + layouts.
  private readonly globalBGByTex = new Map<GPUTexture | RhiTexture, Map<string, RhiBindGroup>>()
  private readonly viewByTex = new Map<GPUTexture | RhiTexture, RhiTextureView>()

  constructor(
    private readonly rhi: RhiDevice,
    private readonly format: string,
    private readonly sampleCount: number,
  ) {
    const mod = buildHillshadeModule(false)
    this.material = new Material(rhi, {
      shader: emitHillshadeWgsl(false),
      vsEntry: 'vs_tile',
      fsEntry: 'fs_hillshade',
      vsCode: emitGlslModule(mod, 'vertex'),
      fsCode: emitGlslModule(mod, 'fragment'),
      format: format as 'bgra8unorm',
      sampleCount,
      groups: [
        // group 0 carries TWO uniform blocks — on WebGL2 the RHI pairs uniform
        // blocks BY reflection NAME (not binding index), so both MUST be named
        // (raster's single-block group needed none). Names = the GLSL block names
        // (the uniformStruct first arg): 'Uniforms' (shared vertex) + 'HillshadeUniforms'.
        [
          { binding: 0, kind: 'uniform', name: 'Uniforms' },
          { binding: 1, kind: 'texture' },
          { binding: 2, kind: 'sampler' },
          { binding: HS_GLOBAL_BINDING, kind: 'uniform', name: 'HillshadeUniforms' },
        ],
        // The per-tile pool block MUST be named too: once ANY block in the
        // program is bound by name (group 0 above), the unnamed by-declaration-
        // order fallback collides with a named block's index and rebinds it to
        // the wrong UBO point (Uniforms → the 48 B tile buffer → INVALID_OPERATION).
        [{ binding: 0, kind: 'uniform', name: 'TileUniforms' }],
      ],
      // Relief over fills, under labels — a translucent overlay (design §4).
      colorTargets: [{ format: format as 'bgra8unorm', blend: 'alpha' }],
      variants: [{ depthWrite: false, depthCompare: 'always', label: 'hillshade-pipeline-rhi' }],
      pool: { group: 1, slotSize: rasterTileBytes() }, // shared raster TileUniforms (48)
      globalUniformSize: 160, // raster 'Uniforms' (binding 0)
    })
    this.nearestSampler = { sampler: rhi.createSampler({ mag: 'nearest', min: 'nearest' }) }
    this.hsUniform = rhi.createBuffer({ size: hillshadeUniformBytes(), usage: 'uniform' })
    this.hsPickUniform = rhi.createBuffer({ size: hillshadeUniformBytes(), usage: 'uniform' })
  }

  private pickMat(): Material {
    return (this._pickMaterial ??= new Material(this.rhi, {
      shader: emitHillshadeWgsl(true),
      vsEntry: 'vs_tile',
      fsEntry: 'fs_hillshade',
      vsCode: emitGlslModule(buildHillshadeModule(true), 'vertex'),
      fsCode: emitGlslModule(buildHillshadeModule(true), 'fragment'),
      format: this.format as 'bgra8unorm',
      sampleCount: this.sampleCount,
      groups: [
        // group 0 carries TWO uniform blocks — on WebGL2 the RHI pairs uniform
        // blocks BY reflection NAME (not binding index), so both MUST be named
        // (raster's single-block group needed none). Names = the GLSL block names
        // (the uniformStruct first arg): 'Uniforms' (shared vertex) + 'HillshadeUniforms'.
        [
          { binding: 0, kind: 'uniform', name: 'Uniforms' },
          { binding: 1, kind: 'texture' },
          { binding: 2, kind: 'sampler' },
          { binding: HS_GLOBAL_BINDING, kind: 'uniform', name: 'HillshadeUniforms' },
        ],
        // The per-tile pool block MUST be named too: once ANY block in the
        // program is bound by name (group 0 above), the unnamed by-declaration-
        // order fallback collides with a named block's index and rebinds it to
        // the wrong UBO point (Uniforms → the 48 B tile buffer → INVALID_OPERATION).
        [{ binding: 0, kind: 'uniform', name: 'TileUniforms' }],
      ],
      colorTargets: [
        { format: this.format as 'bgra8unorm', blend: 'alpha' },
        { format: 'rg32uint' },
      ],
      variants: [
        { depthWrite: false, depthCompare: 'always', label: 'hillshade-pick-pipeline-rhi' },
      ],
      pool: { group: 1, slotSize: rasterTileBytes() },
      globalUniformSize: 160,
    }))
  }

  private viewOf(texture: GPUTexture | RhiTexture): RhiTextureView {
    let view = this.viewByTex.get(texture)
    if (!view) {
      view =
        typeof (texture as { createView?: unknown }).createView === 'function'
          ? wrapWebGpuTextureView((texture as GPUTexture).createView())
          : this.rhi.createView(texture as RhiTexture)
      this.viewByTex.set(texture, view)
    }
    return view
  }

  private globalBG(
    material: Material,
    hsBuf: RhiBuffer,
    texture: GPUTexture | RhiTexture,
    pick: boolean,
  ): RhiBindGroup {
    let m = this.globalBGByTex.get(texture)
    if (!m) {
      m = new Map()
      this.globalBGByTex.set(texture, m)
    }
    const key = pick ? 'p' : 'n'
    let bg = m.get(key)
    if (!bg) {
      bg = this.rhi.createBindGroup(material.layout(0), [
        { binding: 0, resource: { buffer: material.globalUniform! } },
        { binding: 1, resource: { view: this.viewOf(texture) } },
        { binding: 2, resource: this.nearestSampler },
        { binding: HS_GLOBAL_BINDING, resource: { buffer: hsBuf } },
      ])
      m.set(key, bg)
    }
    return bg
  }

  /** Invalidate a DEM texture's cached view + global bind group(s). The raster
   *  evict / drape lifecycle calls this before freeing the texture (see the
   *  RasterDraper.dropTexture rationale — the caches are keyed by texture OBJECT). */
  dropTexture(texture: RasterTile['texture']): void {
    this.viewByTex.delete(texture)
    this.globalBGByTex.delete(texture)
  }

  /** Build draw items from visible DEM tiles + issue them through the generic
   *  executor. `globalBytes` = the 160-byte raster 'Uniforms' (vertex + cull);
   *  `hsBytes` = the 96-byte 'HillshadeUniforms' (lighting + decode + deriv). */
  draw(
    pass: import('@xgis/engine').RhiRenderPass,
    globalBytes: BufferSource,
    hsBytes: BufferSource,
    tiles: ReadonlyArray<HillshadeTile>,
    pick = false,
    poolBase = 0,
  ): void {
    const material = pick ? this.pickMat() : this.material
    const hsBuf = pick ? this.hsPickUniform : this.hsUniform
    material.writeGlobal(globalBytes)
    this.rhi.writeBuffer(hsBuf, 0, hsBytes)
    const items: DrawItem[] = tiles.map((t) => ({
      variant: 0,
      bindGroups: [this.globalBG(material, hsBuf, t.texture, pick), null],
      poolBytes: t.tileBytes,
      count: rasterGridVertexCount(t.gridN),
      indexed: false,
    }))
    executeItems(material, pass, items, poolBase)
  }
}
