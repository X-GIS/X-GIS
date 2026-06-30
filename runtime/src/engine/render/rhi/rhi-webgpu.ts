// ═══ RHI — WebGPU backend ═══
//
// Thin wrappers over GPUDevice / GPURenderPassEncoder implementing the RHI.
// One-to-one with native WebGPU, so it adds ~zero overhead and is the reference
// the WebGL2 backend must match (pixel-identical) when it lands.

import type {
  RhiDevice, RhiBuffer, RhiTexture, RhiTextureView, RhiSampler, RhiBindGroup,
  RhiBindGroupLayout, RhiPipeline, RhiRenderPass, RhiBufferDesc, RhiTextureDesc,
  RhiSamplerDesc, RhiBindLayoutEntry, RhiBindEntry, RhiPipelineDesc,
  RhiRenderPassDesc, RhiCommandEncoder,
} from './rhi'

// Each opaque handle carries its native object on a `native` field (hidden from
// callers by the opaque RHI types). unwrap() casts back inside this module.
interface Native<T> { native: T }
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
export function rhiStencilToGpu(
  s?: { compare: 'always' | 'equal'; passOp: 'keep' | 'replace'; writeMask: number; readMask: number },
): Pick<GPUDepthStencilState, 'stencilFront' | 'stencilBack' | 'stencilWriteMask' | 'stencilReadMask'> {
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
      ...(a.clearValue ? { clearValue: { r: a.clearValue[0], g: a.clearValue[1], b: a.clearValue[2], a: a.clearValue[3] } } : {}),
    })),
    depthStencilAttachment: dsa ? {
      view: u<GPUTextureView>(dsa.view),
      ...(dsa.depthLoadOp !== undefined ? { depthLoadOp: dsa.depthLoadOp } : {}),
      ...(dsa.depthStoreOp !== undefined ? { depthStoreOp: dsa.depthStoreOp } : {}),
      ...(dsa.depthClearValue !== undefined ? { depthClearValue: dsa.depthClearValue } : {}),
      ...(dsa.stencilLoadOp !== undefined ? { stencilLoadOp: dsa.stencilLoadOp } : {}),
      ...(dsa.stencilStoreOp !== undefined ? { stencilStoreOp: dsa.stencilStoreOp } : {}),
      ...(dsa.stencilClearValue !== undefined ? { stencilClearValue: dsa.stencilClearValue } : {}),
    } : undefined,
  }
}

function bufUsage(usage: RhiBufferDesc['usage'], writable: boolean): GPUBufferUsageFlags {
  const base = usage === 'uniform' ? GPUBufferUsage.UNIFORM
    : usage === 'vertex' ? GPUBufferUsage.VERTEX
    : usage === 'index' ? GPUBufferUsage.INDEX
    : GPUBufferUsage.STORAGE
  return base | (writable ? GPUBufferUsage.COPY_DST : 0)
}

