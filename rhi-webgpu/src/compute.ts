// ═══ GPU Compute Dispatcher ═══
// Runs compute shaders for per-feature expression evaluation.
// Input: storage buffer (feature properties)
// Output: storage buffer (computed values: colors, sizes, etc.)

import type { GPUContext } from './gpu'
import type { ComputeKernelContract } from '@xgis/rhi'
// The compiler returns backend-NEUTRAL IR; the RUNTIME emits the shader for the live
// backend (ruling i). This WebGPU dispatcher emits WGSL via emitModule; the WebGL2 path
// (a separate dispatcher) emits GLSL via emitGlslModule({emulateCompute}).
import { emitModule, type ModuleDecl } from '@xgis/shader-dsl'

/** The compute kernel as this WebGPU dispatcher consumes it: the backend-neutral
 *  `ComputeKernelContract` (entryPoint / dispatchSize / …) from @xgis/rhi PLUS the
 *  shader-dsl `module` IR this dispatcher lowers to WGSL via `emitModule`. The
 *  module type lives in @xgis/shader-dsl — a permitted rhi-webgpu dependency — so
 *  the dispatcher stays off the @xgis/compiler import while still reading `.module`
 *  (#929 B3). The compiler's `ComputeKernel` structurally satisfies this. */
type DispatchKernel = ComputeKernelContract & { module: ModuleDecl }

/**
 * A compute task specification.
 */
export interface ComputeTask {
  /** WGSL compute shader source */
  shader: string
  /** Input buffer (feature data) */
  inputBuffer: GPUBuffer
  /** Output buffer (computed results) */
  outputBuffer: GPUBuffer
  /** Number of features to process */
  featureCount: number
  /** Workgroup size (default 64) */
  workgroupSize?: number
}

/** Cache key for a ComputeKernel pipeline. WGSL source alone isn't
 *  enough — two kernels with the same body but different entry-point
 *  names are different pipelines from WebGPU's perspective. The
 *  separator is the literal `\x1F` (Unit Separator) to avoid clashes
 *  with any legal WGSL or identifier characters. */
function kernelCacheKey(wgsl: string, entryPoint: string): string {
  return `${entryPoint}\x1F${wgsl}`
}

// FIX B (#784): Single scratch buffer for writeCount — queue.writeBuffer
// copies synchronously so this is safe on the single JS thread.
const _writeCountScratch = new Uint32Array(1)

/**
 * Dispatches GPU compute shaders for per-feature data processing.
 */
export class ComputeDispatcher {
  private device: GPUDevice
  private pipelineCache = new Map<string, GPUComputePipeline>()

  // FIX C (#784): Bind-group caches keyed by actual buffer object identity
  // (nested WeakMaps) so a replaced/reallocated buffer (new object) causes a
  // cache miss and a fresh bind group is created. Label-based keying is
  // unsafe here because createBuffer() and createFeatDataBuffer() use
  // identical default labels across distinct allocations.
  //
  // Outer key is the GPUComputePipeline so the cached layout stays consistent
  // with the pipeline that was used to create the bind group (different WGSL
  // → different pipeline object → different outer WeakMap entry).
  private _dispatchBGCache = new WeakMap<
    GPUComputePipeline,
    WeakMap<GPUBuffer, WeakMap<GPUBuffer, GPUBindGroup>>
  >()
  private _kernelBGCache = new WeakMap<
    GPUComputePipeline,
    WeakMap<GPUBuffer, WeakMap<GPUBuffer, WeakMap<GPUBuffer, GPUBindGroup>>>
  >()

  // Minimal-shape param (only `.device` is read) so content-layer hosts can
  // construct a dispatcher without threading a full GPUContext.
  constructor(ctx: Pick<GPUContext, 'device'>) {
    this.device = ctx.device
  }

