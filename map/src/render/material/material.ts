// ═══ Generic material + executor (RHI render layer) ═══
//
// One descriptor-driven Material + DrawItem + executor that BOTH raster and point
// (and, by extension, line/text/icon) flow through. The descriptor captures the
// per-primitive differences; the DrawItem carries per-draw DATA with no primitive-
// specific fields. Replaces the bespoke RasterMaterial + the inline point path.
//
// Differences it spans:
//   • bind groups — N layouts (raster 2, point 1; entries incl. uniform/texture/
//     sampler/storage).
//   • geometry — procedural (no vertex buffer, draw) OR vertex+index (drawIndexed).
//   • pipeline variants — 1+ (point: opaque/translucent differ only in depth).
//   • per-item pooled uniform — optional (raster's per-tile slot); point has none.

import type {
  RhiDevice,
  RhiBindGroup,
  RhiBindGroupLayout,
  RhiBindLayoutEntry,
  RhiBuffer,
  RhiPipeline,
  RhiRenderPass,
  RhiTextureFormat,
} from '@xgis/engine'

/** Per-pipeline-variant state — depth and/or fragment entry differ between a
 *  primitive's variants (line: fs_line vs fs_line_pattern; point: opaque vs
 *  translucent depth). */
export interface PipelineVariant {
  /** Omit depthCompare for NO depth-stencil (icon — pure 2D overlay). */
  depthWrite?: boolean
  depthCompare?: 'always' | 'less' | 'less-equal'
  depthBias?: { constant: number; slopeScale: number; clamp: number }
  /** Override the material's fsEntry / vsEntry for this variant (line pattern; the polygon
   *  extruded variant swaps the vertex entry to vs_main_ecef_extruded). */
  fsEntry?: string
  vsEntry?: string
  /** Per-tile clip-mask stencil state (the VTR fill fallback variants — STENCIL_WRITE / STENCIL_TEST).
   *  Forwarded to the RHI pipeline's depthStencil.stencil; absent = inert stencil (byte-identical). */
  stencil?: {
    compare: 'always' | 'equal'
    passOp: 'keep' | 'replace'
    writeMask: number
    readMask: number
  }
  label?: string
}

export interface MaterialDesc {
  /** WGSL module source (the WebGPU backend's pipeline `code`). */
  shader: string
  vsEntry: string
  fsEntry: string
  /** Split GLSL ES 3.00 source for a WebGL2 backend (emitGlslModule per stage). Optional +
   *  additive: the WebGPU impl ignores it; WebGl2Device requires it. Lets the generic Material
   *  build a pipeline on either backend so every primitive can run on the WebGL2 fallback. */
  vsCode?: string
  fsCode?: string
  format: RhiTextureFormat
  sampleCount: number
  /** Per-group bind layout: entries to CREATE a layout, OR an existing layout to
   *  REUSE (line shares the VTR tile bind-group layout). */
  groups: Array<RhiBindLayoutEntry[] | RhiBindGroupLayout>
  colorTargets: ReadonlyArray<{
    format: RhiTextureFormat
    blend?: 'alpha' | 'premult' | 'additive' | 'max' | 'none'
    writeMask?: number
  }>
  depthFormat?: RhiTextureFormat
  vertexBuffers?: ReadonlyArray<{
    stride: number
    attributes: ReadonlyArray<{ location: number; offset: number; format: string }>
  }>
  /** Triangle face culling (material-level — the VTR ground-fill Material culls 'back'). Default 'none'. */
  cullMode?: 'none' | 'back' | 'front'
  /** 1+ pipeline variants (depth differs). */
  variants: PipelineVariant[]
  /** Optional per-item pooled uniform (raster's per-tile slot). */
  pool?: { group: number; slotSize: number }
  /** Optional material-owned shared uniform (raster's 160B frame-global). */
  globalUniformSize?: number
}

/** Pure per-draw data — no primitive-specific fields. Built by a primitive's
 *  builder; issued by executeItems. */
export interface DrawItem {
  /** Pipeline variant index. */
  variant: number
  /** Bind groups by group index. A `null` slot is filled by the executor from
   *  the per-item pool (the pool group); non-null groups are set verbatim. */
  bindGroups: ReadonlyArray<RhiBindGroup | null>
  /** Per-group dynamic offsets (parallel to bindGroups) — line binds its tile +
   *  layer uniforms with a per-draw offset into a shared buffer. */
  dynamicOffsets?: ReadonlyArray<number[] | undefined>
  /** Bytes for this item's pooled uniform (only when the material has a pool). */
  poolBytes?: BufferSource
  vertex?: RhiBuffer
  /** Sub-range of the slot-0 vertex buffer (the per-tile GPUArena range). Default whole buffer. */
  vertexOffset?: number
  vertexSize?: number
  /** Optional slot-1 vertex buffer (the polygon extrude z-buffer), with its own arena sub-range. */
  vertex1?: { buffer: RhiBuffer; offset?: number; size?: number }
  index?: { buffer: RhiBuffer; format: 'uint16' | 'uint32'; offset?: number; size?: number }
  /** vertexCount (procedural) or indexCount (indexed). */
  count: number
  indexed: boolean
  /** Instance count (line: draw(6, segmentCount)). Default 1. */
  instanceCount?: number
  /** First vertex (text: per-slice draw(count, 1, first, 0)). Default 0. */
  firstVertex?: number
}

