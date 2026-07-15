// ═══ RHI — WebGPU backend ═══
//
// Thin wrappers over GPUDevice / GPURenderPassEncoder implementing the RHI.
// One-to-one with native WebGPU, so it adds ~zero overhead and is the reference
// the WebGL2 backend must match (pixel-identical) when it lands.

import type {
  RhiDevice,
  RhiCaps,
  RhiBuffer,
  RhiTexture,
  RhiTextureView,
  RhiSampler,
  RhiBindGroup,
  RhiBindGroupLayout,
  RhiPipeline,
  RhiRenderPass,
  RhiBufferDesc,
  RhiTextureDesc,
  RhiSamplerDesc,
  RhiBindLayoutEntry,
  RhiBindEntry,
  RhiPipelineDesc,
  RhiRenderPassDesc,
  RhiCommandEncoder,
} from '@xgis/rhi'

// Each opaque handle carries its native object on a `native` field (hidden from
// callers by the opaque RHI types). unwrap() casts back inside this module.
interface Native<T> {
  native: T
}
const wrap = <T>(native: T): Native<T> => ({ native })
const u = <T>(h: unknown): T => (h as Native<T>).native

// Straight (NON-premultiplied) alpha blend — MUST match the renderers' BLEND_ALPHA
// (gpu-shared.ts) byte-for-byte: color uses src-alpha, alpha uses one. (Opaque
// primitives hide a premult/straight mismatch; line AA edges expose it.)
const BLEND_ALPHA: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
}
// Premultiplied (shader emits rgb*a, a) — text/some overlays. srcFactor=one.
const BLEND_ALPHA_PREMULT: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
}
// Additive (heatmap accum — overlapping splats SUM).
const BLEND_ADDITIVE: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
}
// MAX blend — the translucent-line offscreen accumulation (mirrors gpu-shared BLEND_MAX).
const BLEND_MAX: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
}

/** Map the RHI stencil config (or its absence) to the `GPUDepthStencilState`
 *  stencil fields. Absent → the inert STENCIL_DISABLED shape (compare always,
 *  passOp keep, masks 0x00) byte-for-byte. Only compare + passOp vary; failOp /
 *  depthFailOp stay default 'keep' — matching gpu-shared STENCIL_WRITE / _TEST /
 *  _CLIPMASK_*. Pure (no GPUDevice) so the byte-identity is unit-testable. */
export function rhiStencilToGpu(s?: {
  compare: 'always' | 'equal'
  passOp: 'keep' | 'replace'
  writeMask: number
  readMask: number
}): Pick<
  GPUDepthStencilState,
  'stencilFront' | 'stencilBack' | 'stencilWriteMask' | 'stencilReadMask'
> {
  const compare: GPUCompareFunction = s?.compare ?? 'always'
  const passOp: GPUStencilOperation = s?.passOp ?? 'keep'
  return {
    stencilFront: { compare, passOp },
    stencilBack: { compare, passOp },
    stencilWriteMask: s?.writeMask ?? 0x00,
    stencilReadMask: s?.readMask ?? 0x00,
  }
}

/** Map an `RhiRenderPassDesc` to a `GPURenderPassDescriptor` BYTE-IDENTICALLY to
 *  the inline descriptors the passes/ bodies build today — opaque pick MRT,
 *  OIT accum+revealage MRT, MSAA-resolve, the offscreen line pass, the heatmap
 *  r16float 3-pass. Pure: only unwraps view handles, copies the load/store enums,
 *  and converts the RGBA clear array to the `{r,g,b,a}` GPUColor the raw passes
 *  write — no GPUDevice, so the byte-identity is unit-testable (no real GPU),
 *  exactly like rhiStencilToGpu. Optional attachment fields are OMITTED when
 *  undefined so the result matches the raw inline shape field-for-field:
 *  `resolveTarget: undefined` (no MSAA resolve here) and an absent `clearValue`
 *  (load attachment) both map to the same omitted/undefined the raw path uses. */
