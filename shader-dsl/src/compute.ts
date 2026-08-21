// ═══ Shader DSL — the compute runner (`@xgis/shader-dsl/compute`) ═══
//
// One dispatch entry point for a `portable: true` compute kernel, across the backends the
// host might actually have. Deliberately on its OWN subpath, the same split `/dev` and
// `/emit-prod` already make: an emit-only consumer that never imports this module bundles
// ZERO bytes of it, so the GL code here costs nothing to anyone who does not run kernels.
//
// Usage:
//
//   import { createComputeRunner } from '@xgis/shader-dsl/compute'
//
//   const runner = await createComputeRunner(kernelModule, {
//     prefer: ['webgpu', 'webgl2', 'cpu'],   // declared order, tried once
//     gl,                                     // present -> webgl2 is a candidate
//   })
//   runner.backend    // 'webgl2' — which tier actually resolved
//   runner.rejected   // why each earlier candidate was skipped
//   const out = await runner.run(featureValues)   // Float32Array -> Uint32Array
//
// Read `backend`. A silent drop to the CPU tier is a real cliff — 200k invocations is
// ~21 ms and 1M is ~105 ms — and it is precisely the failure three.js documents for its
// own automatic WebGPU→WebGL2 fallback. Pin `prefer` to one entry to make a tier required.

export {
  createComputeRunner,
  type ComputeBackend,
  type ComputeRunner,
  type ComputeRunnerOptions,
  type GpuDeviceLike,
  type RejectedBackend,
} from './core/compute/runner.js'
