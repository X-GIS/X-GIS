// ═══ @xgis/shader-dsl example — pipeline specialization constant (#923) ═══
//
// The ubershader / shader-variant mechanism: ONE authored module, `overrideConst`
// declares a `quality` knob whose value is chosen at PIPELINE CREATION (not module
// build). A branch guarded by `quality > 1` does EXTRA work in the high-quality
// variant and is DEAD-CODE-ELIMINATED BY THE DRIVER in the low-quality one — the DSL
// optimizer keeps the branch OPAQUE (a specialization constant is symbolic until the
// host specializes it), so the same emitted module yields N driver-specialized
// variants.
//
//   • WGSL: emits `override quality: f32 = 1.0;` — the host picks the variant with
//     `device.createRenderPipeline({ ..., constants: { quality: 2.0 } })`.
//   • GLSL ES 3.00 (no `override`): emits a `#ifndef/#define/#endif` default so the
//     module compiles standalone, and the host specializes a variant by re-emitting with
//     `emitGlslModule(m, stage, { overrideValues: { quality: 2.0 } })` — GLSL forbids a
//     prepended `#define` (`#version` must lead), so the emitter places + spells it. Both
//     host shapes derive from `reflect().overrides`.
//
// NOT WebGL2-renderable (`renderable: false`) as a helper module with no entry point —
// the site shows its WGSL + Reflection (the override set). The emit goldens + the
// dedicated override-constants.test.ts pin the `override` line and the `#define` block.

import { module, fn, f32, f32T, If, Var, overrideConst } from '../src/index.ts'
import type { ShaderExample } from './_shared.ts'

// The specialization constant: default 1.0 (the low-quality variant), host-overridable.
const quality = overrideConst('quality', f32T, 1.0)

// Shade a base intensity, doing an extra refinement step ONLY in the high-quality
// variant. The `if` is guarded by the override read, so the driver — not the DSL —
// eliminates it per pipeline variant.
const shade = fn('shade', { base: f32T }, ({ base }) => {
  const acc = Var(base)
  If(quality.node.gt(f32(1)), () => {
    // High-quality refinement — compiled out when the pipeline pins quality <= 1.
    acc.assign(acc.mul(f32(2)).add(f32(0.5)))
  })
  return acc
})

const overrideModule = module({
  overrides: [quality.decl],
  funcs: [shade],
})

export const overrideQuality: ShaderExample = {
  id: 'override-quality',
  title: 'Specialization constant',
  blurb:
    'A pipeline-overridable `quality` constant (#923): WGSL `override` + GLSL `#define`, guarding a branch the DRIVER dead-code-eliminates per variant. One authored module → N driver-specialized pipelines. Shows WGSL + reflection.',
  category: 'generic',
  file: 'override-quality.ts',
  module: overrideModule,
  renderable: false,
}