function texUsage(usage: RhiTextureDesc['usage']): GPUTextureUsageFlags {
  let f = 0
  for (const k of usage) {
    f |= k === 'sample' ? GPUTextureUsage.TEXTURE_BINDING
      : k === 'render' ? GPUTextureUsage.RENDER_ATTACHMENT
      : k === 'copy-dst' ? GPUTextureUsage.COPY_DST
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
  setPipeline(p: RhiPipeline): void { this.enc.setPipeline(u<GPURenderPipeline>(p)) }
  setBindGroup(index: number, group: RhiBindGroup, dynamicOffsets?: number[]): void {
    // dynamicOffsets is OPTIONAL per the RHI contract — a bind group with no dynamic-offset bindings
    // passes none. WebGPU's setBindGroup(i, g, undefined) THROWS ("cannot convert undefined to a
    // sequence"), so the undefined case MUST call the 2-arg form. (IconDraper — the first Draper to
    // bind a non-dynamic-offset group through executeItems — exposed this.)
    if (dynamicOffsets) this.enc.setBindGroup(index, u<GPUBindGroup>(group), dynamicOffsets)
    else this.enc.setBindGroup(index, u<GPUBindGroup>(group))
  }
  setVertexBuffer(slot: number, buffer: RhiBuffer, offset?: number, size?: number): void { this.enc.setVertexBuffer(slot, u<GPUBuffer>(buffer), offset, size) }
  setIndexBuffer(buffer: RhiBuffer, format: 'uint16' | 'uint32', offset?: number, size?: number): void { this.enc.setIndexBuffer(u<GPUBuffer>(buffer), format, offset, size) }
  draw(vertexCount: number, instanceCount = 1, firstVertex = 0): void { this.enc.draw(vertexCount, instanceCount, firstVertex) }
  drawIndexed(indexCount: number, instanceCount = 1): void { this.enc.drawIndexed(indexCount, instanceCount) }
  setStencilReference(ref: number): void { if ('setStencilReference' in this.enc) this.enc.setStencilReference(ref) }
  end(): void { if ('end' in this.enc) this.enc.end() }
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

/** Adopt an externally-built GPUBuffer (vertex / index / feature geometry from
 *  the upload path) as an RHI buffer. Bridge for resources built outside the
 *  device abstraction; the full arch builds these via RHI too. */
export function wrapWebGpuBuffer(buffer: GPUBuffer): RhiBuffer {
  return wrap(buffer) as unknown as RhiBuffer
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
  private readonly enc: GPUCommandEncoder
  constructor(private readonly device: GPUDevice) { this.enc = device.createCommandEncoder() }
  beginRenderPass(desc: RhiRenderPassDesc): RhiRenderPass {
    return new WebGpuRenderPass(this.enc.beginRenderPass(rhiRenderPassToGpu(desc)))
  }
  finish(): void { this.device.queue.submit([this.enc.finish()]) }
}

export class WebGpuDevice implements RhiDevice {
  readonly backend = 'webgpu' as const
  constructor(private readonly device: GPUDevice) {}

  createCommandEncoder(): RhiCommandEncoder { return new WebGpuCommandEncoder(this.device) }

  createBuffer(desc: RhiBufferDesc): RhiBuffer {
    return wrap(this.device.createBuffer({
      size: desc.size, usage: bufUsage(desc.usage, desc.writable ?? true), label: desc.label,
    })) as unknown as RhiBuffer
  }

  writeBuffer(buffer: RhiBuffer, byteOffset: number, data: BufferSource): void {
    this.device.queue.writeBuffer(u<GPUBuffer>(buffer), byteOffset, data)
  }

  destroyBuffer(buffer: RhiBuffer): void {
    u<GPUBuffer>(buffer).destroy()
  }

  createTexture(desc: RhiTextureDesc): RhiTexture {
    return wrap(this.device.createTexture({
      size: { width: desc.width, height: desc.height },
      format: desc.format as GPUTextureFormat,
      usage: texUsage(desc.usage),
      sampleCount: desc.sampleCount ?? 1,
      label: desc.label,
    })) as unknown as RhiTexture
  }

  writeTexture(texture: RhiTexture, data: BufferSource, bytesPerRow: number, width: number, height: number): void {
    this.device.queue.writeTexture({ texture: u<GPUTexture>(texture) }, data, { bytesPerRow }, { width, height })
  }

  createView(texture: RhiTexture): RhiTextureView {
    return wrap(u<GPUTexture>(texture).createView()) as unknown as RhiTextureView
  }

  createSampler(desc: RhiSamplerDesc): RhiSampler {
    return wrap(this.device.createSampler({
      magFilter: desc.mag, minFilter: desc.min,
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', label: desc.label,
    })) as unknown as RhiSampler
  }

  createBindGroupLayout(entries: RhiBindLayoutEntry[]): RhiBindGroupLayout {
    const vis = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT
    return wrap(this.device.createBindGroupLayout({
      entries: entries.map((e): GPUBindGroupLayoutEntry => {
        if (e.kind === 'uniform') return { binding: e.binding, visibility: vis, buffer: { type: 'uniform', hasDynamicOffset: !!e.dynamic } }
        if (e.kind === 'storage') return { binding: e.binding, visibility: vis, buffer: { type: 'read-only-storage' } }
        if (e.kind === 'texture') return { binding: e.binding, visibility: GPUShaderStage.FRAGMENT, texture: {} }
        return { binding: e.binding, visibility: GPUShaderStage.FRAGMENT, sampler: {} }
      }),
    })) as unknown as RhiBindGroupLayout
  }

  createBindGroup(layout: RhiBindGroupLayout, entries: RhiBindEntry[]): RhiBindGroup {
    return wrap(this.device.createBindGroup({
      layout: u<GPUBindGroupLayout>(layout),
      entries: entries.map((e): GPUBindGroupEntry => {
        const r = e.resource
        if ('buffer' in r) return { binding: e.binding, resource: { buffer: u<GPUBuffer>(r.buffer), offset: r.offset ?? 0, size: r.size } }
        if ('view' in r) return { binding: e.binding, resource: u<GPUTextureView>(r.view) }
        return { binding: e.binding, resource: u<GPUSampler>(r.sampler) }
      }),
    })) as unknown as RhiBindGroup
  }

  createPipeline(desc: RhiPipelineDesc): RhiPipeline {
    const module = this.device.createShaderModule({ code: desc.code, label: desc.label })
    return wrap(this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: desc.bindGroupLayouts.map((l) => u<GPUBindGroupLayout>(l)) }),
      vertex: {
        module, entryPoint: desc.vsEntry,
        buffers: desc.vertexBuffers?.map((vb): GPUVertexBufferLayout => ({
          arrayStride: vb.stride,
          attributes: vb.attributes.map((a) => ({ shaderLocation: a.location, offset: a.offset, format: a.format as GPUVertexFormat })),
        })),
      },
      fragment: {
        module, entryPoint: desc.fsEntry,
        targets: desc.colorTargets.map((t): GPUColorTargetState => ({
          format: t.format as GPUTextureFormat,
          blend: t.blend === 'alpha' ? BLEND_ALPHA : t.blend === 'premult' ? BLEND_ALPHA_PREMULT : t.blend === 'additive' ? BLEND_ADDITIVE : t.blend === 'max' ? BLEND_MAX : undefined,
          writeMask: t.writeMask ?? (t.format === 'rg32uint' ? 0 : 0xf), // 0xf = GPUColorWrite.ALL (literal — the WebGPU global is undefined under node test envs); pickable fills override to 0xf
        })),
      },
      depthStencil: desc.depthStencil ? {
        format: desc.depthStencil.format as GPUTextureFormat,
        depthWriteEnabled: desc.depthStencil.write,
        depthCompare: desc.depthStencil.compare,
        ...(desc.depthStencil.bias ? {
          depthBias: desc.depthStencil.bias.constant,
          depthBiasSlopeScale: desc.depthStencil.bias.slopeScale,
          depthBiasClamp: desc.depthStencil.bias.clamp,
        } : {}),
        // Stencil: config-driven (per-tile clip mask) or inert STENCIL_DISABLED by
        // default — rhiStencilToGpu maps byte-for-byte to the gpu-shared states.
        ...rhiStencilToGpu(desc.depthStencil.stencil),
      } : undefined,
      multisample: { count: desc.sampleCount ?? 1 },
      primitive: { topology: 'triangle-list', cullMode: desc.cullMode ?? 'none' },
      label: desc.label,
    })) as unknown as RhiPipeline
  }
}
