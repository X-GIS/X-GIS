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
 *  never a crash) for: no variant, no real stroke expr (constant/zoom/time-
 *  interpolated/default paths — mirrors polygon-shader-cache.ts's own
 *  strokeIsDefault guard), OR anything this slice doesn't support yet
 *  (needsFeatureBuffer, computeBindings, palette gradients, extra preamble
 *  bindings) — #1605 Phase 1b/2/3. */
export function toComposerLineVariant(variant?: ShaderVariantInfo | null): LineVariantSpec | null {
  if (!variant) return null
  if (!variant.strokeExpr || variant.strokeIsDefault) return null
  if (variant.needsFeatureBuffer) return null
  if ((variant.computeBindings?.length ?? 0) > 0) return null
  if ((variant.paletteColorGradients?.length ?? 0) > 0) return null
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
