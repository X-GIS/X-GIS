// ═══ WebGL2 compute dispatch (the per-backend counterpart to ComputeDispatcher) ═══
//
// The WebGPU ComputeDispatcher (gpu/compute.ts) runs a per-feature paint kernel as a
// native compute pass. WebGL2 ES 3.00 has no compute, so the SAME kernel — the M2
// compute->fragment-GPGPU lowering (emitGlslModule {emulateCompute}) — runs as a
// FULLSCREEN DRAW into an R32UI offscreen target, one output texel per feature. This is
// the runtime routing the kernel on WebGL2; the shader is the same neutral IR the
// compiler emits (ruling i), emitted to GLSL here. Proven byte-correct vs the CPU oracle
// on a real WebGL2 GPU by playground/e2e/_compute-dispatch-parity.

import {
  emitGlslModule,
  fn,
  module,
  f32,
  vec2,
  vec4,
  If,
  ioStruct,
  builtin,
  location,
  u32T,
  vec2fT,
  vec4fT,
  type ModuleDecl,
} from '@xgis/shader-dsl'
import type { RhiPipeline, RhiBindGroupLayout } from '@xgis/rhi'
import type { WebGl2Device } from '@xgis/rhi-webgl2'

/** The two fields this dispatcher reads off a compiler `ComputeKernel`, typed
 *  structurally over the shader-dsl IR so the adapter needs no @xgis/compiler
 *  import (#929 B3) — any real ComputeKernel satisfies it. */
export interface ComputeKernelLike {
  /** Backend-neutral shader-dsl IR for the kernel (package-responsibilities
   *  ruling i: the compiler returns IR; the runtime emits GLSL here). */
  module: ModuleDecl
  /** f32 slots per feature in the packed feat_data buffer. */
  featureStrideF32: number
}

// The fullscreen-triangle vertex shader, DSL-authored (NOT a raw GLSL string).
// Authored LOCALLY (#929 B) — this adapter used to import the engine's
// overdrawComposeModule just to reuse its vs_full entry, the package's only
// @xgis/engine value import. The twin below is byte-identical to that proven
// entry's emit, pinned by compute-webgl2-vs-parity.test.ts (a drift on either
// side fails the gate).

const VsOut = ioStruct('VsOut', {
  pos: builtin('position', vec4fT),
  uv: location(0, vec2fT),
})

// Oversized fullscreen triangle (3 vertices, NDC −1..3 in each axis) with the
// y-flipped uv — same trick as the OIT / overdraw compose passes.
const vsFull = fn(
  'vs_full',
  { idx: builtin('vertex_index', u32T) },
  (p) => {
    const pos = vec2(-1, -1)
    If(p.idx.eq(1), () => {
      pos.assign(vec2(3, -1))
    }).elif(p.idx.eq(2), () => {
      pos.assign(vec2(-1, 3))
    })
    // y-flip — texture origin top-left, NDC origin bottom-left.
    return VsOut.construct({
      pos: vec4(pos, 0, 1),
      uv: vec2(pos.x.add(1).mul(0.5), f32(1).sub(pos.y.add(1).mul(0.5))),
    })
  },
  { stage: 'vertex' },
)

/** Exported for the vs-parity gate only — pins this local twin byte-identical
 *  to the engine's proven vs_full emit. */
export const fullscreenVsModule: ModuleDecl = module({
  structs: [VsOut.decl],
  funcs: [vsFull],
})

let _vsCache: string | undefined
const fullscreenVsGlsl = (): string => (_vsCache ??= emitGlslModule(fullscreenVsModule, 'vertex'))

/** Per-device pipeline cache keyed on the kernel's emitted fsCode (#782 — the
 *  WebGPU twin caches its pipeline; this path used to link a fresh
 *  WebGLProgram per dispatch, unbounded on repeat dispatch). The vsCode is a
 *  constant, so fsCode alone identifies the pipeline. WeakMap by device: a
 *  program is only valid on the GL context that linked it, and a collected
 *  device drops its cache with it. */
interface CachedKernelPipeline {
  pipeline: RhiPipeline
  layout: RhiBindGroupLayout
}
const _kernelPipelines = new WeakMap<WebGl2Device, Map<string, CachedKernelPipeline>>()

/**
 * Dispatch a per-feature compute kernel on WebGL2 as a fullscreen draw into an R32UI
 * offscreen target. `featData` is the packed feat_data (`kernel.featureStrideF32` floats
 * per feature). Returns the packed-u32 `out_color` per feature (length = feature count) —
 * the same result the WebGPU compute pass writes to its storage buffer.
 */
export function dispatchComputeKernelWebGl2(
  device: WebGl2Device,
  kernel: ComputeKernelLike,
  featData: Float32Array,
): Uint32Array {
  const n = Math.floor(featData.length / kernel.featureStrideF32)
  const wOut = Math.min(n, 2048)
  const hOut = Math.ceil(n / wOut)

  const fsCode = emitGlslModule(kernel.module, 'fragment', { emulateCompute: true })
  let perDevice = _kernelPipelines.get(device)
  if (!perDevice) _kernelPipelines.set(device, (perDevice = new Map()))
  let cached = perDevice.get(fsCode)
  if (!cached) {
    const layout = device.createBindGroupLayout([
      { binding: 0, kind: 'storage', name: 'feat_data' },
    ])
    const pipeline = device.createPipeline({
      code: '', // WGSL — ignored on WebGL2 (the split GLSL vsCode/fsCode are used)
      vsEntry: 'main',
      fsEntry: 'main',
      vsCode: fullscreenVsGlsl(),
      fsCode,
      bindGroupLayouts: [layout],
      colorTargets: [{ format: 'r32uint', blend: 'none' }],
    })
    perDevice.set(fsCode, (cached = { pipeline, layout }))
  }

  const featBuf = device.createBuffer({ usage: 'storage', size: featData.byteLength })
  device.writeBuffer(featBuf, 0, featData)
  const bindGroup = device.createBindGroup(cached.layout, [
    { binding: 0, resource: { buffer: featBuf } },
  ])

  try {
    // u_count.x = N (the discard bounds guard); u_count.y = W_out (the output-row width).
    const out = device.dispatchComputeToR32UI(
      cached.pipeline,
      bindGroup,
      wOut,
      hOut,
      new Uint32Array([n, wOut, 0, 0]),
    )
    // out is wOut*hOut; the first n texels are the per-feature results (rest are padding).
    return out.subarray(0, n)
  } finally {
    // The dispatch is synchronous (readPixels drains the pipe), so the feat
    // buffer is dead the moment it returns (#782 — this used to leak one GL
    // buffer per dispatch). The bind group is GC-owned per the RHI contract.
    device.destroyBuffer(featBuf)
  }
}