export class Material {
  private readonly pipelines: RhiPipeline[]
  private readonly layouts: RhiBindGroupLayout[]
  private readonly poolGroupIdx: number
  private readonly poolSlotSize: number
  private readonly poolBufs: RhiBuffer[] = []
  private readonly poolBGs: RhiBindGroup[] = []
  readonly globalUniform?: RhiBuffer

  constructor(
    readonly rhi: RhiDevice,
    desc: MaterialDesc,
  ) {
    this.layouts = desc.groups.map((g) => (Array.isArray(g) ? rhi.createBindGroupLayout(g) : g))
    this.pipelines = desc.variants.map((v) =>
      rhi.createPipeline({
        code: desc.shader,
        vsEntry: v.vsEntry ?? desc.vsEntry,
        fsEntry: v.fsEntry ?? desc.fsEntry,
        vsCode: desc.vsCode,
        fsCode: desc.fsCode,
        bindGroupLayouts: this.layouts,
        colorTargets: desc.colorTargets,
        depthStencil:
          v.depthCompare || v.stencil
            ? {
                format: desc.depthFormat ?? 'depth24plus-stencil8',
                write: v.depthWrite ?? false,
                compare: v.depthCompare ?? 'always',
                bias: v.depthBias,
                stencil: v.stencil,
              }
            : undefined,
        sampleCount: desc.sampleCount,
        vertexBuffers: desc.vertexBuffers,
        cullMode: desc.cullMode,
        label: v.label,
      }),
    )
    this.poolGroupIdx = desc.pool?.group ?? -1
    this.poolSlotSize = desc.pool?.slotSize ?? 0
    if (desc.globalUniformSize)
      this.globalUniform = rhi.createBuffer({ size: desc.globalUniformSize, usage: 'uniform' })
  }

  get hasPool(): boolean {
    return this.poolGroupIdx >= 0
  }
  get poolGroup(): number {
    return this.poolGroupIdx
  }
  pipeline(variant: number): RhiPipeline {
    return this.pipelines[variant]
  }
  layout(group: number): RhiBindGroupLayout {
    return this.layouts[group]
  }
  writeGlobal(bytes: BufferSource): void {
    if (this.globalUniform) this.rhi.writeBuffer(this.globalUniform, 0, bytes)
  }

  /** Pooled per-item uniform slot, grown on demand. */
  poolSlot(idx: number): { write: (b: BufferSource) => void; bg: RhiBindGroup } {
    if (idx >= this.poolBufs.length) {
      const buf = this.rhi.createBuffer({ size: this.poolSlotSize, usage: 'uniform' })
      this.poolBufs.push(buf)
      this.poolBGs.push(
        this.rhi.createBindGroup(this.layouts[this.poolGroupIdx], [
          { binding: 0, resource: { buffer: buf } },
        ]),
      )
    }
    const buf = this.poolBufs[idx]
    return { write: (b) => this.rhi.writeBuffer(buf, 0, b), bg: this.poolBGs[idx] }
  }
}

/** Issue draw items through a material + RHI pass. Primitive-agnostic. */
export function executeItems(
  material: Material,
  pass: RhiRenderPass,
  items: ReadonlyArray<DrawItem>,
): void {
  let poolIdx = 0
  for (const it of items) {
    pass.setPipeline(material.pipeline(it.variant))
    for (let g = 0; g < it.bindGroups.length; g++) {
      const bg = it.bindGroups[g]
      if (bg) pass.setBindGroup(g, bg, it.dynamicOffsets?.[g])
    }
    if (it.poolBytes !== undefined && material.hasPool) {
      const slot = material.poolSlot(poolIdx++)
      slot.write(it.poolBytes)
      pass.setBindGroup(material.poolGroup, slot.bg)
    }
    if (it.vertex) pass.setVertexBuffer(0, it.vertex, it.vertexOffset, it.vertexSize)
    if (it.vertex1) pass.setVertexBuffer(1, it.vertex1.buffer, it.vertex1.offset, it.vertex1.size)
    const instances = it.instanceCount ?? 1
    if (it.index) {
      pass.setIndexBuffer(it.index.buffer, it.index.format, it.index.offset, it.index.size)
      pass.drawIndexed(it.count, instances)
    } else pass.draw(it.count, instances, it.firstVertex ?? 0)
  }
}
