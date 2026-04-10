// ═══ GPU Compute Dispatcher ═══
// Runs compute shaders for per-feature expression evaluation.
// Input: storage buffer (feature properties)
// Output: storage buffer (computed values: colors, sizes, etc.)

import type { GPUContext } from './gpu'

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
}
