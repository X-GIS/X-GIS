// ═══ @xgis/shader-dsl example — compute reduction kernel ═══
//
// A self-contained compute pass: each invocation reduces a fixed-size WINDOW of an input
// storage array into one output element (a segmented sum). Exercises two storage buffers
// (read + read_write), a uniform count, a `@workgroup_size` compute entry, and the
// `reduce()` loop-fold combinator. Emits WGSL + the std430 storage layouts.
//
// NOT WebGL2-renderable (`renderable: false`): GLSL ES 3.00 has no compute / SSBO, so the
// GLSL backend fails-closed on this module. The site shows its WGSL + Reflection only —
// this is the WebGPU/compute face of the same DSL.

import {
  fn, module, f32, u32, reduce,
  f32T, vec3uT, vec4uT,
  If, Return,
  storageBuffer, resource, builtin,
} from '../src/index.ts'
import type { ShaderExample } from './_shared.ts'

// Each invocation sums WINDOW consecutive input elements.
const WINDOW = u32(8)

const inputB = storageBuffer('input', f32T, { group: 0, binding: 0, access: 'read' })
const outputB = storageBuffer('output', f32T, { group: 0, binding: 1, access: 'read_write' })
// .x = number of output elements (one reduced window each).
const params = resource('params', vec4uT, { group: 0, binding: 2 })

const reduceKernel = fn('reduce_windows', { gid: builtin('global_invocation_id', vec3uT) }, ({ gid }) => {
  const idx = gid.x
  If(idx.ge(params.node.x), () => { Return() })

  const base = idx.mul(WINDOW)
  // Fold WINDOW elements: acc starts at 0, loop j in [0, WINDOW), accumulate.
  const sum = reduce(f32(0), u32(0), (j) => j.lt(WINDOW), (acc, j) =>
    acc.add(inputB.at(base.add(j))), u32(1))

  outputB.at(idx).assign(sum)
}, { stage: 'compute', workgroupSize: 64 })

const reductionModule = module({
  bindings: [inputB.binding, outputB.binding, params.binding],
  funcs: [reduceKernel],
})

export const computeReduction: ShaderExample = {
  id: 'compute-reduction',
  title: 'Compute reduction',
  blurb: 'A @workgroup_size compute kernel folding a window of an input storage buffer into one output element with reduce(). WebGPU-only — GLSL ES 3.00 has no compute, so this shows WGSL + reflection.',
  category: 'compute',
  file: 'compute-reduction.ts',
  module: reductionModule,
  renderable: false,
}
