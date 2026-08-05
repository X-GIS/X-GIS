// ═══ The body epoch — one authority for "which planet are these bytes for?" ═══
//
// The active Body is process-global: `configureBodyConsts` mutates the shared
// `ConstDecl` objects in place at every map construction, and every emit path reads
// `wgslValue` / `cpuValue` AT EMIT TIME. That contract holds fine within one map
// ("call applyBodyOption BEFORE the first shader emit"); it cannot hold ACROSS maps
// sharing a process, which `body-option.test.ts` treats as supported and tests.
//
// Four module-scope caches sat in front of those emits and keyed without the body,
// so a hit served values baked under a previous map's planet (#1568):
//
//   * the compiled CPU projection module      (shaders/dsl/cpu-projections.ts)
//   * the off-thread shader emit results      (shaders/emit/shader-emit-request.ts)
//   * the optimized polygon fill WGSL         (render/pipeline-factory.ts)
//   * the graticule ECEF vertex buffers       (graticule.ts)
//
// The worst is the CPU projection module, because it desynchronises CPU from GPU
// INSIDE ONE FRAME — the GPU artifacts cache IS invalidated (projections.ts's
// `configureProjections` nulls it), so tile selection and raster/label anchors
// computed on Earth while the freshly emitted shaders carried Moon radii. That is
// the codebase's documented dominant bug archetype: two sibling paths that must
// agree, diverging silently.
//
// One epoch, bumped by `configureBodyConsts`, folded into all four keys. A single
// authority is what makes this a small change rather than four independent
// judgement calls — and it is why they belong together: fixing three of four still
// leaves a silent wrong-planet frame.
//
// This module is deliberately a LEAF (its only import is the Epoch class, itself
// import-free). `body-consts.ts` imports the shader-dsl const arrays, so a cache
// under `shaders/` could not read the epoch from there without a cycle.

import { Epoch } from './_cache/versioned-state'

const bodyEpoch = new Epoch()

/** Advance the epoch — called by `configureBodyConsts`, the sole writer of the
 *  body-dependent `ConstDecl` values. Anything cached under the previous value is
 *  now stale by construction. */
export function bumpBodyEpoch(): void {
  bodyEpoch.bump()
}

/** The current epoch. Fold this into any cache key whose VALUE depends on the
 *  active body — a plain integer, cheap enough for a per-emit key. */
export function bodyEpochValue(): number {
  return bodyEpoch.value()
}
