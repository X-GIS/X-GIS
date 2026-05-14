// ═══ GPU Compute Dispatcher ═══
// Runs compute shaders for per-feature expression evaluation.
// Input: storage buffer (feature properties)
// Output: storage buffer (computed values: colors, sizes, etc.)

import type { GPUContext } from './gpu'
import type { ComputeKernel } from '@xgis/compiler'

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

/**
 * Dispatches GPU compute shaders for per-feature data processing.
 */
export class ComputeDispatcher {
  private device: GPUDevice
  private pipelineCache = new Map<string, GPUComputePipeline>()

  constructor(ctx: GPUContext) {
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

    const bindGroup = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: task.inputBuffer } },
        { binding: 1, resource: { buffer: task.outputBuffer } },
      ],
    })

    const pass = encoder.beginComputePass({ label: 'feature-compute' })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.dispatchWorkgroups(Math.ceil(task.featureCount / workgroupSize))
    pass.end()
  }

  /**
   * Generate a WGSL compute shader for per-feature expression evaluation.
   * @param expression WGSL expression string (from wgsl-expr.ts)
   * @param fieldCount Number of f32 fields per feature in the input buffer
   * @param workgroupSize Threads per workgroup
   */
  static generateShader(
    expression: string,
    fieldCount: number,
    workgroupSize = 64,
  ): string {
    return `
@group(0) @binding(0) var<storage, read> feat_data: array<f32>;
@group(0) @binding(1) var<storage, read_write> result: array<f32>;

@compute @workgroup_size(${workgroupSize})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  let feat_idx = idx * ${fieldCount}u;

  // Evaluate expression per feature
  result[idx] = ${expression};
}
`
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
  getOrCreateKernelPipeline(kernel: ComputeKernel): GPUComputePipeline {
    const key = kernelCacheKey(kernel.wgsl, kernel.entryPoint)
    const cached = this.pipelineCache.get(key)
    if (cached) return cached

    const module = this.device.createShaderModule({
      code: kernel.wgsl,
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
    kernel: ComputeKernel,
    inputBuffer: GPUBuffer,
    outputBuffer: GPUBuffer,
    countBuffer: GPUBuffer,
    featureCount: number,
  ): void {
    if (featureCount <= 0) return

    const pipeline = this.getOrCreateKernelPipeline(kernel)

    const bindGroup = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: inputBuffer } },
        { binding: 1, resource: { buffer: outputBuffer } },
        { binding: 2, resource: { buffer: countBuffer } },
      ],
      label: `kernel-bind:${kernel.entryPoint}`,
    })

    const pass = encoder.beginComputePass({
      label: `kernel-pass:${kernel.entryPoint}`,
    })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.dispatchWorkgroups(kernel.dispatchSize(featureCount))
    pass.end()
  }
}
