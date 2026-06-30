// ═══ Polygon fill — RHI Material twins + the routed fill draw (P1.6) ═══
//
// The VTR fill draw lives here (not in vector-tile-renderer.ts, which is at its size ratchet) so the
// renderer stays a thin caller. buildFlatFillMaterials() builds the RHI Material twins of the native
// flat-fill pipelines (flat = cull-none/depth-on, ground = cull-back/depth-off; variant 0 =
// STENCIL_WRITE, 1 = STENCIL_TEST). recordFillDraw() is the single per-tile fill draw: it routes the
// flat/ground non-extrude draw through the Material seam (executeItems, arena vertex/index sub-ranges,
// pick MRT) when __xgisVtrFillViaRhi is on + the pipeline matches a built variant, else the raw draw.

import type { RhiDevice } from '../rhi/rhi'
import { WebGpuDevice, wrapWebGpuBindGroupLayout, wrapWebGpuBuffer, wrapWebGpuBindGroup, wrapWebGpuPass } from '../rhi/rhi-webgpu'
import { Material, executeItems } from './material'

/** The per-tile GPUArena fill buffers recordFillDraw reads (structural — a VTR GPUTile satisfies it). */
export interface FillTileBuffers {
  vertexBuffer: GPUBuffer; polyVertexOffset: number; polyVertexByteLength: number
  zBuffer: GPUBuffer | null; zBufferOffset: number; zBufferByteLength: number
  indexBuffer: GPUBuffer; polyIndexOffset: number; polyIndexByteLength: number
  indexCount: number
}

/** The native fill pipelines that map to the Material variants (set once from PipelineFactory). */
export interface FillRhiState {
  flat: Material | null
  ground: Material | null
  pipes: { write: GPURenderPipeline; test: GPURenderPipeline; groundWrite: GPURenderPipeline; groundTest: GPURenderPipeline } | null
  /** Per-STYLE (data-driven) fills compile their own shader → their own pipeline; this LIVE map
   *  (grown by PipelineFactory as layers are added) routes each per-style fill pipeline to its
   *  Material twin + variant. Checked before the default `pipes` above. */
  perStyle: Map<GPURenderPipeline, { mat: Material; variant: number }> | null
}

export interface FillMaterialInputs {
  device: GPUDevice
  shader: string
  format: string
  sampleCount: number
  bindGroupLayout: GPUBindGroupLayout
  vertexLayout: GPUVertexBufferLayout
  pickEnabled: boolean
}

const toMatVB = (l: GPUVertexBufferLayout) => ({
  stride: Number(l.arrayStride),
  attributes: Array.from(l.attributes).map((a) => ({ location: a.shaderLocation, offset: a.offset, format: a.format as string })),
})

/** Build the flat + ground fill Material twins for one shader (default or per-style). Pickable: the
 *  pick target writeMask is 0xf (the polygon fragment writes the feature id). */
export function buildFlatFillMaterials(inp: FillMaterialInputs): { flat: Material; ground: Material } {
  const rhi: RhiDevice = new WebGpuDevice(inp.device)
  const fmt = inp.format as 'bgra8unorm'
  const groups = [wrapWebGpuBindGroupLayout(inp.bindGroupLayout)]
  const vertexBuffers = [toMatVB(inp.vertexLayout)]
  const colorTargets = inp.pickEnabled
    ? [{ format: fmt, blend: 'alpha' as const }, { format: 'rg32uint' as const, writeMask: 0xf }]
    : [{ format: fmt, blend: 'alpha' as const }]
  const base = { shader: inp.shader, vsEntry: 'vs_main_ecef', fsEntry: 'fs_fill', format: fmt, sampleCount: inp.sampleCount, groups, vertexBuffers, colorTargets }
  const flat = new Material(rhi, {
    ...base, cullMode: 'none',
    variants: [
      { depthCompare: 'less-equal', depthWrite: true, stencil: { compare: 'always', passOp: 'replace', writeMask: 0xff, readMask: 0xff }, label: 'fill-flat-write-rhi' },
      { depthCompare: 'less-equal', depthWrite: true, stencil: { compare: 'equal', passOp: 'keep', writeMask: 0x00, readMask: 0xff }, label: 'fill-flat-test-rhi' },
    ],
  })
  const ground = new Material(rhi, {
    ...base, cullMode: 'back',
    variants: [
      { depthCompare: 'always', depthWrite: false, stencil: { compare: 'always', passOp: 'replace', writeMask: 0xff, readMask: 0xff }, label: 'fill-ground-write-rhi' },
      { depthCompare: 'always', depthWrite: false, stencil: { compare: 'equal', passOp: 'keep', writeMask: 0x00, readMask: 0xff }, label: 'fill-ground-test-rhi' },
    ],
  })
  return { flat, ground }
}

/** The single per-tile fill draw. Routes the flat/ground non-extrude draw through the RHI Material
 *  seam when enabled + the pipeline matches a built variant; otherwise the raw native draw. The
 *  per-draw stencil ref is set one level up by the caller. */
export function recordFillDraw(
  fillRhi: FillRhiState | null,
  encoder: GPURenderPassEncoder | GPURenderBundleEncoder,
  pipeline: GPURenderPipeline,
  tileBg: GPUBindGroup,
  slotOffset: number,
  cached: FillTileBuffers,
  bindZBuffer: boolean,
): void {
  if (fillRhi && !bindZBuffer
      && (globalThis as { __xgisVtrFillViaRhi?: boolean }).__xgisVtrFillViaRhi === true) {
    // Per-style (data-driven) pipelines route via their own cached Material twin; the rest match the
    // default-shader flat/ground pipes.
    const ps = fillRhi.perStyle?.get(pipeline)
    const p = fillRhi.pipes
    const mat = ps ? ps.mat
      : (p && (pipeline === p.write || pipeline === p.test)) ? fillRhi.flat
      : (p && (pipeline === p.groundWrite || pipeline === p.groundTest)) ? fillRhi.ground : null
    const variant = ps ? ps.variant
      : (p && (pipeline === p.write || pipeline === p.groundWrite)) ? 0
      : (p && (pipeline === p.test || pipeline === p.groundTest)) ? 1 : -1
    if (mat && variant >= 0) {
      const g = globalThis as { __xgisVtrFillRhiDraws?: number }; g.__xgisVtrFillRhiDraws = (g.__xgisVtrFillRhiDraws ?? 0) + 1
      executeItems(mat, wrapWebGpuPass(encoder), [{
        variant,
        bindGroups: [wrapWebGpuBindGroup(tileBg)],
        dynamicOffsets: [[slotOffset]],
        vertex: wrapWebGpuBuffer(cached.vertexBuffer), vertexOffset: cached.polyVertexOffset, vertexSize: cached.polyVertexByteLength,
        index: { buffer: wrapWebGpuBuffer(cached.indexBuffer), format: 'uint32', offset: cached.polyIndexOffset, size: cached.polyIndexByteLength },
        count: cached.indexCount, indexed: true,
      }])
      return
    }
  }
  encoder.setPipeline(pipeline)
  encoder.setBindGroup(0, tileBg, [slotOffset])
  encoder.setVertexBuffer(0, cached.vertexBuffer, cached.polyVertexOffset, cached.polyVertexByteLength)
  if (bindZBuffer) encoder.setVertexBuffer(1, cached.zBuffer!, cached.zBufferOffset, cached.zBufferByteLength)
  encoder.setIndexBuffer(cached.indexBuffer, 'uint32', cached.polyIndexOffset, cached.polyIndexByteLength)
  encoder.drawIndexed(cached.indexCount)
}
