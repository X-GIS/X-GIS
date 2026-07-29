// ═══ Material for the S-111 arrow advection step (#1409) ═══
//
// The pipeline that moves every arrow one frame along the current. It renders into the
// arrow-position ping-pong (arrow-advect-state.ts), never to the screen — the visible thing is
// the catalogue glyph, drawn later from the state this writes.
//
// THE NAMES ARE LOAD-BEARING. WebGL2 binds by NAME, not by slot (rhi.ts #783), so a group-0
// entry whose `name` does not match the shader's resource identifier binds nothing there — and
// it fails on WebGL2 ONLY, which is the backend that renders headlessly here. The list is
// exported so the test can assert it against the EMITTED shader rather than a second copy.
//
// TEXTURE/SAMPLER ORDER IS ALSO LOAD-BEARING. WebGL2 binds a sampler OBJECT to the last texture
// unit it touched (rhi-webgl2.ts:372), so each sampler entry must immediately follow the
// texture it belongs to. Interleaved, not grouped.

import { Material, executeItems, type DrawItem } from '@xgis/engine'
import type {
  RhiDevice,
  RhiBindGroup,
  RhiTextureView,
  RhiSampler,
  RhiRenderPass,
} from '@xgis/engine'
import {
  emitArrowAdvectWgsl,
  emitArrowAdvectGlsl,
  ARROW_ADVECT_VERTEX_COUNT,
} from '../../shaders/dsl/arrow-advect-step'

/** Floats in ArrowAdvectParams: step(4) + seed(4) + range(4). */
export const ARROW_ADVECT_UNIFORM_FLOATS = 12

export const ARROW_ADVECT_BINDINGS = [
  { binding: 0, kind: 'texture', name: 'state_tex' },
  { binding: 1, kind: 'sampler', name: 'state_samp' },
  { binding: 2, kind: 'texture', name: 'u_tex' },
  { binding: 3, kind: 'sampler', name: 'u_samp' },
  { binding: 4, kind: 'texture', name: 'v_tex' },
  { binding: 5, kind: 'sampler', name: 'v_samp' },
  { binding: 6, kind: 'uniform', name: 'ArrowAdvectParams' },
  // Where each arrow belongs (#1419). Read with textureLoad, so it has no sampler and the
  // interleaving rule above does not apply to it.
  { binding: 7, kind: 'texture', name: 'origin_tex' },
] as const

export class ArrowAdvectDraper {
  private readonly material: Material

  constructor(private readonly rhi: RhiDevice) {
    this.material = new Material(rhi, {
      shader: emitArrowAdvectWgsl(),
      vsEntry: 'vs_arrow_advect',
      fsEntry: 'fs_arrow_advect',
      vsCode: emitArrowAdvectGlsl('vertex'),
      fsCode: emitArrowAdvectGlsl('fragment'),
      // The state pair is rgba8unorm unconditionally (arrow-advect-state.ts) — it stores
      // positions, not colour, and its 16-bit-across-two-channels encoding needs no float
      // target. So there is no format agreement to keep and no rebuild-on-change path here.
      format: 'rgba8unorm' as 'bgra8unorm',
      // Single-sample: this renders into the offscreen state pair, never into the MSAA
      // swapchain, and a pipeline's sample count must match its attachment's.
      sampleCount: 1,
      groups: [[...ARROW_ADVECT_BINDINGS]],
      // No blend: the update REPLACES each arrow's position outright.
      colorTargets: [{ format: 'rgba8unorm' as 'bgra8unorm' }],
      // NO DEPTH STATE. `Material` synthesises a depthStencil from a TRUTHY `depthCompare`
      // (material.ts:150), and WebGPU requires a pipeline's attachment state to match the pass
      // it is set on. This pass is colour-only, so declaring one would make every SetPipeline a
      // validation error and the arrows would never move at all — invisible without a GPU,
      // because the step still "succeeds" against a recorder. That is the #1333 postmortem
      // ("the pipeline that was right somewhere else") exactly.
      variants: [{ label: 'arrow-advect-pipeline' }],
      globalUniformSize: ARROW_ADVECT_UNIFORM_FLOATS * 4,
    })
  }

  /** `prev` MUST be the read side while the pass renders into the write side — sampling the
   *  attachment being written is undefined behaviour on both backends. */
  bindGroup(
    prev: RhiTextureView,
    u: RhiTextureView,
    v: RhiTextureView,
    nearest: RhiSampler,
    linear: RhiSampler,
    origin: RhiTextureView,
  ): RhiBindGroup {
    return this.rhi.createBindGroup(this.material.layout(0), [
      { binding: 0, resource: { view: prev } },
      { binding: 1, resource: { sampler: nearest } },
      { binding: 2, resource: { view: u } },
      { binding: 3, resource: { sampler: linear } },
      { binding: 4, resource: { view: v } },
      { binding: 5, resource: { sampler: linear } },
      { binding: 6, resource: { buffer: this.material.globalUniform! } },
      { binding: 7, resource: { view: origin } },
    ])
  }

  draw(pass: RhiRenderPass, globalBytes: BufferSource, bindGroup: RhiBindGroup): void {
    this.material.writeGlobal(globalBytes)
    const items: DrawItem[] = [
      { variant: 0, bindGroups: [bindGroup], count: ARROW_ADVECT_VERTEX_COUNT, indexed: false },
    ]
    executeItems(this.material, pass, items, 0)
  }
}

/** Pack ArrowAdvectParams: step = (x, y, dropRate, dropBump), seed, then the region's texel
 *  range (#1458) — `[base, end)`, the half-open interval this pass is allowed to write. */
export function packArrowAdvectUniform(
  stepX: number,
  stepY: number,
  dropRate: number,
  dropBump: number,
  seed: number,
  base: number,
  end: number,
): Float32Array {
  const out = new Float32Array(ARROW_ADVECT_UNIFORM_FLOATS)
  out[0] = stepX
  out[1] = stepY
  out[2] = dropRate
  out[3] = dropBump
  out[4] = seed
  out[8] = base
  out[9] = end
  return out
}