  /**
   * Create a compute pipeline from WGSL source.
   * Caches pipelines by shader source hash.
   */
  getOrCreatePipeline(shader: string): GPUComputePipeline {
    const cached = this.pipelineCache.get(shader)
    if (cached) return cached

    const module = this.device.createShaderModule({
      code: shader,
      label: 'compute-module',
    })

    const pipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: {
        module,
        entryPoint: 'main',
      },
      label: 'compute-pipeline',
    })

    this.pipelineCache.set(shader, pipeline)
    return pipeline
  }

  /**
   * Dispatch a compute task.
   * Encodes into the given command encoder (runs before render passes).
   */
  dispatch(encoder: GPUCommandEncoder, task: ComputeTask): void {
    const workgroupSize = task.workgroupSize ?? 64
    const pipeline = this.getOrCreatePipeline(task.shader)

    let byInput = this._dispatchBGCache.get(pipeline)
    if (!byInput) {
      byInput = new WeakMap()
      this._dispatchBGCache.set(pipeline, byInput)
    }
    let byOutput = byInput.get(task.inputBuffer)
    if (!byOutput) {
      byOutput = new WeakMap()
      byInput.set(task.inputBuffer, byOutput)
    }
    let bindGroup = byOutput.get(task.outputBuffer)
    if (!bindGroup) {
      bindGroup = this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: task.inputBuffer } },
          { binding: 1, resource: { buffer: task.outputBuffer } },
        ],
      })
      byOutput.set(task.outputBuffer, bindGroup)
    }

    const pass = encoder.beginComputePass({ label: 'feature-compute' })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.dispatchWorkgroups(Math.ceil(task.featureCount / workgroupSize))
    pass.end()
  }

  /**
   * Create a GPU storage buffer and upload data.
   */
  createBuffer(data: Float32Array, usage: GPUBufferUsageFlags): GPUBuffer {
    const buffer = this.device.createBuffer({
      size: data.byteLength,
      usage: usage | GPUBufferUsage.COPY_DST,
      label: 'compute-buffer',
    })
    this.device.queue.writeBuffer(buffer, 0, data)
    return buffer
  }

  // ─────────────────────────────────────────────────────────────────
  // ComputeKernel-aware dispatch (P4)
  // ─────────────────────────────────────────────────────────────────
  //
  // The three compute-gen emitters (match / case / interpolate) all
  // produce a 3-binding layout:
  //
  //   @binding(0) feat_data  (storage, read)
  //   @binding(1) out_color  (storage, read_write)
  //   @binding(2) u_count    (uniform, vec4<u32>)
  //
  // and a distinct entry-point name. The legacy `dispatch()` method
  // above is wired to the old 2-binding `main()` shape and stays
  // intact for back-compat. `dispatchKernel` is the new path used by
  // the P4 paint-routing pipeline.

  /**
   * Build (or fetch from cache) a compute pipeline for one
   * ComputeKernel. Cache key is `(wgsl, entryPoint)` — same source
   * with different entry-points produces different pipelines.
   */
  getOrCreateKernelPipeline(kernel: DispatchKernel): GPUComputePipeline {
    // Emit WGSL from the compiler's neutral IR at the WebGPU backend (ruling i).
    const wgsl = emitModule(kernel.module)
    const key = kernelCacheKey(wgsl, kernel.entryPoint)
    const cached = this.pipelineCache.get(key)
    if (cached) return cached

    const module = this.device.createShaderModule({
      code: wgsl,
      label: `compute-module:${kernel.entryPoint}`,
    })

    const pipeline = this.device.createComputePipeline({
      layout: 'auto',
      compute: {
        module,
        entryPoint: kernel.entryPoint,
      },
      label: `compute-pipeline:${kernel.entryPoint}`,
    })

    this.pipelineCache.set(key, pipeline)
    return pipeline
  }

  // ── Buffer factories ─────────────────────────────────────────
  //
  // Three buffer roles the kernel reads/writes. Each helper sets
  // the right `usage` flags; callers shouldn't need to touch the
  // GPUBufferUsage constants directly.

  /** Allocate a 16-byte uniform buffer for the `u_count` binding.
   *  WebGPU's minimum uniform binding size is 16 bytes, so a single
   *  u32 is wrapped as `vec4<u32>` on the WGSL side — the buffer
   *  still holds the count in its first 4 bytes, pads the rest. */
  createCountBuffer(label = 'compute-count'): GPUBuffer {
    return this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label,
    })
  }

  /** Write a feature count into a count buffer created by
   *  `createCountBuffer`. Only the first u32 slot is updated; the
   *  trailing 12 bytes stay at their last value (don't care). */
  writeCount(buffer: GPUBuffer, count: number): void {
    _writeCountScratch[0] = count
    this.device.queue.writeBuffer(buffer, 0, _writeCountScratch.buffer, 0, 4)
  }

  /** Allocate a storage buffer sized for the kernel's per-feature
   *  feat_data array. `strideF32` is `kernel.featureStrideF32`;
   *  `featureCount` is the dispatch target. Buffer is created with
   *  STORAGE | COPY_DST so the runtime can upload Float32Array data
   *  via writeBuffer. A featureCount of 0 yields a 16-byte stub so
   *  the bind group can still be wired (WebGPU rejects 0-sized
   *  bindings). */
  createFeatDataBuffer(
    strideF32: number,
    featureCount: number,
    label = 'compute-feat-data',
  ): GPUBuffer {
    const bytes = Math.max(16, featureCount * Math.max(1, strideF32) * 4)
    return this.device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label,
    })
  }

  /** Allocate a storage buffer sized for one packed-RGBA8 per
   *  feature (the compute kernel writes u32 via pack4x8unorm). The
   *  buffer must be readable from a fragment shader, so STORAGE
   *  alone — COPY_SRC is added so the caller can optionally read
   *  back via mapAsync for debugging. 0-feature case stubbed to
   *  16 bytes (same reason as createFeatDataBuffer). */
  createOutColorBuffer(featureCount: number, label = 'compute-out-color'): GPUBuffer {
    const bytes = Math.max(16, featureCount * 4)
    return this.device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      label,
    })
  }

  /** Upload a Float32Array of feature data into a buffer made by
   *  `createFeatDataBuffer`. Thin convenience around writeBuffer
   *  that takes the typed array's underlying ArrayBuffer. */
  uploadFeatData(buffer: GPUBuffer, data: Float32Array): void {
    if (data.byteLength === 0) return
    this.device.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, data.byteLength)
  }

  /**
   * Dispatch a compute kernel produced by the compiler's compute-gen
   * emitters. The caller is responsible for the lifetime of the
   * supplied buffers; `countBuffer` MUST be a 16-byte uniform buffer
   * with the feature count in its first u32 (the WebGPU minimum for
   * uniform bindings is 16 bytes, hence vec4<u32> on the WGSL side).
   *
   * Workgroup count is taken from `kernel.dispatchSize(featureCount)`
   * so the kernel author's ceiling math is the single source of
   * truth.
   */
  dispatchKernel(
    encoder: GPUCommandEncoder,
    kernel: DispatchKernel,
    inputBuffer: GPUBuffer,
    outputBuffer: GPUBuffer,
    countBuffer: GPUBuffer,
    featureCount: number,
    timestampWrites?: GPUComputePassTimestampWrites | null,
  ): void {
    if (featureCount <= 0) return

    const pipeline = this.getOrCreateKernelPipeline(kernel)

    let kByInput = this._kernelBGCache.get(pipeline)
    if (!kByInput) {
      kByInput = new WeakMap()
      this._kernelBGCache.set(pipeline, kByInput)
    }
    let kByOutput = kByInput.get(inputBuffer)
    if (!kByOutput) {
      kByOutput = new WeakMap()
      kByInput.set(inputBuffer, kByOutput)
    }
    let kByCount = kByOutput.get(outputBuffer)
    if (!kByCount) {
      kByCount = new WeakMap()
      kByOutput.set(outputBuffer, kByCount)
    }
    let bindGroup = kByCount.get(countBuffer)
    if (!bindGroup) {
      bindGroup = this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: inputBuffer } },
          { binding: 1, resource: { buffer: outputBuffer } },
          { binding: 2, resource: { buffer: countBuffer } },
        ],
        label: `kernel-bind:${kernel.entryPoint}`,
      })
      kByCount.set(countBuffer, bindGroup)
    }

    const passDesc: GPUComputePassDescriptor = {
      label: `kernel-pass:${kernel.entryPoint}`,
    }
    if (timestampWrites) passDesc.timestampWrites = timestampWrites
    const pass = encoder.beginComputePass(passDesc)
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.dispatchWorkgroups(kernel.dispatchSize(featureCount))
    pass.end()
  }
}
