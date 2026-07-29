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
import { rasterGridVertexCount } from '../../shaders/dsl/raster'
import { rasterTileBytes, rasterUniformBytes } from '../raster-uniform-slots'
import { hillshadeUniformBytes } from '../hillshade-uniform-slots'
import type { RasterTile } from './raster-material'
import { readsWgsl } from './wgsl-for'
import { peekShaderSources, requestShaderSources } from '../../shaders/emit/shader-emit-pool'

/** One hillshade DEM tile to draw. Structurally identical to a raster tile — the
 *  per-tile bytes are the SHARED raster 'TileUniforms' (writeRasterTileUniform),
 *  and the texture is the DEM. Aliased for call-site clarity. */
export type HillshadeTile = RasterTile

const HS_GLOBAL_BINDING = 3

export class HillshadeDraper {
  /** One Material per `${methodFlag}:${pick}` — the fragment is SPECIALISED to the
   *  layer's hillshade-method (see buildHillshadeModule), so the pipeline carries
   *  only that method's math instead of branching over all five per fragment. Built
   *  lazily on first use: a style draws one method, occasionally two. */
  private readonly materials = new Map<string, Material>()
  private readonly nearestSampler
  /** The hillshade lighting/decode global uniform (HillshadeUniforms @binding 3),
   *  owned here (Material owns only the binding-0 'Uniforms'). One stable buffer,
   *  rewritten per frame — cached bind groups referencing it stay valid. */
  private readonly hsUniform: RhiBuffer
  private readonly hsPickUniform: RhiBuffer
  // Cached global bind group per DEM texture → per material key (the DEM is
  // always nearest, so resampling is not part of the key). Each specialised
  // Material has its OWN global uniform + layout, so the key must carry the
  // method flag as well as pick-ness.
  private readonly globalBGByTex = new Map<GPUTexture | RhiTexture, Map<string, RhiBindGroup>>()
  private readonly viewByTex = new Map<GPUTexture | RhiTexture, RhiTextureView>()

  constructor(
    private readonly rhi: RhiDevice,
    private readonly format: string,
    private readonly sampleCount: number,
  ) {
    this.nearestSampler = { sampler: rhi.createSampler({ mag: 'nearest', min: 'nearest' }) }
    this.hsUniform = rhi.createBuffer({ size: hillshadeUniformBytes(), usage: 'uniform' })
    this.hsPickUniform = rhi.createBuffer({ size: hillshadeUniformBytes(), usage: 'uniform' })
  }

  /** The pipeline for one (method, pick) pair — memoised. `null` = the shader is still
   *  being emitted; the caller draws nothing this frame.
   *
   *  The emit used to run SYNCHRONOUSLY here, inside the first draw(), which froze the
   *  WHOLE map — basemap included — for a measured 2211 ms on `multidirectional`, the
   *  heaviest method and the one the Multidirectional Relief demo authors. Two changes
   *  cut that to ~492 ms (no WGSL on a device that cannot read it, and one lowering
   *  instead of one per stage), and it now runs OFF the main thread entirely.
   *
   *  Skipping frames while it lands costs nothing visible: the layer's DEM tiles are
   *  still in the air (~131-143 KB each over six slots — longer than the emit), so there
   *  was nothing to draw either way. What it buys is that the rest of the map keeps
   *  rendering instead of stalling inside the optimizer fixpoint.
   */
  private materialFor(methodFlag: number, pick: boolean): Material | null {
    const key = `${methodFlag}:${pick ? 'p' : 'n'}`
    const hit = this.materials.get(key)
    if (hit) return hit
    const req = { family: 'hillshade', pick, methodFlag } as const
    const src = peekShaderSources(req)
    if (!src) {
      // Idempotent per key — safe to call every frame until it arrives.
      void requestShaderSources(req, readsWgsl(this.rhi))
      return null
    }
    const mat = new Material(this.rhi, {
      shader: src.wgsl,
      vsEntry: 'vs_tile',
      fsEntry: 'fs_hillshade',
      vsCode: src.vertex,
      fsCode: src.fragment,
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
      // Relief over fills, under labels — a translucent overlay (design §4).
      colorTargets: pick
        ? [{ format: this.format as 'bgra8unorm', blend: 'alpha' }, { format: 'rg32uint' }]
        : [{ format: this.format as 'bgra8unorm', blend: 'alpha' }],
      variants: [
        {
          depthWrite: false,
          depthCompare: 'always',
          label: pick ? 'hillshade-pick-pipeline-rhi' : 'hillshade-pipeline-rhi',
        },
      ],
      pool: { group: 1, slotSize: rasterTileBytes() }, // shared raster TileUniforms (48)
      // Reflect-derived (shared raster 'Uniforms' @binding 0) — was a hardcoded 160;
      // the struct grew 160→176 for the DSFUN cam_ecef_center_l low half (z18+ jitter
      // fix, shared vs_tile), and a stale literal would truncate the UBO write.
      globalUniformSize: rasterUniformBytes(),
    })
    this.materials.set(key, mat)
    return mat
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
    key: string,
  ): RhiBindGroup {
    let m = this.globalBGByTex.get(texture)
    if (!m) {
      m = new Map()
      this.globalBGByTex.set(texture, m)
    }
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
   *  executor. `globalBytes` = the raster 'Uniforms' (vertex + cull, 176 B);
   *  `hsBytes` = the 96-byte 'HillshadeUniforms' (lighting + decode + deriv).
   *  `methodFlag` (hillshadeMethodFlag) picks the SPECIALISED pipeline — the
   *  fragment then carries only that hillshade-method's math. */
  draw(
    pass: import('@xgis/engine').RhiRenderPass,
    globalBytes: BufferSource,
    hsBytes: BufferSource,
    tiles: ReadonlyArray<HillshadeTile>,
    pick = false,
    methodFlag = 0,
    poolBase = 0,
  ): void {
    // Null = the shader is still being emitted off-thread. Draw nothing rather than
    // blocking for it; the renderer keeps the loop warm (awaitingShader) so the frame
    // it lands on is not left to a stray interaction to trigger.
    const material = this.materialFor(methodFlag, pick)
    if (!material) return
    const hsBuf = pick ? this.hsPickUniform : this.hsUniform
    material.writeGlobal(globalBytes)
    this.rhi.writeBuffer(hsBuf, 0, hsBytes)
    const bgKey = `${methodFlag}:${pick ? 'p' : 'n'}`
    const items: DrawItem[] = tiles.map((t) => ({
      variant: 0,
      bindGroups: [this.globalBG(material, hsBuf, t.texture, bgKey), null],
      poolBytes: t.tileBytes,
      count: rasterGridVertexCount(t.gridN),
      indexed: false,
    }))
    executeItems(material, pass, items, poolBase)
  }
}
