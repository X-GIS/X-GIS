// ═══ RHI — WebGPU backend ═══
//
// Thin wrappers over GPUDevice / GPURenderPassEncoder implementing the RHI.
// One-to-one with native WebGPU, so it adds ~zero overhead and is the reference
// the WebGL2 backend must match (pixel-identical) when it lands.

import type {
  RhiDevice, RhiBuffer, RhiTexture, RhiTextureView, RhiSampler, RhiBindGroup,
  RhiBindGroupLayout, RhiPipeline, RhiRenderPass, RhiBufferDesc, RhiTextureDesc,
  RhiSamplerDesc, RhiBindLayoutEntry, RhiBindEntry, RhiPipelineDesc,
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

class WebGpuRenderPass implements RhiRenderPass {
  constructor(private readonly enc: GPURenderPassEncoder) {}
  setPipeline(p: RhiPipeline): void { this.enc.setPipeline(u<GPURenderPipeline>(p)) }
  setBindGroup(index: number, group: RhiBindGroup, dynamicOffsets?: number[]): void {
    this.enc.setBindGroup(index, u<GPUBindGroup>(group), dynamicOffsets)
  }
  setVertexBuffer(slot: number, buffer: RhiBuffer): void { this.enc.setVertexBuffer(slot, u<GPUBuffer>(buffer)) }
  setIndexBuffer(buffer: RhiBuffer, format: 'uint16' | 'uint32'): void { this.enc.setIndexBuffer(u<GPUBuffer>(buffer), format) }
  draw(vertexCount: number, instanceCount = 1, firstVertex = 0): void { this.enc.draw(vertexCount, instanceCount, firstVertex) }
  drawIndexed(indexCount: number, instanceCount = 1): void { this.enc.drawIndexed(indexCount, instanceCount) }
  setStencilReference(ref: number): void { this.enc.setStencilReference(ref) }
}

/** Wrap a live GPURenderPassEncoder (created by the render loop) as an RHI pass
 *  so renderers record against the interface, not the native encoder. */
export function wrapWebGpuPass(enc: GPURenderPassEncoder): RhiRenderPass {
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

export class WebGpuDevice implements RhiDevice {
  readonly backend = 'webgpu' as const
  constructor(private readonly device: GPUDevice) {}

  createBuffer(desc: RhiBufferDesc): RhiBuffer {
    return wrap(this.device.createBuffer({
      size: desc.size, usage: bufUsage(desc.usage, desc.writable ?? true), label: desc.label,
    })) as unknown as RhiBuffer
  }

  writeBuffer(buffer: RhiBuffer, byteOffset: number, data: BufferSource): void {
    this.device.queue.writeBuffer(u<GPUBuffer>(buffer), byteOffset, data)
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
          blend: t.blend === 'alpha' ? BLEND_ALPHA : t.blend === 'premult' ? BLEND_ALPHA_PREMULT : t.blend === 'additive' ? BLEND_ADDITIVE : undefined,
          writeMask: t.format === 'rg32uint' ? 0 : GPUColorWrite.ALL,
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
      primitive: { topology: 'triangle-list' },
      label: desc.label,
    })) as unknown as RhiPipeline
  }
}
