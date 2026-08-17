// ═══ Point shader emit — the ShaderVariantInfo → PointVariantSpec bridge ═══
//
// Mirrors line-shader-cache.ts's toComposerLineVariant in purpose and shape, but
// point has TWO independent colour axes (fill AND stroke), so acceptance is
// per-axis: a layer with only a genuine `@color` stage block (no `@stroke`)
// still composes, with the stroke axis left on its default feat_data read.
// #1605 Phase 2 — the point half of the polygon/line fragment seam.

import { Node } from '@xgis/shader-dsl'
import type { PointVariantSpec } from '../shaders/dsl/point'
import type { ShaderVariantInfo } from './renderer-types'

/** Bridge a renderer-side ShaderVariantInfo to point's composer-variant shape.
 *  Returns null (→ draw the default feat_data-read path for BOTH axes, never
 *  a crash) when NEITHER axis is a genuine stage block, or when anything this
 *  slice doesn't support yet (needsFeatureBuffer, computeBindings, palette
 *  gradients, extra preamble bindings) — #1605 Phase 1b/3 territory.
 *
 *  Gates on `fillIsStage`/`strokeIsStage`, NOT `fillExpr`/`strokeExpr`
 *  presence — those are populated unconditionally by the compiler for
 *  virtually every real layer (shader-gen.ts), stage block or not. Routing
 *  an ordinary fill/stroke through this composer repeats the exact regression
 *  line's Phase 1 PR B hit round 1 (fixture_translucent_outline) — gate
 *  strictly on the *Stage flags, and re-run the FULL local render-gate suite
 *  before merge, not just the new spec.
 *
 *  `needsFeatureBuffer` here refers to the COMPILER's per-feature buffer
 *  (a data-driven `match()`/gradient expression), which is unrelated to and
 *  would collide in WGSL naming with point's OWN per-instance feat_data
 *  buffer (always bound, CPU-packed, stride-24) — see PointVariantSpec's own
 *  doc comment in shaders/dsl/point.ts. */
export function toComposerPointVariant(
  variant?: ShaderVariantInfo | null,
): PointVariantSpec | null {
  if (!variant) return null
  const fillStage = Boolean(variant.fillIsStage && variant.fillExpr)
  const strokeStage = Boolean(variant.strokeIsStage && variant.strokeExpr)
  if (!fillStage && !strokeStage) return null
  if (variant.needsFeatureBuffer) return null
  if ((variant.computeBindings?.length ?? 0) > 0) return null
  if ((variant.paletteScalarGradients?.length ?? 0) > 0) return null
  const pre = variant.preamble
  if ((pre?.bindings?.length ?? 0) > 0) return null // no new bind slots supported yet
  const hasPreamble = (pre?.consts?.length ?? 0) + (pre?.funcs?.length ?? 0) > 0
  return {
    preamble: hasPreamble ? { consts: pre?.consts, funcs: pre?.funcs } : null,
    fillExpr: fillStage ? new Node<'vec4<f32>'>(variant.fillExpr!.expr) : null,
    strokeExpr: strokeStage ? new Node<'vec4<f32>'>(variant.strokeExpr!.expr) : null,
    fillPreamble: null, // match() lives inside fillExpr as a matchExpr Node; emitModule hoists it
    strokePreamble: null,
    needsFeatureBuffer: false,
  }
}
