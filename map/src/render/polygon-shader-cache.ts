// ═══ Polygon shader emit — the ShaderVariantInfo → WGSL choke point + its memo ═══
//
// Extracted from pipeline-factory.ts (#1568), which is at its LOC ceiling. Nothing
// here changed in the move except the cache key, which now carries the body epoch.
//
// `buildShader` is the SINGLE ShaderVariantInfo → WGSL choke point for both the sync
// and async pipeline builders, which is what makes one key edit sufficient — and
// what made the body-blind key wrong everywhere at once.

import { isPickEnabled } from '@xgis/engine'
import { Node } from '@xgis/shader-dsl'
import type { Stmt } from '@xgis/shader-dsl'
import { emitPolygonWgsl } from '../shaders/dsl/polygon'
import { emitPolygonSplitWgsl } from '../shaders/dsl/polygon-split'
import { polygonWgslId, wgslOnlyId } from '../shaders/baked/ids'
import { bodyEpochValue } from '../body-epoch'
import { bakedWgsl } from './material/wgsl-for'
import type { ShaderVariantInfo } from './renderer-types'

/** Bridge a renderer-side ShaderVariantInfo to the polygon COMPOSER's variant shape
 *  (null = default-uniform slice). Shared by the WGSL emit and the #746 GLSL twins so
 *  both backends compose the exact same variant. */
export function toComposerVariant(
  variant?: ShaderVariantInfo | null,
): Parameters<typeof emitPolygonWgsl>[0] {
  // Default-uniform path (variant absent OR variant carries no preamble +
  // no feat_buffer) — the composer's null-variant emit substitutes the
  // POLYGON_SHADER_SOURCE:565 / 780 default-uniform assigns.
  const pre = variant?.preamble
  const hasPreamble =
    !!pre && (pre.consts?.length ?? 0) + (pre.bindings?.length ?? 0) + (pre.funcs?.length ?? 0) > 0
  if (!variant || (!hasPreamble && !variant.needsFeatureBuffer)) return null

  // Variant-bearing path — feed Node-typed exprs + needsFeatureBuffer into
  // the composer. variant.preamble (module-shape string) still splices
  // post-emit until the Partial<ModuleDecl> migration closes it out.
  // The compiler authors fill/stroke exprs as `@xgis/shader-dsl` IR (its `Expr`
  // is imported from the package, not a local mirror), so `variant.fillExpr.expr`
  // is the runtime Node's own `Expr` type — reconstruct the Node directly, no cast.
  const fillExprNode =
    variant.fillExpr && !variant.fillIsDefault ? new Node<'vec4<f32>'>(variant.fillExpr.expr) : null
  const strokeExprNode =
    variant.strokeExpr && !variant.strokeIsDefault
      ? new Node<'vec4<f32>'>(variant.strokeExpr.expr)
      : null
  // match() colours now live INSIDE fillExpr / strokeExpr as a `matchExpr`
  // Node (the compiler dropped the separate WGSL-string preamble). emitModule's
  // lowerModule pass hoists each matchExpr into a `var + switch` ahead of the
  // assign automatically, so the composer needs no explicit preamble Stmts.
  const fillPreamble: readonly Stmt[] | null = null
  const strokePreamble: readonly Stmt[] | null = null
  // The composer's fillExpr expects Node<'vec4<f32>'>; the runtime Node
  // class carries the same {op:'construct'|...} Expr shape that the
  // compiler-side NodeLike captures, so the constructor call is the bridge.
  // The compiler authors every specialized const / binding / helper fn as IR
  // decls (variant.preamble: Partial<ModuleDecl>); the composer spreads them
  // into the base module — no post-emit WGSL-string splice.
  return {
    preamble: variant.preamble ?? null,
    fillExpr: fillExprNode,
    strokeExpr: strokeExprNode,
    fillPreamble,
    strokePreamble,
    needsFeatureBuffer: variant.needsFeatureBuffer,
  }
}