export function rhiRenderPassToGpu(desc: RhiRenderPassDesc): GPURenderPassDescriptor {
  const dsa = desc.depthStencilAttachment
  return {
    label: desc.label,
    colorAttachments: desc.colorAttachments.map((a): GPURenderPassColorAttachment => ({
      view: u<GPUTextureView>(a.view),
      resolveTarget: a.resolveTarget ? u<GPUTextureView>(a.resolveTarget) : undefined,
      loadOp: a.loadOp,
      storeOp: a.storeOp,
      ...(a.clearValue
        ? {
            clearValue: {
              r: a.clearValue[0],
              g: a.clearValue[1],
              b: a.clearValue[2],
              a: a.clearValue[3],
            },
          }
        : {}),
    })),
    depthStencilAttachment: dsa
      ? {
          view: u<GPUTextureView>(dsa.view),
          ...(dsa.depthLoadOp !== undefined ? { depthLoadOp: dsa.depthLoadOp } : {}),
          ...(dsa.depthStoreOp !== undefined ? { depthStoreOp: dsa.depthStoreOp } : {}),
          ...(dsa.depthClearValue !== undefined ? { depthClearValue: dsa.depthClearValue } : {}),
          ...(dsa.stencilLoadOp !== undefined ? { stencilLoadOp: dsa.stencilLoadOp } : {}),
          ...(dsa.stencilStoreOp !== undefined ? { stencilStoreOp: dsa.stencilStoreOp } : {}),
          ...(dsa.stencilClearValue !== undefined
            ? { stencilClearValue: dsa.stencilClearValue }
            : {}),
        }
      : undefined,
  }
}

function bufUsage(
  usage: RhiBufferDesc['usage'],
  writable: boolean,
  copySrc = false,
): GPUBufferUsageFlags {
  const base =
    usage === 'uniform'
      ? GPUBufferUsage.UNIFORM
      : usage === 'vertex'
        ? GPUBufferUsage.VERTEX
        : usage === 'index'
          ? GPUBufferUsage.INDEX
          : GPUBufferUsage.STORAGE
  // COPY_SRC is OR'd ONLY when copySrc is set (the arena compaction source) — an
  // un-flagged buffer's usage bits are byte-identical to the pre-copySrc map.
  return base | (writable ? GPUBufferUsage.COPY_DST : 0) | (copySrc ? GPUBufferUsage.COPY_SRC : 0)
}

function texUsage(usage: RhiTextureDesc['usage']): GPUTextureUsageFlags {
  let f = 0
  for (const k of usage) {
    f |=
      k === 'sample'
        ? GPUTextureUsage.TEXTURE_BINDING
        : k === 'render'
          ? GPUTextureUsage.RENDER_ATTACHMENT
          : k === 'copy-dst'
            ? GPUTextureUsage.COPY_DST
            : GPUTextureUsage.COPY_SRC
  }
  return f
}

