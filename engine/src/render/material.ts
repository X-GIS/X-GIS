// ═══ Generic material + executor (RHI render layer) ═══
//
// One descriptor-driven Material + DrawItem + executor that ANY primitive flows
// through. The descriptor (MaterialDesc) captures the per-primitive pipeline / bind
// differences; the DrawItem carries per-draw DATA with no primitive-specific fields.
// Content-blind: shaders, layouts, and formats enter as neutral strings/descriptors.
//
// Differences it spans:
//   • bind groups — N layouts (any mix of uniform/texture/sampler/storage entries).
//   • geometry — procedural (no vertex buffer, draw) OR vertex+index (drawIndexed).
//   • pipeline variants — 1+ (e.g. an opaque/translucent pair differing only in depth).
//   • per-item pooled uniform — optional (a per-item uniform slot; omit if unused).

import type {
  RhiDevice,
  RhiBindGroup,
  RhiBindGroupLayout,
  RhiBindLayoutEntry,
  RhiBuffer,
  RhiPipeline,
  RhiRenderPass,
  RhiTextureFormat,
} from '@xgis/rhi'

/** Per-pipeline-variant state — depth and/or fragment entry differ between a
 *  primitive's variants (e.g. a base vs pattern fragment entry, or an opaque vs
 *  translucent depth pair). */
export interface PipelineVariant {
  /** Omit depthCompare for NO depth-stencil (a pure 2D overlay). */
  depthWrite?: boolean
  depthCompare?: 'always' | 'less' | 'less-equal'
  depthBias?: { constant: number; slopeScale: number; clamp: number }
  /** Per-variant colour-target override — REPLACES the material-level
   *  `colorTargets` for this variant only. Same shader + bind layouts; only the
   *  colour attachment write-mask/blend differs (e.g. a DEPTH-ONLY prepass
   *  variant that masks every colour write while still running the fragment so
   *  it writes the SAME `@builtin(frag_depth)` a later depth-equal colour pass
   *  compares against). Omit to inherit `desc.colorTargets`. */
  colorTargets?: MaterialDesc['colorTargets']
  /** Override the material's fsEntry / vsEntry for this variant (e.g. a variant that
   *  swaps its fragment or vertex entry). */
  fsEntry?: string
  vsEntry?: string
  /** Per-variant GLSL twin overrides. GLSL ES has one `main` per stage, so a
   *  variant that swaps its WGSL entry must carry its own emitted source on the
   *  WebGL2 backend; WebGPU ignores these. */
  vsCode?: string
  fsCode?: string
  /** Optional stencil state (e.g. a clip-mask write/test pair). Forwarded to the
   *  RHI pipeline's depthStencil.stencil; absent = inert stencil. */
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
  /** Split GLSL ES 3.00 source for a WebGL2 backend (one module per stage). Optional +
   *  additive: the WebGPU impl ignores it; the WebGL2 device requires it. Lets the generic
   *  Material build a pipeline on either backend so every primitive can run on WebGL2. */
  vsCode?: string
  fsCode?: string
  format: RhiTextureFormat
  sampleCount: number
  /** Per-group bind layout: entries to CREATE a layout, OR an existing layout to
   *  REUSE (share a layout across materials). */
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
  /** Triangle face culling (material-level, e.g. cull 'back'). Default 'none'. */
  cullMode?: 'none' | 'back' | 'front'
  /** Primitive topology (material-level). Default 'triangle-list'; 'line-list' for a
   *  segment-pair primitive (the graticule overlay). */
  topology?: 'triangle-list' | 'line-list'
  /** 1+ pipeline variants (depth differs). */
  variants: PipelineVariant[]
  /** Optional per-item pooled uniform (a per-item slot). */
  pool?: { group: number; slotSize: number }
  /** Optional material-owned shared uniform (a material-wide frame-global). */
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
  /** Per-group dynamic offsets (parallel to bindGroups) — e.g. bind uniforms with a
   *  per-draw offset into a shared buffer. */
  dynamicOffsets?: ReadonlyArray<number[] | undefined>
  /** Bytes for this item's pooled uniform (only when the material has a pool). */
  poolBytes?: BufferSource
  vertex?: RhiBuffer
  /** Sub-range of the slot-0 vertex buffer (e.g. a per-item range in a shared arena). Default whole buffer. */
  vertexOffset?: number
  vertexSize?: number
  /** Optional slot-1 vertex buffer, with its own sub-range. */
  vertex1?: { buffer: RhiBuffer; offset?: number; size?: number }
  index?: { buffer: RhiBuffer; format: 'uint16' | 'uint32'; offset?: number; size?: number }
  /** vertexCount (procedural) or indexCount (indexed). */
  count: number
  indexed: boolean
  /** Instance count (e.g. instanced quads). Default 1. */
  instanceCount?: number
  /** First vertex (e.g. a per-slice offset). Default 0. */
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
        vsCode: v.vsCode ?? desc.vsCode,
        fsCode: v.fsCode ?? desc.fsCode,
        bindGroupLayouts: this.layouts,
        colorTargets: v.colorTargets ?? desc.colorTargets,
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
        topology: desc.topology,
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