/** F4 — WGSL emit memo, keyed by the pipeline cache key (ShaderVariantInfo.key,
 *  or `__base__` for the null-variant base shader) + pickEnabled. `buildShader`
 *  is the single ShaderVariantInfo→WGSL choke point; `emitPolygonWgsl` runs the
 *  full shader-dsl emit + O2 fixpoint over the merged 8-projection polygon
 *  module and has no memoization of its own, so without this every buildShader
 *  call across the sync + async pipeline builders re-runs the optimizer for a
 *  variant already emitted. The emit is a pure function of (variant, pick) and
 *  variant.key already uniquely identifies the pipeline (it keys shaderCache),
 *  so this is a byte-exact cache — same key ⇒ same WGSL. (emitPolygonWgsl stays
 *  untouched, so the polygon-variant snapshot drift gate is unaffected.) */
const _buildShaderWgslCache = new Map<string, string>()

export function buildShader(variant?: ShaderVariantInfo | null): string {
  const pick = isPickEnabled()
  // #1568 — the body epoch is in the key. `polygon.ts` spreads the LIVE
  // PROJECTION_CONSTS into every emit and the WGSL backend writes `f32Lit(
  // c.wgslValue)` at emit time, so identical (variant, pick) yields different
  // radii on a different planet. `buildShader` is the single ShaderVariantInfo →
  // WGSL choke point for both the sync and async builders, so without this EVERY
  // per-style fill pipeline built after a body switch carried Earth's numbers.
  // No cap is added: the growth half was refuted (map.setStyle is a warn-once
  // stub and variants come from compile-time IR, so distinct keys stay bounded).
  const cacheKey = `${variant?.key ?? '__base__'}::${pick ? 1 : 0}::b${bodyEpochValue()}`
  const hit = _buildShaderWgslCache.get(cacheKey)
  if (hit !== undefined) return hit
  const composed = toComposerVariant(variant)
  // #2499 — the null-variant base is the closed-set key `wgsl/polygon/{pick,nopick}`: baked,
  // installed at device attach, and until now asked for by nobody (the WebGPU polygon path
  // never went through `wgslFor`, so every boot re-ran the 80 ms emit the bake exists to
  // skip). Same seam contract as `wgslFor`: the store first, then `shipSource(emit)` so a hit
  // and a miss serve the same text; `pick` is the ONE value driving both the id and the
  // emit. The body guard is the store's own, per lookup — a Moon boot reads `closed` and
  // emits, and the epoch in the cache key keeps that emit from answering for Earth.
  // A composer variant is the OPEN set (style-derived bytes) and stays a raw runtime emit.
  const wgsl =
    composed === null
      ? bakedWgsl(() => emitPolygonWgsl(null, pick), polygonWgslId(pick))
      : emitPolygonWgsl(composed, pick)
  _buildShaderWgslCache.set(cacheKey, wgsl)
  return wgsl
}

const _buildSplitWgslCache = new Map<string, string>()

/** The split-bind twin of `buildShader` (#2042 INC-4b/4c; #2499): the same choke point, the
 *  same memo key, the same store-first contract for the null variant — `wgsl/polygon-split/
 *  {pick,nopick}` is a `WgslOnlyFamily` key, baked and installed at every WebGPU boot. Both
 *  of pipeline-factory's split call sites come through here, so the eligibility probe (which
 *  emits a variant's split module only to read its `@group(0)` bindings) and the material
 *  build that follows it share ONE emit instead of paying it twice — the one repeat #2459
 *  counted at boot. `pick` is passed rather than read, so the call site's one value drives
 *  the id and the emit alike. */
export function buildSplitShader(
  variant: ShaderVariantInfo | null | undefined,
  pick: boolean,
): string {
  const cacheKey = `${variant?.key ?? '__base__'}::${pick ? 1 : 0}::b${bodyEpochValue()}`
  const hit = _buildSplitWgslCache.get(cacheKey)
  if (hit !== undefined) return hit
  const composed = toComposerVariant(variant)
  const wgsl =
    composed === null
      ? bakedWgsl(() => emitPolygonSplitWgsl(null, pick), wgslOnlyId('polygon-split', pick))
      : emitPolygonSplitWgsl(composed, pick)
  _buildSplitWgslCache.set(cacheKey, wgsl)
  return wgsl
}