// Wraps EITHER a live render-pass encoder OR a render-BUNDLE encoder — the draw subset
// (setPipeline/setBindGroup/setVertex+IndexBuffer/draw[Indexed]) is identical; only the pass-level
// setStencilReference + end exist on the pass encoder (no-op'd for a bundle, which has no stencil-ref
// and finishes via finish()).
class WebGpuRenderPass implements RhiRenderPass {
  constructor(private readonly enc: GPURenderPassEncoder | GPURenderBundleEncoder) {}
  setPipeline(p: RhiPipeline): void {
    this.enc.setPipeline(u<GPURenderPipeline>(p))
  }
  setBindGroup(index: number, group: RhiBindGroup, dynamicOffsets?: number[]): void {
    // dynamicOffsets is OPTIONAL per the RHI contract — a bind group with no dynamic-offset bindings
    // passes none. WebGPU's setBindGroup(i, g, undefined) THROWS ("cannot convert undefined to a
    // sequence"), so the undefined case MUST call the 2-arg form. (IconDraper — the first Draper to
    // bind a non-dynamic-offset group through executeItems — exposed this.)
    if (dynamicOffsets) this.enc.setBindGroup(index, u<GPUBindGroup>(group), dynamicOffsets)
    else this.enc.setBindGroup(index, u<GPUBindGroup>(group))
  }
  setVertexBuffer(slot: number, buffer: RhiBuffer, offset?: number, size?: number): void {
    this.enc.setVertexBuffer(slot, u<GPUBuffer>(buffer), offset, size)
  }
  setIndexBuffer(
    buffer: RhiBuffer,
    format: 'uint16' | 'uint32',
    offset?: number,
    size?: number,
  ): void {
    this.enc.setIndexBuffer(u<GPUBuffer>(buffer), format, offset, size)
  }
  draw(vertexCount: number, instanceCount = 1, firstVertex = 0): void {
    this.enc.draw(vertexCount, instanceCount, firstVertex)
  }
  drawIndexed(indexCount: number, instanceCount = 1): void {
    this.enc.drawIndexed(indexCount, instanceCount)
  }
  setStencilReference(ref: number): void {
    if ('setStencilReference' in this.enc) this.enc.setStencilReference(ref)
  }
  clearStencil(): void {
    // WebGPU has no mid-pass clear; stencil is cleared via the pass descriptor's
    // `stencilLoadOp` (the WebGPU opaque pass opens a fresh sub-pass per group).
    // The single-pass forced-WebGL2 twin is the only caller — no-op here.
  }
  end(): void {
    if ('end' in this.enc) this.enc.end()
  }
}

/** Wrap a live GPURenderPassEncoder OR a GPURenderBundleEncoder (the render loop's pass / a VTR tile
 *  bundle) as an RHI pass so renderers record against the interface, not the native encoder. */
export function wrapWebGpuPass(enc: GPURenderPassEncoder | GPURenderBundleEncoder): RhiRenderPass {
  return new WebGpuRenderPass(enc)
}

/** Adopt an EXTERNALLY-created texture view (e.g. the image-tile loader's
 *  GPUTexture) as an RHI view — the one legit native→RHI bridge, since textures
 *  enter from outside the device abstraction. */
export function wrapWebGpuTextureView(view: GPUTextureView): RhiTextureView {
  return wrap(view) as unknown as RhiTextureView
}

/** Adopt an EXTERNALLY-created sampler (e.g. the glyph atlas's GPUSampler) as an
 *  RHI sampler — the legit native→RHI bridge for samplers built outside the device
 *  abstraction, mirroring wrapWebGpuTextureView. */
export function wrapWebGpuSampler(sampler: GPUSampler): RhiSampler {
  return wrap(sampler) as unknown as RhiSampler
}

/** Adopt an externally-built GPUBuffer (vertex / index / feature geometry from
 *  the upload path) as an RHI buffer. Bridge for resources built outside the
 *  device abstraction; the full arch builds these via RHI too. */
export function wrapWebGpuBuffer(buffer: GPUBuffer): RhiBuffer {
  return wrap(buffer) as unknown as RhiBuffer
}

/** Recover the native `GPUBuffer` from an RHI buffer — the inverse of
 *  `wrapWebGpuBuffer`. Used at the engine/content boundary where a buffer
 *  CREATED through the RHI (GPUArena's arena buffer) must still be handed to a
 *  not-yet-migrated RAW draw consumer (the VTR fill draw binds `tile.vertexBuffer`
 *  on the raw `GPURenderPassEncoder`; that raw path retires with the VTR cluster).
 *  Identity on WebGPU — the same `GPUBuffer` the wrap holds — so it is byte-
 *  identical to the pre-migration `device.createBuffer` handle. */
