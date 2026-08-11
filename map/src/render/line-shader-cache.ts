// ═══ Line shader emit — the ShaderVariantInfo → LineVariantSpec bridge ═══
//
// Mirrors polygon-shader-cache.ts's toComposerVariant in PURPOSE (the bridge +
// rejection gate between the renderer's ShaderVariantInfo and the shader-DSL's
// composer-variant shape), but is smaller: line has no async prewarm path
// competing for the same variant key the way PipelineFactory's async pipeline
// builder does for polygon, so a separate WGSL-string memo (polygon's
// buildShader/_buildShaderWgslCache) is not needed here — LineRenderer's own
// Map<variant.key, LineDraper> cache already prevents redundant re-emits.
// #1605 Phase 1 — the line half of the polygon-only @stroke fragment seam.

import { Node } from '@xgis/shader-dsl'
import type { LineVariantSpec } from '../shaders/dsl/line'
import type { ShaderVariantInfo } from './renderer-types'

/** Bridge a renderer-side ShaderVariantInfo to line's composer-variant shape.
 *  Returns null (→ draw the default per-segment-override / layer-colour path,
 *  never a crash) for: no variant, no genuine `@stroke` stage block, OR
 *  anything this slice doesn't support yet (needsFeatureBuffer,
 *  computeBindings, palette gradients, extra preamble bindings) — #1605
 *  Phase 1b/2/3.
 *
 *  Gates on `strokeIsStage`, NOT `!strokeIsDefault`/`strokeExpr` presence —
 *  those two are NOT a "does this need the composer" signal the way they are
 *  for polygon. `strokeExpr` is unconditionally populated by the compiler
 *  (shader-gen.ts) for every layer, stage block or not, and `strokeIsDefault`
 *  is only true when no stroke is declared at all. Polygon's fs_stroke
 *  ALWAYS composes a per-layer expression (its rendering strategy bakes
 *  every colour as a WGSL const) — line has no such "always specialize"
 *  precedent; its existing flat-uniform CPU-resolve path (`writeLayerSlot`)
 *  already renders every constant/data-driven/zoom-interpolated stroke
 *  correctly. Routing an ordinary constant stroke through this composer
 *  broke a previously-green render gate (fixture_translucent_outline,
 *  #1605 PR B round 1) — caught by re-running the FULL local render-gate
 *  suite before merge, not by the unit/compile-time gates, which never
 *  exercised a real compiler-generated (non-synthetic) variant. */
export function toComposerLineVariant(variant?: ShaderVariantInfo | null): LineVariantSpec | null {
  if (!variant) return null
  if (!variant.strokeIsStage || !variant.strokeExpr) return null
  if (variant.needsFeatureBuffer) return null
  if ((variant.computeBindings?.length ?? 0) > 0) return null
  if ((variant.paletteScalarGradients?.length ?? 0) > 0) return null
  const pre = variant.preamble
  if ((pre?.bindings?.length ?? 0) > 0) return null // no new bind slots supported yet
  const hasPreamble = (pre?.consts?.length ?? 0) + (pre?.funcs?.length ?? 0) > 0
  return {
    preamble: hasPreamble ? { consts: pre?.consts, funcs: pre?.funcs } : null,
    strokeExpr: new Node<'vec4<f32>'>(variant.strokeExpr.expr),
    strokePreamble: null, // match() lives inside strokeExpr as a matchExpr Node; emitModule hoists it
    needsFeatureBuffer: false,
  }
}