  /** Pooled per-item uniform slot, grown on demand. Grows UP TO `idx` (not just
   *  by one) so a non-contiguous base (executeItems' `poolBase`, #1142) can index
   *  a fresh slot without leaving a hole — contiguous 0,1,2… callers are
   *  unaffected (the loop runs at most once, exactly as the old `if`). */
  poolSlot(idx: number): { write: (b: BufferSource) => void; bg: RhiBindGroup } {
    // Always-on use-after-destroy guard (#2248, ownership P0): destroy() empties
    // poolBufs, so a draw flowing through a destroyed Material would silently
    // RE-CREATE slot buffers here — and the idempotent second destroy() (below)
    // early-returns, leaving that resurrection unreclaimed forever.
    if (this._destroyed) {
      throw new Error('Material.poolSlot: material is destroyed — a draw is using a dead Material')
    }
    while (idx >= this.poolBufs.length) {
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

  /** Release everything this material's CONSTRUCTOR created (#1578).
   *
   *  Materials are not only torn down at end of life: `map.setQuality({msaa})` or
   *  `{picking}` discards six RHI-seam drapers by nulling their references and rebuilds
   *  them at the new sample count. Each dropped draper owned one of these, and nothing
   *  released it — `destroyPipeline` had ZERO production callers repo-wide, while its
   *  siblings `destroyBuffer` / `destroySampler` are called from text, icon and heatmap.
   *  An omission, not a policy.
   *
   *  On WebGL2 that leaked linked GL programs on a live context — `rhi-webgl2.ts`'s own
   *  comment states a program is NOT GC-collected. On WebGPU the pipelines are GC-owned
   *  by spec, but the uniform and pool `GPUBuffer`s free only if their JS wrappers happen
   *  to be collected, and this codebase already has a name for that: the iOS staircase.
   *
   *  `layouts` and `poolBGs` are deliberately NOT released: `rhi.ts` documents bind
   *  groups and bind-group layouts as GC-owned with no `destroy` — "the documented
   *  exception to the create/destroy pairing" — and some layouts are caller-owned here
   *  anyway (the non-array branch of the ctor's `groups` map).
   *
   *  Idempotent: a draper destroyed twice (a quality flip during teardown) must not
   *  double-free. */
  destroy(): void {
    if (this._destroyed) return
    this._destroyed = true
    for (const p of this.pipelines) this.rhi.destroyPipeline(p)
    if (this.globalUniform) this.rhi.destroyBuffer(this.globalUniform)
    for (const b of this.poolBufs) this.rhi.destroyBuffer(b)
    this.poolBufs.length = 0
    this.poolBGs.length = 0
  }
  private _destroyed = false
}

/** Issue draw items through a material + RHI pass. Primitive-agnostic. Returns
 *  the number of draw calls issued (one per item = `items.length`) — the true
 *  draw-call count at the real `pass.draw`/`pass.drawIndexed` site, so a caller
 *  can gate on it. */
export function executeItems(
  material: Material,
  pass: RhiRenderPass,
  items: ReadonlyArray<DrawItem>,
  /** Frame-monotonic base for the pooled per-item uniform slots (#1142). Default
   *  0 = a self-contained batch (the common single-executeItems-per-submit case).
   *  A caller that issues MULTIPLE executeItems on ONE material within a SINGLE
   *  queue.submit — the globe vector drape emits one draw() per slice-layer, all
   *  into the one per-frame submit — MUST advance this by the running item count
   *  so each call binds FRESH pool buffers. Otherwise WebGPU's DEFERRED
   *  queue.writeBuffer overwrites an earlier call's still-in-flight slot
   *  (last-writer-wins at submit) and that draw samples the wrong per-item uniform
   *  — a draped tile renders at another tile's position. (WebGL2 writeBuffer is
   *  immediate, so the bug is WebGPU-only.) */
  poolBase = 0,
): number {
  let poolIdx = 0
  for (const it of items) {
    pass.setPipeline(material.pipeline(it.variant))
    for (let g = 0; g < it.bindGroups.length; g++) {
      const bg = it.bindGroups[g]
      if (bg) pass.setBindGroup(g, bg, it.dynamicOffsets?.[g])
    }
    if (it.poolBytes !== undefined && material.hasPool) {
      const slot = material.poolSlot(poolBase + poolIdx++)
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
  return items.length
}