export function unwrapWebGpuBuffer(buffer: RhiBuffer): GPUBuffer {
  return u<GPUBuffer>(buffer)
}

/** Adopt an externally-created bind-group layout (line reuses the VTR tile layout
 *  so its pipeline is layout-compatible with VTR-built tile bind groups). */
export function wrapWebGpuBindGroupLayout(layout: GPUBindGroupLayout): RhiBindGroupLayout {
  return wrap(layout) as unknown as RhiBindGroupLayout
}

/** Adopt an externally-built bind group (line's tile/layer groups are built by
 *  the VTR/ring path and passed into drawSegments). */
export function wrapWebGpuBindGroup(group: GPUBindGroup): RhiBindGroup {
  return wrap(group) as unknown as RhiBindGroup
}

/** Wrap a native `GPUCommandEncoder` so offscreen / MRT passes record + submit
 *  through the RHI. begin-pass goes through the byte-identical rhiRenderPassToGpu
 *  mapper; finish submits this encoder's single command buffer (one encoder →
 *  one submit, matching the render loop's per-frame submit). */
class WebGpuCommandEncoder implements RhiCommandEncoder {
  /** Mutable so the REUSED frame encoder (acquireFrameEncoder, #1046 F2) can
   *  rebind this frame's fresh native encoder without allocating a new wrapper. */
  private enc: GPUCommandEncoder
  /** false when this RHI encoder WRAPS an externally-owned native encoder
   *  (the render loop's per-frame `ctx.encoder`): `finish()` must NOT submit
   *  — the loop owns the single submit of the underlying encoder. The
   *  incremental #834 M-B4 seam: a pass records its render pass through this
   *  RHI encoder while the surrounding native passes still use `ctx.encoder`
   *  directly; both target the SAME native encoder, so the single command
   *  stream + submit ordering are preserved. `{ own }` also owns the submit but
   *  wraps a caller-minted encoder (the F2 frame shell mints it, rebinds, submits). */
  private readonly ownsSubmit: boolean
  constructor(
    private readonly device: GPUDevice,
    labelOrWrap?: string | { wrap: GPUCommandEncoder } | { own: GPUCommandEncoder },
  ) {
    if (typeof labelOrWrap === 'object') {
      // { wrap } wraps an externally-owned encoder (no submit); { own } wraps a
      // caller-minted encoder the RHI DOES submit (the F2 frame shell path).
      this.enc = 'wrap' in labelOrWrap ? labelOrWrap.wrap : labelOrWrap.own
      this.ownsSubmit = !('wrap' in labelOrWrap)
    } else {
      this.enc = device.createCommandEncoder(
        labelOrWrap !== undefined ? { label: labelOrWrap } : undefined,
      )
      this.ownsSubmit = true
    }
  }
  /** Rebind the reused frame-encoder wrapper to this frame's fresh native encoder
   *  (#1046 F2, §5.5 — the wrapper is frame-invariant, the native minted per frame). */
  rebind(enc: GPUCommandEncoder): void {
    this.enc = enc
  }
  /** The native encoder — the incremental bridge (mirrors unwrapWebGpuBuffer) that
   *  hands a frame's RHI-sourced encoder to the not-yet-converted raw passes. */
  get nativeEncoder(): GPUCommandEncoder {
    return this.enc
  }
  beginRenderPass(desc: RhiRenderPassDesc): RhiRenderPass {
    return new WebGpuRenderPass(this.enc.beginRenderPass(rhiRenderPassToGpu(desc)))
  }
  copyBufferToBuffer(
    src: RhiBuffer,
    srcOffset: number,
    dst: RhiBuffer,
    dstOffset: number,
    size: number,
  ): void {
    this.enc.copyBufferToBuffer(u<GPUBuffer>(src), srcOffset, u<GPUBuffer>(dst), dstOffset, size)
  }
  finish(): void {
    if (this.ownsSubmit) this.device.queue.submit([this.enc.finish()])
  }
}

/** Wrap the render loop's EXISTING native `GPUCommandEncoder` as an
 *  `RhiCommandEncoder` (#834 M-B4). `finish()` is a no-op — the loop owns the
 *  submit. Lets a WebGPU-frame pass record through the RHI seam incrementally
 *  (same underlying encoder as the yet-unconverted native passes). */
export function wrapWebGpuCommandEncoder(
  device: GPUDevice,
  enc: GPUCommandEncoder,
): RhiCommandEncoder {
  return new WebGpuCommandEncoder(device, { wrap: enc })
}

/** Recover the native `GPUCommandEncoder` from a frame's RHI-sourced encoder
 *  (`acquireFrameEncoder`, #1046 F2) — the incremental bridge (mirrors
 *  `unwrapWebGpuBuffer`) that hands the RHI-created encoder to the not-yet-migrated
 *  raw passes / compute dispatch. Identity on WebGPU (the same native encoder the
 *  wrapper holds), so it is byte-identical to the pre-F2 `device.createCommandEncoder`
 *  handle. The pass-body conversion (F3/P5) retires it. */
export function unwrapWebGpuCommandEncoder(enc: RhiCommandEncoder): GPUCommandEncoder {
  return (enc as WebGpuCommandEncoder).nativeEncoder
}

/** Recover the native `GPUTextureView` from an RHI view — used by the F2 frame
 *  shell to feed the RHI-acquired swapchain view (`acquireScreenView`) to the
 *  not-yet-migrated raw passes / RenderTargets. Identity on WebGPU. */
export function unwrapWebGpuTextureView(view: RhiTextureView): GPUTextureView {
  return u<GPUTextureView>(view)
}

export class WebGpuDevice implements RhiDevice {
  readonly backend = 'webgpu' as const
  /** Native WebGPU capability truths (§2.2). Frozen once at construction; the only
   *  hardware-detected value is `timestampQuery` (the adapter feature the device was
   *  actually created with — `?gpuprof=1` && adapter support). The rest are baseline
   *  WebGPU truths: 4× MSAA, presentable-surface MRT, async pick readback, float
   *  render+blend targets, native compute, deferred (submit-time) execution. */
  readonly caps: RhiCaps
  /** Reused frame-shell wrappers (#1046 F2, §5.5) — created lazily on the first
   *  frame, then rebound each frame so the allocation-paranoid 60 Hz loop never
   *  allocates a wrapper per frame. The NATIVE objects behind them are still minted
   *  every frame (WebGPU requires a fresh swapchain view + command encoder); only
   *  the RHI wrapper is frame-invariant. */
  private _screenView: Native<GPUTextureView> | null = null
  private _frameEncoder: WebGpuCommandEncoder | null = null
  constructor(
    private readonly device: GPUDevice,
    /** The canvas swapchain context — required by `acquireScreenView`. Optional in
     *  unit tests that only exercise resource creation (they never acquire a frame). */
    private readonly context?: GPUCanvasContext,
  ) {
    this.caps = Object.freeze({
      maxSampleCount: 4,
      presentablePassMrt: true,
      pickReadback: 'async',
      floatBlendTargets: true,
      compute: 'native',
      timestampQuery: device.features?.has('timestamp-query') ?? false,
      executionModel: 'deferred',
    } as const)
  }

  // ── Frame shell (#1046 F2 / #991 G2+G3) ──────────────────────────────────────

  /** Acquire this frame's swapchain colour view (G2). A fresh native view is minted
   *  each frame (the swapchain texture rotates); the RHI wrapper is REUSED (§5.5). */
  acquireScreenView(): RhiTextureView {
    // The frame shell only runs on WebGPU, where the canvas context is always present.
    const view = this.context!.getCurrentTexture().createView()
    if (this._screenView) this._screenView.native = view
    else this._screenView = wrap(view)
    return this._screenView as unknown as RhiTextureView
  }

  /** The per-frame command encoder (G3), sourced through the RHI. Mints a fresh
   *  native encoder each frame and rebinds the REUSED wrapper (§5.5); `finish()`
   *  owns the single per-frame submit. */
  acquireFrameEncoder(): RhiCommandEncoder {
    const enc = this.device.createCommandEncoder()
    if (this._frameEncoder) this._frameEncoder.rebind(enc)
    else this._frameEncoder = new WebGpuCommandEncoder(this.device, { own: enc })
    return this._frameEncoder
  }

  createCommandEncoder(label?: string): RhiCommandEncoder {
    return new WebGpuCommandEncoder(this.device, label)
  }

  createBuffer(desc: RhiBufferDesc): RhiBuffer {
    return wrap(
      this.device.createBuffer({
        size: desc.size,
        usage: bufUsage(desc.usage, desc.writable ?? true, desc.copySrc),
        label: desc.label,
      }),
    ) as unknown as RhiBuffer
  }

  writeBuffer(buffer: RhiBuffer, byteOffset: number, data: BufferSource): void {
    this.device.queue.writeBuffer(u<GPUBuffer>(buffer), byteOffset, data)
  }

  destroyBuffer(buffer: RhiBuffer): void {
    u<GPUBuffer>(buffer).destroy()
  }

  unwrapBuffer(buffer: RhiBuffer): GPUBuffer {
    return u<GPUBuffer>(buffer)
  }

  createTexture(desc: RhiTextureDesc): RhiTexture {
    return wrap(
      this.device.createTexture({
        size: { width: desc.width, height: desc.height },
        format: desc.format as GPUTextureFormat,
        usage: texUsage(desc.usage),
        sampleCount: desc.sampleCount ?? 1,
        label: desc.label,
      }),
    ) as unknown as RhiTexture
  }

  writeTexture(
    texture: RhiTexture,
    data: BufferSource,
    bytesPerRow: number,
    width: number,
    height: number,
    x = 0,
    y = 0,
  ): void {
    this.device.queue.writeTexture(
      { texture: u<GPUTexture>(texture), origin: { x, y, z: 0 } },
      data,
      { bytesPerRow },
      { width, height },
    )
  }

  copyExternalImage(
    texture: RhiTexture,
    source: ImageBitmap | HTMLCanvasElement,
    width: number,
    height: number,
  ): void {
    this.device.queue.copyExternalImageToTexture(
      { source },
      { texture: u<GPUTexture>(texture) },
      { width, height },
    )
  }

  destroyTexture(texture: RhiTexture): void {
    u<GPUTexture>(texture).destroy()
  }

  createView(texture: RhiTexture): RhiTextureView {
    return wrap(u<GPUTexture>(texture).createView()) as unknown as RhiTextureView
  }

  createSampler(desc: RhiSamplerDesc): RhiSampler {
    return wrap(
      this.device.createSampler({
        magFilter: desc.mag,
        minFilter: desc.min,
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
        label: desc.label,
      }),
    ) as unknown as RhiSampler
  }

  // GPUSampler is GC-owned — WebGPU exposes no native destroy — so this is a no-op
  // (documented on RhiDevice.destroySampler, #782); the WebGL2 twin deletes the GL sampler.
  destroySampler(_sampler: RhiSampler): void {}

  createBindGroupLayout(entries: RhiBindLayoutEntry[]): RhiBindGroupLayout {
    const vis = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT
    return wrap(
      this.device.createBindGroupLayout({
        entries: entries.map((e): GPUBindGroupLayoutEntry => {
          if (e.kind === 'uniform')
            return {
              binding: e.binding,
              visibility: vis,
              buffer: { type: 'uniform', hasDynamicOffset: !!e.dynamic },
            }
          if (e.kind === 'storage')
            return { binding: e.binding, visibility: vis, buffer: { type: 'read-only-storage' } }
          if (e.kind === 'texture')
            return { binding: e.binding, visibility: GPUShaderStage.FRAGMENT, texture: {} }
          return { binding: e.binding, visibility: GPUShaderStage.FRAGMENT, sampler: {} }
        }),
      }),
    ) as unknown as RhiBindGroupLayout
  }

  createBindGroup(layout: RhiBindGroupLayout, entries: RhiBindEntry[]): RhiBindGroup {
    return wrap(
      this.device.createBindGroup({
        layout: u<GPUBindGroupLayout>(layout),
        entries: entries.map((e): GPUBindGroupEntry => {
          const r = e.resource
          if ('buffer' in r)
            return {
              binding: e.binding,
              resource: { buffer: u<GPUBuffer>(r.buffer), offset: r.offset ?? 0, size: r.size },
            }
          if ('view' in r) return { binding: e.binding, resource: u<GPUTextureView>(r.view) }
          return { binding: e.binding, resource: u<GPUSampler>(r.sampler) }
        }),
      }),
    ) as unknown as RhiBindGroup
  }

  createPipeline(desc: RhiPipelineDesc): RhiPipeline {
    const module = this.device.createShaderModule({ code: desc.code, label: desc.label })
    return wrap(
      this.device.createRenderPipeline({
        layout: this.device.createPipelineLayout({
          bindGroupLayouts: desc.bindGroupLayouts.map((l) => u<GPUBindGroupLayout>(l)),
        }),
        vertex: {
          module,
          entryPoint: desc.vsEntry,
          buffers: desc.vertexBuffers?.map((vb): GPUVertexBufferLayout => ({
            arrayStride: vb.stride,
            attributes: vb.attributes.map((a) => ({
              shaderLocation: a.location,
              offset: a.offset,
              format: a.format as GPUVertexFormat,
            })),
          })),
        },
        fragment: {
          module,
          entryPoint: desc.fsEntry,
          targets: desc.colorTargets.map((t): GPUColorTargetState => ({
            format: t.format as GPUTextureFormat,
            blend:
              t.blend === 'alpha'
                ? BLEND_ALPHA
                : t.blend === 'premult'
                  ? BLEND_ALPHA_PREMULT
                  : t.blend === 'additive'
                    ? BLEND_ADDITIVE
                    : t.blend === 'max'
                      ? BLEND_MAX
                      : undefined,
            writeMask: t.writeMask ?? (t.format === 'rg32uint' ? 0 : 0xf), // 0xf = GPUColorWrite.ALL (literal — the WebGPU global is undefined under node test envs); pickable fills override to 0xf
          })),
        },
        depthStencil: desc.depthStencil
          ? {
              format: desc.depthStencil.format as GPUTextureFormat,
              depthWriteEnabled: desc.depthStencil.write,
              depthCompare: desc.depthStencil.compare,
              ...(desc.depthStencil.bias
                ? {
                    depthBias: desc.depthStencil.bias.constant,
                    depthBiasSlopeScale: desc.depthStencil.bias.slopeScale,
                    depthBiasClamp: desc.depthStencil.bias.clamp,
                  }
                : {}),
              // Stencil: config-driven (per-tile clip mask) or inert STENCIL_DISABLED by
              // default — rhiStencilToGpu maps byte-for-byte to the gpu-shared states.
              ...rhiStencilToGpu(desc.depthStencil.stencil),
            }
          : undefined,
        multisample: { count: desc.sampleCount ?? 1 },
        primitive: { topology: 'triangle-list', cullMode: desc.cullMode ?? 'none' },
        label: desc.label,
      }),
    ) as unknown as RhiPipeline
  }

  // GPURenderPipeline is GC-owned — WebGPU exposes no native destroy — so this is a no-op
  // (documented on RhiDevice.destroyPipeline, #782); the WebGL2 twin deletes the GL program.
  destroyPipeline(_pipeline: RhiPipeline): void {}
}
