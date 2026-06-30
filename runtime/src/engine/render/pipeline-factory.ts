// ═══ PipelineFactory — render-pipeline construction collaborator ═══
//
// Extracted VERBATIM from MapRenderer (renderer.ts) — Unit 1 of the
// renderer-decomposition-2026-06-09 plan. The factory owns the
// construction, caching, and recompilation of every render pipeline +
// bind-group layout + the atlas STUB textures for the current quality
// (MSAA / pick) and per-shader-variant set; it exposes them as read-only
// handles. MapRenderer keeps per-field delegating getters so the external
// read contract (map.ts / source-manager.ts push these fields into VTR's
// set*Pipelines) stays byte-identical with ZERO call-site changes.
//
// This collaborator holds NO MapRenderer back-reference — it takes only the
// GPUContext (device / format) and reads quality via the module-level
// `isPickEnabled()` / `getSampleCount()` (gpu.ts) exactly as the original
// `initPipelines` did.
//
// FALSE-BOUNDARY edges kept OFF the factory (plan §5), so they are NOT here:
//   #1 the compute layout-cache (`variantComputeLayoutCache`, keyed by
//      variant.key) — STAYS on MapRenderer. The factory only exposes the two
//      base layouts + FEATURE_LAYOUT_ENTRIES via getOrBuildVariantLayout /
//      a static getter; the compute-extended cache is MapRenderer/COMPUTE.
//   #3 the LIVE atlas views (paletteColorAtlasView / spriteAtlasView) +
//      setPaletteColorAtlas / setSpriteAtlas — STAY on MapRenderer (they
//      rebuild bindGroup + per-layer groups = LAYER/UNIFORM state). The
//      factory owns only the 1×1 STUB textures + the shared sampler.
//   #4 the uniform-ring tail of initPipelines — STAYS on MapRenderer.
//      `build()` ends after the OIT-compose pipeline; MapRenderer then
//      builds the uniformRing + first rebuildUniformBindGroups (which
//      references this.bindGroupLayout). Order: layouts → pipelines → atlas
//      stubs → (back on MapRenderer) ring → first bind-group build.

import type { GPUContext } from '../gpu/gpu'
import {
  BLEND_ALPHA, STENCIL_WRITE, STENCIL_TEST,
  STENCIL_WRITE_NO_DEPTH, STENCIL_TEST_NO_DEPTH,
  BLEND_OIT_ACCUM, BLEND_OIT_REVEALAGE,
  OIT_ACCUM_FORMAT, OIT_REVEALAGE_FORMAT,
} from '../gpu/gpu-shared'
import { isPickEnabled, getSampleCount } from '../gpu/gpu'
import { POLYGON_FILL_FORMAT, POLYGON_EXTRUDED_FORMAT } from '@xgis/compiler'
import { toVertexBufferLayout } from './vertex-buffer-layout'
import { LINE_FORMAT } from './line-vertex-format'
import { DEBUG_OVERDRAW } from '../debug-flags'
import type { ShaderVariantInfo, CachedPipeline } from './renderer-types'
import { buildOverdrawComposePipeline, buildHeatmapBlurPipeline, buildHeatmapComposePipeline, buildOitComposePipeline } from './compose-pipelines'
import { buildFlatFillMaterials, buildExtrudeMaterial, fillViaRhiEnabled, type FillRhiState } from './material/polygon-fill-material'
import type { Material } from './material/material'
import { emitPolygonWgsl } from '../shaders/dsl/polygon'
import { Node } from '@xgis/shader-dsl'
import type { Stmt } from '@xgis/shader-dsl'

// ═══ Polygon shader emit ═══
//
// Phase 2.5 US-008 — buildShader + pickShader route through the polygon
// DSL composer (runtime/src/engine/shaders/dsl/polygon.ts). Variant.fillExpr/strokeExpr
// Nodes flow into the composer; variant.preamble + fillPreamble/
// strokePreamble (still string-typed in the compiler-side ShaderVariant)
// splice into the emit post-hoc until per-idiom preamble migration lands.
// The legacy POLYGON_SHADER_SOURCE template + FILL_RETURN / STROKE_RETURN
// markers live in renderer-shaders.ts and remain there only for the US-000
// snapshot capture script's baseline emit — no runtime path uses them.

/**
 * Build a specialized WGSL shader for a polygon variant. Routes through the
 * polygon DSL composer (runtime/src/engine/shaders/dsl/polygon.ts):
 *
 *   - `variant.fillExpr` / `strokeExpr` Nodes flow into the composer as
 *     ShaderVariantInfo.{fillExpr,strokeExpr}; the composer's placeholder
 *     Stmt swap injects them into fs_fill / fs_stroke at the marker site.
 *   - `variant.needsFeatureBuffer` toggles the @group(0) @binding(1)
 *     feat_data storage binding the composer emits.
 *   - `variant.preamble` (still string-typed in the compiler-side
 *     ShaderVariant — Partial<ModuleDecl> migration deferred to PR-C)
 *     splices into the composer output after the @group(0) @binding(6)
 *     sprite_samp declaration, matching the legacy
 *     POLYGON_SHADER_SOURCE.replace(@group(0) @binding(0)) insertion
 *     position (WGSL ignores declaration order, so the absolute position
 *     doesn't matter for correctness — only the binding numbers do).
 *   - `variant.fillPreamble` / `strokePreamble` strings (the categorical-
 *     encoder's `var _mcSS = ...; if (...) { _mcSS = ...; }` chain etc.)
 *     flow into the composer as raw-WGSL Stmts in the fill-/stroke-preamble
 *     slot; the composer emits them verbatim (at body indent) immediately
 *     before the fill-/stroke-return assign. This replaced the former
 *     post-emit string splice that reconstructed the assign via the
 *     compiler-side nodeToWgslString copy (retired in PR 2e.B.2).
 */
function buildShader(variant?: ShaderVariantInfo | null): string {
  // Default-uniform path (variant absent OR variant carries no preamble +
  // no feat_buffer) — the composer's null-variant emit substitutes the
  // POLYGON_SHADER_SOURCE:565 / 780 default-uniform assigns.
  const pre = variant?.preamble
  const hasPreamble = !!pre
    && (((pre.consts?.length ?? 0) + (pre.bindings?.length ?? 0) + (pre.funcs?.length ?? 0)) > 0)
  if (!variant || (!hasPreamble && !variant.needsFeatureBuffer)) {
    return emitPolygonWgsl(null, isPickEnabled())
  }

  // Variant-bearing path — feed Node-typed exprs + needsFeatureBuffer into
  // the composer. variant.preamble (module-shape string) still splices
  // post-emit until the Partial<ModuleDecl> migration closes it out.
  // The compiler authors fill/stroke exprs as `@xgis/shader-dsl` IR (its `Expr`
  // is imported from the package, not a local mirror), so `variant.fillExpr.expr`
  // is the runtime Node's own `Expr` type — reconstruct the Node directly, no cast.
  const fillExprNode =
    variant.fillExpr && !variant.fillIsDefault
      ? new Node<'vec4<f32>'>(variant.fillExpr.expr)
      : null
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
  // ShaderVariantInfo.fillExpr expects Node<'vec4<f32>'>; the runtime Node
  // class carries the same {op:'construct'|...} Expr shape that the
  // compiler-side NodeLike captures, so the constructor call is the bridge.
  // The compiler authors every specialized const / binding / helper fn as IR
  // decls (variant.preamble: Partial<ModuleDecl>); the composer spreads them
  // into the base module — no post-emit WGSL-string splice.
  const wgsl = emitPolygonWgsl(
    {
      preamble: variant.preamble ?? null,
      fillExpr: fillExprNode,
      strokeExpr: strokeExprNode,
      fillPreamble,
      strokePreamble,
      needsFeatureBuffer: variant.needsFeatureBuffer,
    },
    isPickEnabled(),
  )

  return wgsl
}

// ═══ PipelineFactory ═══

export class PipelineFactory {
  private ctx: GPUContext

  // Shader variant cache: variant key → compiled pipeline set
  private shaderCache = new Map<string, CachedPipeline>()

  fillPipeline!: GPURenderPipeline
  /** P1.6 — flat-fill RHI Material twins (default shader), built behind __xgisVtrFillViaRhi (default
   *  off → no extra pipelines). The VTR's recordFillDraw routes the flat/ground non-extrude fill
   *  through these via the FillRhiState getter below. */
  private _fillMaterials: { flat: Material; ground: Material } | null = null
  /** LIVE per-style fill Material map (grown by registerFillMaterials as variant pipelines build). */
  private _fillPerStyle = new Map<GPURenderPipeline, { mat: Material; variant: number }>()
  /** Opaque 3D-extrude fill Material (default shader; the base extrude pipelines, not per-variant). */
  private _fillExtrudeMaterial: Material | null = null
  /** pointer-events:none (no-pick, pick writeMask 0) twin of _fillExtrudeMaterial — only built when
   *  picking is on (off → the no-pick pipelines alias the pickable ones, already covered). */
  private _fillExtrudeMaterialNoPick: Material | null = null
  fillRhiState(): FillRhiState | null {
    if (!this._fillMaterials) return null
    return {
      flat: this._fillMaterials.flat, ground: this._fillMaterials.ground,
      pipes: { write: this.fillPipeline, test: this.fillPipelineFallback, groundWrite: this.fillPipelineGround, groundTest: this.fillPipelineGroundFallback },
      perStyle: this._fillPerStyle,
      extrude: this._fillExtrudeMaterial
        ? {
            mat: this._fillExtrudeMaterial, write: this.fillPipelineExtruded, test: this.fillPipelineExtrudedFallback,
            ...(this._fillExtrudeMaterialNoPick
              ? { matNoPick: this._fillExtrudeMaterialNoPick, writeNoPick: this.fillPipelineExtrudedNoPick, testNoPick: this.fillPipelineExtrudedFallbackNoPick }
              : {}),
          }
        : null,
    }
  }
  /** Build + register the per-style fill Material twins for a variant pipeline set (behind the flag).
   *  Keyed by each native per-style pipeline so recordFillDraw routes them via the Material seam. */
  private registerFillMaterials(variant: ShaderVariantInfo, pipelines: CachedPipeline): void {
    if (!fillViaRhiEnabled()) return
    const { format } = this.ctx
    const { flat, ground } = buildFlatFillMaterials({
      rhi: this.ctx.rhi, shader: buildShader(variant), format, sampleCount: getSampleCount(),
      bindGroupLayout: this.getOrBuildVariantLayout(variant), vertexLayout: toVertexBufferLayout(POLYGON_FILL_FORMAT), pickEnabled: isPickEnabled(),
    })
    this._fillPerStyle.set(pipelines.fillPipeline, { mat: flat, variant: 0 })
    this._fillPerStyle.set(pipelines.fillPipelineFallback, { mat: flat, variant: 1 })
    this._fillPerStyle.set(pipelines.fillPipelineGround, { mat: ground, variant: 0 })
    this._fillPerStyle.set(pipelines.fillPipelineGroundFallback, { mat: ground, variant: 1 })
  }
  /** Ground-layer fill — identical to fillPipeline except depth
   *  test/write are off. Selected at draw time for any layer whose
   *  `extrude.kind === 'none'` so coplanar fills resolve via plain
   *  painter's order (GPU command submission), not the fragile
   *  layer_depth_offset NDC bias. */
  fillPipelineGround!: GPURenderPipeline
  /** Per-feature 3D extrusion variant of fillPipeline — identical
   *  except entryPoint=`vs_main_ecef_extruded` and a unified ECEF
   *  vertex buffer (stride-14 floats: pos_h, pos_l, feat_id, abs_lon,
   *  abs_lat, face_normal, wall_height, is_top). Used by the fill-draw
   *  branch when a tile slice carries `heights` (e.g. protomaps
   *  `buildings` with `render_height`). */
  fillPipelineExtruded!: GPURenderPipeline
  /** Weighted-Blended OIT translucent extrude fill. Renders into
   *  `oitAccumTexture` + `oitRevealageTexture` so multiple
   *  translucent buildings composite without back-to-front sort.
   *  The OIT compose pipeline reads both targets back into the
   *  resolved main color afterward. */
  fillPipelineExtrudedOIT!: GPURenderPipeline
  /** Compose pipeline for the Weighted-Blended OIT pair. Samples
   *  `oitAccumTexture` + `oitRevealageTexture` and over-blends the
   *  recovered translucent color onto the opaque framebuffer. */
  oitComposePipeline!: GPURenderPipeline
  oitComposeBindGroupLayout!: GPUBindGroupLayout
  /** `?debug=overdraw` final pass — fullscreen quad samples the
   *  r16float overdraw accumulator and writes a heat-colormapped RGBA
   *  to the swapchain. Built lazily on first call to ensureOverdrawCompose. */
  overdrawComposePipeline: GPURenderPipeline | null = null
  overdrawComposeBindGroupLayout!: GPUBindGroupLayout
  /** Heatmap separable-Gaussian blur pipeline (Phase R). Fullscreen triangle
   *  reads the r16float density (textureLoad) and writes the 9-tap blur back
   *  to an r16float target; runs twice per frame (horizontal then vertical).
   *  Built lazily on first call to ensureHeatmapBlur. */
  heatmapBlurPipeline: GPURenderPipeline | null = null
  heatmapBlurBindGroupLayout!: GPUBindGroupLayout
  /** Heatmap compose pipeline (Phase R). Fullscreen triangle samples the
   *  blurred density, maps it through the colour-ramp LUT × intensity ×
   *  opacity, and alpha-blends over the scene. Built lazily on first call to
   *  ensureHeatmapCompose. */
  heatmapComposePipeline: GPURenderPipeline | null = null
  heatmapComposeBindGroupLayout!: GPUBindGroupLayout
  /** `?debug=overdraw` — fill pipeline mirror (base bind group
   *  layout). FS replaced with `fs_overdraw`, color target r16float
   *  + additive. Variant shows that use the feature bind group
   *  layout select `fillPipelineOverdrawFeature` instead. */
  fillPipelineOverdraw: GPURenderPipeline | null = null
  /** `?debug=overdraw` — fill pipeline mirror for feature-layout
   *  shows (data-driven variants that bind a per-feature storage
   *  buffer alongside the uniform). */
  fillPipelineOverdrawFeature: GPURenderPipeline | null = null
  /** `?debug=overdraw` — line pipeline mirror (base bind group
   *  layout). Lines go through LineRenderer.drawSegments today,
   *  which is gated off in debug mode; this pipeline is here for
   *  completeness in case a future caller setPipelines it. */
  linePipelineOverdraw: GPURenderPipeline | null = null
  linePipeline!: GPURenderPipeline
  // Stencil-test pipelines: only draw where stencil = 0 (not covered by children)
  fillPipelineFallback!: GPURenderPipeline
  fillPipelineGroundFallback!: GPURenderPipeline
  fillPipelineExtrudedFallback!: GPURenderPipeline
  /** iter-182 — fill-pattern Stage 2 ground variant. Same vertex
   *  path as `fillPipelineGround` (no depth write) but routed to
   *  `fs_fill_pattern`. VTR selects this pipeline at draw time when
   *  `show.fillPattern` is non-null (iter-183 routing). */
  fillPipelinePatternGround!: GPURenderPipeline
  fillPipelinePatternGroundFallback!: GPURenderPipeline
  /** iter-186 — fill-extrusion-pattern Stage 2 variants. Same
   *  vs_main_ecef_extruded vertex path as the solid extrude
   *  pipelines + the unified ECEF stride-14 vertex buffer; fragment
   *  uses `fs_fill_pattern` so walls + roofs sample the sprite atlas. */
  fillPipelinePatternExtruded!: GPURenderPipeline
  fillPipelinePatternExtrudedFallback!: GPURenderPipeline
  linePipelineFallback!: GPURenderPipeline
  // `pointer-events: none` mirrors — same shader, writeMask:0 on the
  // pick attachment so the layer's pickId never lands in the pick
  // texture. Identity-aliased to the pickable set when picking is
  // globally disabled (no pick attachment to mask).
  fillPipelineNoPick!: GPURenderPipeline
  fillPipelineGroundNoPick!: GPURenderPipeline
  fillPipelineExtrudedNoPick!: GPURenderPipeline
  linePipelineNoPick!: GPURenderPipeline
  fillPipelineFallbackNoPick!: GPURenderPipeline
  fillPipelineGroundFallbackNoPick!: GPURenderPipeline
  fillPipelineExtrudedFallbackNoPick!: GPURenderPipeline
  linePipelineFallbackNoPick!: GPURenderPipeline
  bindGroupLayout!: GPUBindGroupLayout
  featureBindGroupLayout!: GPUBindGroupLayout
  // P3 Step 3c palette atlas resources. The texture starts as a 1×1
  // transparent stub so every bind group is valid even before the
  // real atlas (uploadPalette result) lands. MapRenderer's
  // `setPaletteColorAtlas` swaps the LIVE view in-place when the scene
  // compile finishes — the factory owns only this stub.
  paletteStubTexture!: GPUTexture
  paletteStubTextureView!: GPUTextureView
  paletteSampler!: GPUSampler
  /** iter-181 — fill-pattern Stage 2 infra. Sprite atlas texture
   *  resources are bound to every polygon pipeline at binding 5 so
   *  the future fs_fill_pattern fragment can `textureSample()` it
   *  without a separate pipeline-variant matrix. Defaults to a 1×1
   *  white stub so existing fill draws are unaffected (they ignore
   *  the binding); replaced via `setSpriteAtlas` once the runtime
   *  IconStage finishes loading the real atlas. The sampler is
   *  shared with `paletteSampler` at binding 4 — both atlases want
   *  the same linear / clamp-to-edge filter, no point doubling the
   *  binding count. */
  spriteAtlasStubTexture!: GPUTexture
  spriteAtlasStubTextureView!: GPUTextureView

  constructor(ctx: GPUContext) {
    this.ctx = ctx
    this.build()
  }

  /** Single source of truth for the legacy feature-bind-group entries.
   *  `build()` builds `featureBindGroupLayout` from these same
   *  values; MapRenderer's `getOrBuildVariantLayout` reuses them as the
   *  base for compute-extended layouts so the two layouts agree on legacy
   *  bindings 0/1/2/4.
   *
   *  Visibility bits use the raw spec values (VERTEX=1, FRAGMENT=2,
   *  COMPUTE=4) instead of `GPUShaderStage.X` because this is a
   *  class-field initializer evaluated at module load; Node test
   *  environments don't define the WebGPU globals at that time.
   *  Browsers' WebGPU runtimes assign the same numeric values. */
  static readonly FEATURE_LAYOUT_ENTRIES: readonly GPUBindGroupLayoutEntry[] = [
    { binding: 0, visibility: /* VERTEX|FRAGMENT */ 3,
      buffer: { type: 'uniform' as const, hasDynamicOffset: true } },
    { binding: 1, visibility: /* FRAGMENT */ 2,
      buffer: { type: 'read-only-storage' as const } },
    { binding: 2, visibility: /* FRAGMENT */ 2,
      texture: { sampleType: 'float' as const, viewDimension: '2d' as const } },
    { binding: 4, visibility: /* FRAGMENT */ 2,
      sampler: { type: 'filtering' as const } },
    // iter-197 — sprite atlas binding 5 + sampler binding 6 (iter-181/182
    // additions). Drift caught at compute=1 + OFM Bright z=10 Seoul: the
    // compute-extended layout (built from this static via
    // `extendBindGroupLayoutEntriesForCompute`) was missing 5/6 while
    // `paletteLayoutEntries` (the non-compute path's source of truth)
    // already included them. VTR's `per-tile-feature-bg` BindGroup binds
    // 5/6 unconditionally → validation error on compute path only.
    { binding: 5, visibility: /* FRAGMENT */ 2,
      texture: { sampleType: 'float' as const, viewDimension: '2d' as const } },
    { binding: 6, visibility: /* FRAGMENT */ 2,
      sampler: { type: 'filtering' as const } },
  ]

  /** iter-204A — palette + sprite-atlas binding slots (bindings 2/4/5/6)
   *  that BOTH the base + feature bind group layouts include. The
   *  per-tile BindGroup in VTR (`per-tile-feature-bg`) writes these
   *  entries unconditionally; if either layout is missing one, the
   *  WebGPU validator throws "binding index N not present in the bind
   *  group layout" — exactly the iter-197 spam class.
   *
   *  Hoisted from a function-scope const inside `build` to a
   *  static member so the bind-group-drift invariant test can read
   *  the canonical binding set without instantiating a renderer
   *  (which needs a real GPUDevice). Visibility encoded as raw spec
   *  bits ({@link FEATURE_LAYOUT_ENTRIES} comment explains why). */
  static readonly PALETTE_LAYOUT_ENTRIES: readonly GPUBindGroupLayoutEntry[] = [
    { binding: 2, visibility: /* FRAGMENT */ 2,
      texture: { sampleType: 'float' as const, viewDimension: '2d' as const } },
    { binding: 4, visibility: /* FRAGMENT */ 2,
      sampler: { type: 'filtering' as const } },
    { binding: 5, visibility: /* FRAGMENT */ 2,
      texture: { sampleType: 'float' as const, viewDimension: '2d' as const } },
    { binding: 6, visibility: /* FRAGMENT */ 2,
      sampler: { type: 'filtering' as const } },
  ]

  /** Public mirror of {@link FEATURE_LAYOUT_ENTRIES} for the drift
   *  invariant test + MapRenderer's compute-extended layout path
   *  (private static can't be reached from a different source file via
   *  a normal import — the export attaches at module level). Same
   *  array; do not duplicate. */
  static getFeatureLayoutEntries(): readonly GPUBindGroupLayoutEntry[] {
    return PipelineFactory.FEATURE_LAYOUT_ENTRIES
  }

  /** Return the bind-group layout for a variant WITHOUT compute
   *  bindings — the trivial read of the two factory-owned layouts.
   *  Variants WITH compute bindings get a per-key extended layout that
   *  MapRenderer owns (the `variantComputeLayoutCache`, keyed by
   *  variant.key — COMPUTE-cluster state, plan §5 FB#1), so that branch
   *  stays on MapRenderer and routes through here only for the base
   *  layouts it extends. */
  getOrBuildVariantLayout(variant: ShaderVariantInfo): GPUBindGroupLayout {
    return variant.needsFeatureBuffer ? this.featureBindGroupLayout : this.bindGroupLayout
  }

  /** Rebuild all pipelines + invalidate shader variant cache. Called by
   *  MapRenderer.rebuildForQuality (forwarder) when `map.setQuality()`
   *  flips MSAA or picking at runtime — both force a pipeline
   *  `sampleCount` / fragment-target-count change baked at pipeline
   *  creation. Non-pipeline state (bind group layouts survive the
   *  rebuild since `build` recreates them; the uniform ring + graticule
   *  geometry on MapRenderer survive unchanged).
   *
   *  NOTE: MapRenderer's `variantComputeLayoutCache` (COMPUTE-cluster)
   *  is keyed by the SAME variant.key as `shaderCache` and MUST be
   *  cleared in lockstep — that clear stays in the MapRenderer forwarder
   *  (plan §6 DO-NOT-SPLIT #3, pinned by map-set-quality-invariant). */
  rebuild(): void {
    // Toss the per-show variant pipelines — their shader embeds the
    // PICK markers too, and their `multisample.count` is frozen.
    // map.setQuality (the only caller, via MapRenderer.rebuildForQuality)
    // follows up with an eager re-resolve loop over vectorTileShows that
    // calls getOrCreateVariantPipelines + getOrBuildVariantLayout so
    // pipelines AND layouts stay self-consistent. Lazy rebuild from the
    // draw path was previously promised in a comment here but never
    // wired — that promise let entry.pipelines stay null with
    // entry.layout still feature/compute, tripping per-frame
    // BindGroupLayout validation (see commit 6080a2f).
    this.shaderCache.clear()
    this.build()
    this.overdrawComposePipeline = null
  }

  /** Lazy-build the `?debug=overdraw` final compose pipeline. Samples
   *  the r16float overdraw accumulator and writes a heat-colormapped
   *  RGBA to the swapchain. SampleCount = 1 (debug mode forces MSAA
   *  off in `quality.ts`), so this pipeline never needs MSAA variants.
   *  Idempotent — first call builds, subsequent calls reuse. */
  ensureOverdrawCompose(): GPURenderPipeline {
    if (this.overdrawComposePipeline) return this.overdrawComposePipeline
    const built = buildOverdrawComposePipeline(this.ctx.device, this.ctx.format)
    this.overdrawComposeBindGroupLayout = built.layout
    this.overdrawComposePipeline = built.pipeline
    return this.overdrawComposePipeline
  }

  /** Lazy-build the heatmap separable-Gaussian blur pipeline (Phase R).
   *  Fullscreen triangle samples the r16float density via textureLoad
   *  (unfilterable-float — no sampler) and writes the 9-tap blur to an
   *  r16float target. The `direction` uniform selects horizontal vs vertical;
   *  the pass binds the same pipeline twice. Modelled on ensureOverdrawCompose
   *  — single-sample, no MSAA variants. Idempotent. */
  ensureHeatmapBlur(): GPURenderPipeline {
    if (this.heatmapBlurPipeline) return this.heatmapBlurPipeline
    const built = buildHeatmapBlurPipeline(this.ctx.device)
    this.heatmapBlurBindGroupLayout = built.layout
    this.heatmapBlurPipeline = built.pipeline
    return this.heatmapBlurPipeline
  }

  /** Lazy-build the heatmap compose pipeline (Phase R). Fullscreen triangle
   *  samples the blurred density (textureLoad), maps it through the colour
   *  ramp LUT (filterable rgba8, textureSample) × intensity × opacity, and
   *  alpha-blends over the scene (src-alpha / one-minus-src-alpha). It runs as
   *  the LAST colour pass — after the label pass has resolved MSAA to the
   *  swapchain — and composites onto the resolved single-sample swapchain
   *  (`ctx.screenView`), exactly like the overdraw-compose pass. This sidesteps
   *  the MSAA resolve-ownership hazard entirely (the heatmap never has to share
   *  the MSAA attachment). Single-sample; no MSAA variants. Idempotent.
   *
   *  NOTE: because it composites after labels, symbols draw UNDER the heatmap
   *  rather than on top (Mapbox draws symbols above heatmap). For a density
   *  overlay this is visually acceptable; threading the compose into the
   *  pre-label MSAA chain (so symbols sit on top) is a deferred follow-up. */
  ensureHeatmapCompose(): GPURenderPipeline {
    if (this.heatmapComposePipeline) return this.heatmapComposePipeline
    const built = buildHeatmapComposePipeline(this.ctx.device, this.ctx.format)
    this.heatmapComposeBindGroupLayout = built.layout
    this.heatmapComposePipeline = built.pipeline
    return this.heatmapComposePipeline
  }

  /** Build all bind-group layouts → base pipelines → atlas stub
   *  textures → OIT compose. Returns nothing — every field lives on the
   *  factory. The uniform-ring tail of the original `initPipelines`
   *  STAYS on MapRenderer (plan §5 FB#4): after `build()`, MapRenderer
   *  constructs the uniformRing + first rebuildUniformBindGroups (which
   *  references `_pipelines.bindGroupLayout`). DO-NOT reorder: layouts
   *  BEFORE pipelines BEFORE stubs (plan §6 DO-NOT-SPLIT #2) — a reorder
   *  risks a WebGPU "layout used before creation" validation throw. */
  build(): void {
    const { device, format } = this.ctx

    // Phase 2.5 US-008 iter-8b — base-pipeline pick shader routes through
    // the polygon DSL composer. The composer's `pickEnabled` flag drives
    // the pick-attachment field + write directly (replaces the old
    // __PICK_FIELD__ / __PICK_WRITE__ regex markers in POLYGON_SHADER_SOURCE).
    const pickShader = emitPolygonWgsl(null, isPickEnabled())
    const shaderModule = device.createShaderModule({
      code: pickShader,
      label: 'xgis-shader',
    })

    // P3 Step 3c — palette gradient atlas bindings on group 0:
    //   binding 2: rgba8unorm 2-D atlas of pre-baked color gradients
    //              (one row per gradient, GRADIENT_WIDTH texels wide).
    //   binding 4: linear-filter sampler shared by every gradient
    //              sample call site. (Binding 3 is reserved for the
    //              scalar atlas; not wired yet — scalars stay on the
    //              CPU resolve path until r32float-vs-filterable is
    //              resolved.)
    // Both base and feature layouts include these so the variant
    // pipeline can validate against either, regardless of whether the
    // layer also needs the per-feature data buffer.
    // iter-204A — hoisted to `PipelineFactory.PALETTE_LAYOUT_ENTRIES`
    // so the bind-group-drift invariant test can read the canonical
    // set without instantiating the renderer. Visibility encoded as
    // raw FRAGMENT bit (= 2) so Node test environments (no WebGPU
    // globals at module load) can still import the array. Cast back
    // to GPUBindGroupLayoutEntry for the device.createBindGroupLayout
    // call — runtime treats numeric visibility identical to the
    // GPUShaderStage flag.
    const paletteLayoutEntries: readonly GPUBindGroupLayoutEntry[] =
      PipelineFactory.PALETTE_LAYOUT_ENTRIES

    this.bindGroupLayout = device.createBindGroupLayout({
      label: 'mr-baseBindGroupLayout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true },
        },
        ...paletteLayoutEntries,
      ],
    })

    this.featureBindGroupLayout = device.createBindGroupLayout({
      label: 'mr-featureBindGroupLayout',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' },
        },
        ...paletteLayoutEntries,
      ],
    })

    // Device-lifetime 1×1 stub color texture + linear sampler. Every
    // pipeline created against the layouts above must bind SOMETHING
    // at bindings 2 / 4 to satisfy WebGPU validation, even when the
    // layer has no zoom-interpolated paint. P3 Step 3c proper will
    // swap the stub for `uploadPalette`'s real atlas; until then the
    // stubs keep existing bind groups valid + the visual unchanged.
    this.paletteStubTexture = device.createTexture({
      label: 'mr-palette-stub-color',
      size: { width: 1, height: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    device.queue.writeTexture(
      { texture: this.paletteStubTexture },
      new Uint8Array([0, 0, 0, 0]),
      { bytesPerRow: 4 },
      { width: 1, height: 1 },
    )
    this.paletteStubTextureView = this.paletteStubTexture.createView()
    this.paletteSampler = device.createSampler({
      label: 'mr-palette-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    })

    // iter-181 — sprite atlas stub. 1×1 OPAQUE WHITE so any future
    // shader that samples without the pattern flag set still gets a
    // neutral colour (multiplied by u.fill_color → original fill).
    // setSpriteAtlas() swaps the view once iconStage's atlas lands.
    this.spriteAtlasStubTexture = device.createTexture({
      label: 'mr-sprite-atlas-stub',
      size: { width: 1, height: 1 },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    device.queue.writeTexture(
      { texture: this.spriteAtlasStubTexture },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4 },
      { width: 1, height: 1 },
    )
    this.spriteAtlasStubTextureView = this.spriteAtlasStubTexture.createView()

    const pipelineLayout = device.createPipelineLayout({
      label: 'mr-mainPipelineLayout(base-only)',
      bindGroupLayouts: [this.bindGroupLayout],
    })

    // PR 2f: polygon flat-fill QUANTIZED ECEF, stride 24 bytes.
    // [uint16x4 (qx_hi,qx_lo,qy_hi,qy_lo) + uint16x2 (qz_hi,qz_lo)
    //  + feat_id(f32) + abs_lon(f32) + abs_lat(f32)]
    // Bound to vs_main_ecef / vs_main_ecef_extruded. Derived from the
    // single-source POLYGON_FILL_FORMAT / POLYGON_EXTRUDED_FORMAT specs
    // (@xgis/compiler) that the packer + WGSL @location also derive from —
    // so layout, packer, and shader attributes cannot drift.
    const vertexBufferLayout = toVertexBufferLayout(POLYGON_FILL_FORMAT)
    const extrudedVertexBufferLayout = toVertexBufferLayout(POLYGON_EXTRUDED_FORMAT)
    // Line vertex layout from the single-source LINE_FORMAT spec (consumer:
    // vs_main). Same derivation as the two variant builders below — no copies.
    const lineVertexBufferLayout = toVertexBufferLayout(LINE_FORMAT)

    // Pipeline color target list. When picking is on, append an RG32Uint
    // target at location 1 that the fragment shader's out.pick writes into.
    // `writeMask: ALL` is default — uint formats ignore blend state.
    // For `pointer-events: none` layers we build a parallel set with
    // `writeMask: 0` on the pick target so the layer's pickId never
    // overwrites the pick texture's prior contents (picks fall through).
    const pickEnabled = isPickEnabled()
    const colorTargets: GPUColorTargetState[] = [{ format, blend: BLEND_ALPHA }]
    if (pickEnabled) colorTargets.push({ format: 'rg32uint' })
    const colorTargetsNoPick: GPUColorTargetState[] = pickEnabled
      ? [{ format, blend: BLEND_ALPHA }, { format: 'rg32uint', writeMask: 0 }]
      : colorTargets
    const msaaState: GPUMultisampleState = { count: getSampleCount() }

    const buildSet = (targets: GPUColorTargetState[], suffix: string) => ({
      fill: device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module: shaderModule, entryPoint: 'vs_main_ecef', buffers: [vertexBufferLayout] },
        fragment: { module: shaderModule, entryPoint: 'fs_fill', targets },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: STENCIL_WRITE, multisample: msaaState,
        label: `fill-pipeline${suffix}`,
      }),
      // Ground-layer fill — same shader as `fill` but with depth
      // test + write disabled. Used for any layer with
      // `extrude.kind === 'none'`; painter's order resolves
      // coplanar fragments without the layer_depth_offset hack.
      fillGround: device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module: shaderModule, entryPoint: 'vs_main_ecef', buffers: [vertexBufferLayout] },
        fragment: { module: shaderModule, entryPoint: 'fs_fill', targets },
        primitive: { topology: 'triangle-list', cullMode: 'back' }, // GPU back-cull far hemisphere on sphere; inert on flat (#587)
        depthStencil: STENCIL_WRITE_NO_DEPTH, multisample: msaaState,
        label: `fill-pipeline-ground${suffix}`,
      }),
      fillExtruded: device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module: shaderModule, entryPoint: 'vs_main_ecef_extruded', buffers: [extrudedVertexBufferLayout] },
        fragment: { module: shaderModule, entryPoint: 'fs_fill_extrude', targets },
        // Two-sided rendering. Concave footprints (dome, courtyard)
        // need back walls visible when the camera tilts to see inside.
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: STENCIL_WRITE, multisample: msaaState,
        label: `fill-pipeline-extruded${suffix}`,
      }),
      line: device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module: shaderModule, entryPoint: 'vs_main', buffers: [lineVertexBufferLayout] },
        fragment: { module: shaderModule, entryPoint: 'fs_stroke', targets },
        primitive: { topology: 'line-list', cullMode: 'none' },
        depthStencil: STENCIL_WRITE, multisample: msaaState,
        label: `line-pipeline${suffix}`,
      }),
      fillFallback: device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module: shaderModule, entryPoint: 'vs_main_ecef', buffers: [vertexBufferLayout] },
        fragment: { module: shaderModule, entryPoint: 'fs_fill', targets },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: STENCIL_TEST, multisample: msaaState,
        label: `fill-pipeline-fallback${suffix}`,
      }),
      // Ground variant of the stencil-test fallback — same depth-
      // disabled state as fillGround.
      fillGroundFallback: device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module: shaderModule, entryPoint: 'vs_main_ecef', buffers: [vertexBufferLayout] },
        fragment: { module: shaderModule, entryPoint: 'fs_fill', targets },
        primitive: { topology: 'triangle-list', cullMode: 'back' }, // GPU back-cull far hemisphere (#587, see fillGround)
        depthStencil: STENCIL_TEST_NO_DEPTH, multisample: msaaState,
        label: `fill-pipeline-ground-fallback${suffix}`,
      }),
      fillExtrudedFallback: device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module: shaderModule, entryPoint: 'vs_main_ecef_extruded', buffers: [extrudedVertexBufferLayout] },
        fragment: { module: shaderModule, entryPoint: 'fs_fill_extrude', targets },
        // Same rationale as `fillExtruded` above: unculled to keep
        // dome / courtyard interiors visible.
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: STENCIL_TEST, multisample: msaaState,
        label: `fill-pipeline-extruded-fallback${suffix}`,
      }),
      lineFallback: device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module: shaderModule, entryPoint: 'vs_main', buffers: [lineVertexBufferLayout] },
        fragment: { module: shaderModule, entryPoint: 'fs_stroke', targets },
        primitive: { topology: 'line-list', cullMode: 'none' },
        depthStencil: STENCIL_TEST, multisample: msaaState,
        label: `line-pipeline-fallback${suffix}`,
      }),
      // iter-182 — fill-pattern Stage 2 ground variant. Same vertex
      // path as `fillGround` (quantized polygon, ground-z plane, no
      // depth write) but routed to `fs_fill_pattern`, which samples
      // the sprite atlas at world-anchored UV. Used by VTR (iter-183
      // routing) when `show.fillPattern` is set. Ground-only for now
      // — extrude-pattern variant deferred to iter-185.
      fillPatternGround: device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module: shaderModule, entryPoint: 'vs_main_ecef', buffers: [vertexBufferLayout] },
        fragment: { module: shaderModule, entryPoint: 'fs_fill_pattern', targets },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: STENCIL_WRITE_NO_DEPTH, multisample: msaaState,
        label: `fill-pipeline-pattern-ground${suffix}`,
      }),
      fillPatternGroundFallback: device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module: shaderModule, entryPoint: 'vs_main_ecef', buffers: [vertexBufferLayout] },
        fragment: { module: shaderModule, entryPoint: 'fs_fill_pattern', targets },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: STENCIL_TEST_NO_DEPTH, multisample: msaaState,
        label: `fill-pipeline-pattern-ground-fallback${suffix}`,
      }),
      // iter-186 — fill-extrusion-pattern Stage 2 variants. Same per-
      // feature extrusion vertex (vs_main_ecef_extruded) as the
      // solid extrude pipeline + the unified ECEF stride-14 vertex
      // buffer; fragment routes to `fs_fill_pattern` so building walls
      // + roofs sample the sprite atlas. Documented Stage 2 trade-off:
      // pattern-extrude shows lose the wall_shade lighting (sprite
      // colour replaces the shaded fill rgb). Stage 2.1 will route to
      // a dedicated fs_fill_pattern_extruded that multiplies by
      // wall_shade.
      fillPatternExtruded: device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module: shaderModule, entryPoint: 'vs_main_ecef_extruded', buffers: [extrudedVertexBufferLayout] },
        fragment: { module: shaderModule, entryPoint: 'fs_fill_pattern', targets },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: STENCIL_WRITE, multisample: msaaState,
        label: `fill-pipeline-pattern-extruded${suffix}`,
      }),
      fillPatternExtrudedFallback: device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module: shaderModule, entryPoint: 'vs_main_ecef_extruded', buffers: [extrudedVertexBufferLayout] },
        fragment: { module: shaderModule, entryPoint: 'fs_fill_pattern', targets },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: STENCIL_TEST, multisample: msaaState,
        label: `fill-pipeline-pattern-extruded-fallback${suffix}`,
      }),
    })

    const pickable = buildSet(colorTargets, '')
    this.fillPipeline = pickable.fill
    this.fillPipelineGround = pickable.fillGround
    this.fillPipelineExtruded = pickable.fillExtruded
    this.linePipeline = pickable.line
    this.fillPipelineFallback = pickable.fillFallback
    this.fillPipelineGroundFallback = pickable.fillGroundFallback
    this.fillPipelineExtrudedFallback = pickable.fillExtrudedFallback
    this.linePipelineFallback = pickable.lineFallback
    this.fillPipelinePatternGround = pickable.fillPatternGround
    this.fillPipelinePatternGroundFallback = pickable.fillPatternGroundFallback
    this.fillPipelinePatternExtruded = pickable.fillPatternExtruded
    this.fillPipelinePatternExtrudedFallback = pickable.fillPatternExtrudedFallback

    // P1.6 — build the flat-fill Material twins (default shader) behind __xgisVtrFillViaRhi (default
    // off → no extra pipelines built). recordFillDraw routes the flat/ground non-extrude fill through them.
    if (fillViaRhiEnabled()) {
      this._fillMaterials = buildFlatFillMaterials({
        rhi: this.ctx.rhi, shader: pickShader, format, sampleCount: getSampleCount(),
        bindGroupLayout: this.bindGroupLayout, vertexLayout: vertexBufferLayout, pickEnabled,
      })
      this._fillExtrudeMaterial = buildExtrudeMaterial({
        rhi: this.ctx.rhi, shader: pickShader, format, sampleCount: getSampleCount(),
        bindGroupLayout: this.bindGroupLayout, vertexLayout: extrudedVertexBufferLayout, pickEnabled,
      })
    }

    // `?debug=overdraw` — fill + line debug mirrors. Same VS as the
    // opaque pipelines so the rasterizer produces matching fragment
    // coverage; FS collapses to `fs_overdraw` (constant 1.0 R, alpha
    // 0). Color target r16float + additive blend accumulates fragment
    // counts. Depth-stencil `always` + no writes so every rasterized
    // fragment contributes (submitted overdraw, the MapLibre debug-
    // mode convention). One pipeline per primitive type covers every
    // fill / line draw in the opaque bucket — map.ts overrides
    // cs.fp / cs.lp / cs.fpF etc. to point at these in debug mode.
    if (DEBUG_OVERDRAW) {
      const overdrawTargets: GPUColorTargetState[] = [{
        format: 'r16float',
        blend: {
          color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        },
      }]
      const overdrawDepthStencil: GPUDepthStencilState = {
        format: 'depth24plus-stencil8',
        depthCompare: 'always',
        depthWriteEnabled: false,
        stencilFront: { compare: 'always', passOp: 'keep' },
        stencilBack: { compare: 'always', passOp: 'keep' },
        stencilWriteMask: 0x00,
        stencilReadMask: 0x00,
      }
      this.fillPipelineOverdraw = device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module: shaderModule, entryPoint: 'vs_main_ecef', buffers: [vertexBufferLayout] },
        fragment: { module: shaderModule, entryPoint: 'fs_overdraw', targets: overdrawTargets },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: overdrawDepthStencil,
        multisample: { count: 1 },
        label: 'fill-pipeline-overdraw',
      })
      // Feature-layout variant — for data-driven shows whose bgl is
      // `featureBindGroupLayout`. WebGPU compares bind-group layouts
      // by identity, so we need a dedicated pipeline whose
      // pipelineLayout references the same featureBindGroupLayout.
      const featurePipelineLayout = device.createPipelineLayout({
        label: 'mr-overdrawPipelineLayout(feature)',
        bindGroupLayouts: [this.featureBindGroupLayout],
      })
      this.fillPipelineOverdrawFeature = device.createRenderPipeline({
        layout: featurePipelineLayout,
        vertex: { module: shaderModule, entryPoint: 'vs_main_ecef', buffers: [vertexBufferLayout] },
        fragment: { module: shaderModule, entryPoint: 'fs_overdraw', targets: overdrawTargets },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: overdrawDepthStencil,
        multisample: { count: 1 },
        label: 'fill-pipeline-overdraw-feature',
      })
      this.linePipelineOverdraw = device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module: shaderModule, entryPoint: 'vs_main', buffers: [lineVertexBufferLayout] },
        fragment: { module: shaderModule, entryPoint: 'fs_overdraw', targets: overdrawTargets },
        primitive: { topology: 'line-list', cullMode: 'none' },
        depthStencil: overdrawDepthStencil,
        multisample: { count: 1 },
        label: 'line-pipeline-overdraw',
      })
    }

    // OIT translucent extrude pipeline — separate from buildSet
    // because it targets the OIT MRT pair (rgba16float accum +
    // r16float revealage) at sampleCount=1, not the main pass's
    // color + pick attachments at MSAA. Same vs_main_ecef_extruded
    // vertex stage as the opaque fill — only the fragment entry +
    // targets differ. Depth state DEPTH_READ_ONLY: the
    // translucent fill respects the opaque depth buffer (hidden
    // behind solid walls) without writing depth (so multiple
    // translucent layers don't occlude each other in OIT space).
    const oitTargets: GPUColorTargetState[] = [
      { format: OIT_ACCUM_FORMAT, blend: BLEND_OIT_ACCUM },
      { format: OIT_REVEALAGE_FORMAT, blend: BLEND_OIT_REVEALAGE, writeMask: GPUColorWrite.RED },
    ]
    // OIT pass uses NO depth attachment — opaque depth is MSAA-4
    // and accum/revealage RTs are single-sample, so they can't share
    // a depth-stencil view. Translucent extrude therefore doesn't
    // depth-test against opaque buildings in this MVP — every
    // translucent fragment writes into accum/revealage regardless of
    // foreground occluders. McGuire-Bavoil weighted blending still
    // mostly hides far translucent fragments via the weight function,
    // but a translucent building behind a tall opaque one will still
    // contribute slightly. Proper depth testing would need either
    // MSAA-resolve of opaque depth into a single-sample texture, or
    // building an MSAA OIT pair (more memory, more complex compose).
    // Deferred — single-sample OIT is the typical industry choice.
    this.fillPipelineExtrudedOIT = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shaderModule, entryPoint: 'vs_main_ecef_extruded', buffers: [extrudedVertexBufferLayout] },
      fragment: { module: shaderModule, entryPoint: 'fs_oit_translucent', targets: oitTargets },
      // Iter 130: cullMode 'back' for OIT translucent extruded path.
      // Liberty's fill-extrusion-opacity=0.8 routes here. Pre-iter-130
      // cull=none made every wall contribute twice to the weighted-
      // blend accum (front wall AND back wall of the same building),
      // raising the building's effective opacity from 0.8 → 0.96 and
      // darkening it noticeably (user-reported on Seoul Liberty z=16
      // pitch=60). Back-face cull drops the inward wall so each
      // building renders at its authored opacity. Trade-off: concave
      // building interiors (dome, courtyard) lose their inward-facing
      // wall when the camera tilts to look inside — acceptable for
      // OFM Liberty's rectangular-block footprint corpus.
      // iter-130: cullMode 'back' for OIT translucent extruded path.
      // (iter-192 attempted depth-write + cullMode='none'; reverted
      // in iter-193 because the offscreen depth attachment didn't
      // pair with the existing OIT accum/revealage bindings cleanly.
      // OIT path is unused by default now — bucket-scheduler keeps
      // isOitExtrude=false — but stays built for future opt-in.)
      primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
      // OIT pass attaches the opaque MSAA depth-stencil so
      // translucent fragments depth-test against the full opaque
      // scene. depthWriteEnabled=false keeps OIT
      // translucent-vs-translucent order independent.
      depthStencil: {
        format: 'depth24plus-stencil8',
        depthCompare: 'less-equal',
        depthWriteEnabled: false,
        stencilFront: { compare: 'always', passOp: 'keep' },
        stencilBack: { compare: 'always', passOp: 'keep' },
        stencilWriteMask: 0x00,
        stencilReadMask: 0x00,
      },
      multisample: msaaState,
      label: 'fill-pipeline-extruded-oit',
    })

    // When picking is off there's no pick attachment to mask, so the
    // no-pick set is identical to the pickable one — alias instead of
    // building duplicates.
    if (pickEnabled) {
      const noPick = buildSet(colorTargetsNoPick, '-nopick')
      this.fillPipelineNoPick = noPick.fill
      this.fillPipelineGroundNoPick = noPick.fillGround
      this.fillPipelineExtrudedNoPick = noPick.fillExtruded
      this.linePipelineNoPick = noPick.line
      this.fillPipelineFallbackNoPick = noPick.fillFallback
      this.fillPipelineGroundFallbackNoPick = noPick.fillGroundFallback
      this.fillPipelineExtrudedFallbackNoPick = noPick.fillExtrudedFallback
      this.linePipelineFallbackNoPick = noPick.lineFallback
    } else {
      this.fillPipelineNoPick = this.fillPipeline
      this.fillPipelineGroundNoPick = this.fillPipelineGround
      this.fillPipelineExtrudedNoPick = this.fillPipelineExtruded
      this.linePipelineNoPick = this.linePipeline
      this.fillPipelineFallbackNoPick = this.fillPipelineFallback
      this.fillPipelineGroundFallbackNoPick = this.fillPipelineGroundFallback
      this.fillPipelineExtrudedFallbackNoPick = this.fillPipelineExtrudedFallback
      this.linePipelineFallbackNoPick = this.linePipelineFallback
    }

    // P1.6 — pointer-events:none no-pick fill Material twins (pick writeMask 0). Only when picking is
    // ON + the flag is on; with picking off the no-pick pipelines alias the pickable set (already
    // routed via _fillMaterials). The non-extrude no-pick pipelines join _fillPerStyle (checked first
    // by recordFillDraw); the extrude no-pick rides the extrude slot's *NoPick fields.
    if (pickEnabled && fillViaRhiEnabled()) {
      const np = buildFlatFillMaterials({
        rhi: this.ctx.rhi, shader: pickShader, format, sampleCount: getSampleCount(),
        bindGroupLayout: this.bindGroupLayout, vertexLayout: vertexBufferLayout, pickEnabled, pickWriteMask: 0,
      })
      this._fillPerStyle.set(this.fillPipelineNoPick, { mat: np.flat, variant: 0 })
      this._fillPerStyle.set(this.fillPipelineFallbackNoPick, { mat: np.flat, variant: 1 })
      this._fillPerStyle.set(this.fillPipelineGroundNoPick, { mat: np.ground, variant: 0 })
      this._fillPerStyle.set(this.fillPipelineGroundFallbackNoPick, { mat: np.ground, variant: 1 })
      this._fillExtrudeMaterialNoPick = buildExtrudeMaterial({
        rhi: this.ctx.rhi, shader: pickShader, format, sampleCount: getSampleCount(),
        bindGroupLayout: this.bindGroupLayout, vertexLayout: extrudedVertexBufferLayout, pickEnabled, pickWriteMask: 0,
      })
    }

    // OIT compose — full-screen quad samples accum + revealage and
    // over-blends the recovered translucent colour onto the
    // (resolved) main framebuffer. With MSAA on, accum + revealage
    // are multisampled; the shader averages every sample to recover
    // a single resolved value. Single-sample (mobile / safe mode)
    // takes the same code path with a 1-sample loop, no branch.
    const oitCompose = buildOitComposePipeline(device, format, getSampleCount())
    this.oitComposeBindGroupLayout = oitCompose.layout
    this.oitComposePipeline = oitCompose.pipeline
  }

  /** Get or create variant pipelines (public for vector tile renderer) */
  getOrCreateVariantPipelines(variant: ShaderVariantInfo): CachedPipeline {
    const cached = this.shaderCache.get(variant.key)
    if (cached) return cached
    const pipelines = this.createVariantPipelines(variant)
    this.shaderCache.set(variant.key, pipelines)
    this.registerFillMaterials(variant, pipelines)
    return pipelines
  }

  /** Cache lookup for MapRenderer.addLayer — it logs only on a MISS
   *  (the per-layer "Specialized shader for layer …" line), so it needs
   *  to distinguish hit from miss rather than always going through
   *  getOrCreateVariantPipelines. Returns the cached set or undefined. */
  getCachedVariant(key: string): CachedPipeline | undefined {
    return this.shaderCache.get(key)
  }

  /** Build + cache a variant pipeline set (addLayer MISS path). */
  cacheVariantPipelines(variant: ShaderVariantInfo): CachedPipeline {
    const pipelines = this.createVariantPipelines(variant)
    this.shaderCache.set(variant.key, pipelines)
    this.registerFillMaterials(variant, pipelines)
    return pipelines
  }

  /** Async prewarm — calls `createRenderPipelineAsync` for every
   *  pipeline in every variant and awaits resolution before
   *  populating `shaderCache`. Subsequent sync
   *  `getOrCreateVariantPipelines` calls in `rebuildLayers` then
   *  hit the cache and the driver is guaranteed to have already
   *  finished compiling.
   *
   *  Why this exists: WebGPU's sync `createRenderPipeline` returns
   *  a pipeline handle immediately while the driver compiles
   *  lazily on first draw. On filter_gdp at z=8 Europe cold-start
   *  this produced a ~1.7 s post-ready hitch frame (CPU profile
   *  showed >60 % `(idle)` — JS thread was waiting for the GPU
   *  queue to drain the inline compile). Switching to the async
   *  variant + awaiting before `__xgisReady` flips moves the
   *  driver work off the user-visible critical path. */
  async prewarmShaderVariantsAsync(variants: ShaderVariantInfo[]): Promise<void> {
    const tasks: Promise<void>[] = []
    for (const v of variants) {
      if (this.shaderCache.has(v.key)) continue
      tasks.push(this.createVariantPipelinesAsync(v).then((pipelines) => {
        this.shaderCache.set(v.key, pipelines)
        this.registerFillMaterials(v, pipelines)
      }))
    }
    if (tasks.length > 0) await Promise.all(tasks)
  }

  /** Build the per-variant pipeline descriptor set + the shared
   *  shader module / layouts. Pure data construction — no GPU calls
   *  beyond shader/layout creation, which the spec defines as
   *  cheap. Used by both sync (`createVariantPipelines`) and async
   *  (`createVariantPipelinesAsync`) entry points so the descriptor
   *  shape stays in one place.
   *
   *  `layoutFor` is injected by MapRenderer so the compute-aware
   *  layout pick (the `variantComputeLayoutCache` branch — COMPUTE
   *  state that STAYS on MapRenderer, plan §5 FB#1) routes through
   *  the coordinator; the factory never owns the compute cache. */
  private buildVariantDescriptors(
    variant: ShaderVariantInfo,
    layoutFor: (v: ShaderVariantInfo) => GPUBindGroupLayout,
  ): {
    descriptors: { fill: GPURenderPipelineDescriptor; fillGround: GPURenderPipelineDescriptor; line: GPURenderPipelineDescriptor; fillFallback: GPURenderPipelineDescriptor; fillGroundFallback: GPURenderPipelineDescriptor; lineFallback: GPURenderPipelineDescriptor }[]
    pickEnabled: boolean
  } {
    const { device, format } = this.ctx
    const wgsl = buildShader(variant)
    const msaaState: GPUMultisampleState = { count: getSampleCount() }
    const pickEnabled = isPickEnabled()
    const colorTargets: GPUColorTargetState[] = [{ format, blend: BLEND_ALPHA }]
    if (pickEnabled) colorTargets.push({ format: 'rg32uint' })
    const colorTargetsNoPick: GPUColorTargetState[] = pickEnabled
      ? [{ format, blend: BLEND_ALPHA }, { format: 'rg32uint', writeMask: 0 }]
      : colorTargets

    const module = device.createShaderModule({
      code: wgsl,
      label: `shader-${variant.key}`,
    })

    // Compute-aware layout pick: extended layout when the variant
    // carries `computeBindings`, otherwise the legacy
    // featureBindGroupLayout / bindGroupLayout. Pipeline + per-layer
    // bind group must agree on the extended layout — both reach the
    // same `getOrBuildVariantLayout` cache entry.
    const layout = layoutFor(variant)
    const layoutLabel = (variant.computeBindings?.length ?? 0) > 0
      ? 'compute'
      : (variant.needsFeatureBuffer ? 'feature' : 'base')
    const pipelineLayout = device.createPipelineLayout({
      label: `mr-variantPipelineLayout(${layoutLabel})`,
      bindGroupLayouts: [layout],
    })

    // Polygon variant fill layout — derived from the single-source
    // POLYGON_FILL_FORMAT spec (same as the base path + packer + WGSL
    // @location), so the variant builders cannot drift from vs_main_ecef.
    const vertexBufferLayout = toVertexBufferLayout(POLYGON_FILL_FORMAT)
    const lineVertexBufferLayout = toVertexBufferLayout(LINE_FORMAT)

    const buildSetDesc = (targets: GPUColorTargetState[], suffix: string) => ({
      fill: {
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_main_ecef', buffers: [vertexBufferLayout] },
        fragment: { module, entryPoint: 'fs_fill', targets },
        primitive: { topology: 'triangle-list' as const, cullMode: 'none' as const },
        depthStencil: STENCIL_WRITE, multisample: msaaState,
        label: `fill-${variant.key}${suffix}`,
      },
      fillGround: {
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_main_ecef', buffers: [vertexBufferLayout] },
        fragment: { module, entryPoint: 'fs_fill', targets },
        primitive: { topology: 'triangle-list' as const, cullMode: 'none' as const },
        depthStencil: STENCIL_WRITE_NO_DEPTH, multisample: msaaState,
        label: `fill-ground-${variant.key}${suffix}`,
      },
      line: {
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_main', buffers: [lineVertexBufferLayout] },
        fragment: { module, entryPoint: 'fs_stroke', targets },
        primitive: { topology: 'line-list' as const, cullMode: 'none' as const },
        depthStencil: STENCIL_WRITE, multisample: msaaState,
        label: `line-${variant.key}${suffix}`,
      },
      fillFallback: {
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_main_ecef', buffers: [vertexBufferLayout] },
        fragment: { module, entryPoint: 'fs_fill', targets },
        primitive: { topology: 'triangle-list' as const, cullMode: 'none' as const },
        depthStencil: STENCIL_TEST, multisample: msaaState,
        label: `fill-fallback-${variant.key}${suffix}`,
      },
      fillGroundFallback: {
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_main_ecef', buffers: [vertexBufferLayout] },
        fragment: { module, entryPoint: 'fs_fill', targets },
        primitive: { topology: 'triangle-list' as const, cullMode: 'none' as const },
        depthStencil: STENCIL_TEST_NO_DEPTH, multisample: msaaState,
        label: `fill-ground-fallback-${variant.key}${suffix}`,
      },
      lineFallback: {
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_main', buffers: [lineVertexBufferLayout] },
        fragment: { module, entryPoint: 'fs_stroke', targets },
        primitive: { topology: 'line-list' as const, cullMode: 'none' as const },
        depthStencil: STENCIL_TEST, multisample: msaaState,
        label: `line-fallback-${variant.key}${suffix}`,
      },
    })

    const descriptors = [buildSetDesc(colorTargets, '')]
    if (pickEnabled) descriptors.push(buildSetDesc(colorTargetsNoPick, '-nopick'))
    return { descriptors, pickEnabled }
  }

  async createVariantPipelinesAsync(variant: ShaderVariantInfo): Promise<CachedPipeline> {
    const { device } = this.ctx
    const { descriptors, pickEnabled } = this.buildVariantDescriptors(variant, this._layoutFor)
    const built = await Promise.all(descriptors.map(async (set) => ({
      fill:               await device.createRenderPipelineAsync(set.fill),
      fillGround:         await device.createRenderPipelineAsync(set.fillGround),
      line:               await device.createRenderPipelineAsync(set.line),
      fillFallback:       await device.createRenderPipelineAsync(set.fillFallback),
      fillGroundFallback: await device.createRenderPipelineAsync(set.fillGroundFallback),
      lineFallback:       await device.createRenderPipelineAsync(set.lineFallback),
    })))
    const p = built[0]
    const np = pickEnabled ? built[1] : p
    return {
      fillPipeline: p.fill,
      fillPipelineGround: p.fillGround,
      linePipeline: p.line,
      fillPipelineFallback: p.fillFallback,
      fillPipelineGroundFallback: p.fillGroundFallback,
      linePipelineFallback: p.lineFallback,
      fillPipelineNoPick: np.fill,
      fillPipelineGroundNoPick: np.fillGround,
      linePipelineNoPick: np.line,
      fillPipelineFallbackNoPick: np.fillFallback,
      fillPipelineGroundFallbackNoPick: np.fillGroundFallback,
      linePipelineFallbackNoPick: np.lineFallback,
    }
  }

  createVariantPipelines(variant: ShaderVariantInfo): CachedPipeline {
    const { device, format } = this.ctx
    const wgsl = buildShader(variant)
    const msaaState: GPUMultisampleState = { count: getSampleCount() }
    const pickEnabled = isPickEnabled()
    const colorTargets: GPUColorTargetState[] = [{ format, blend: BLEND_ALPHA }]
    if (pickEnabled) colorTargets.push({ format: 'rg32uint' })
    const colorTargetsNoPick: GPUColorTargetState[] = pickEnabled
      ? [{ format, blend: BLEND_ALPHA }, { format: 'rg32uint', writeMask: 0 }]
      : colorTargets

    const module = device.createShaderModule({
      code: wgsl,
      label: `shader-${variant.key}`,
    })

    // Use the compute-aware layout (extended when variant carries
    // computeBindings, legacy otherwise). Matches `buildVariantDescriptors`
    // above so the cache key + pipeline layout stay in sync.
    const layout = this._layoutFor(variant)
    const layoutLabel = (variant.computeBindings?.length ?? 0) > 0
      ? 'compute'
      : (variant.needsFeatureBuffer ? 'feature' : 'base')
    const pipelineLayout = device.createPipelineLayout({
      label: `mr-variantPipelineLayout(${layoutLabel})`,
      bindGroupLayouts: [layout],
    })

    // Polygon variant fill layout — derived from the single-source
    // POLYGON_FILL_FORMAT spec (same as the base path + packer + WGSL
    // @location), so the variant builders cannot drift from vs_main_ecef.
    const vertexBufferLayout = toVertexBufferLayout(POLYGON_FILL_FORMAT)
    const lineVertexBufferLayout = toVertexBufferLayout(LINE_FORMAT)

    const buildSet = (targets: GPUColorTargetState[], suffix: string) => ({
      fill: device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_main_ecef', buffers: [vertexBufferLayout] },
        fragment: { module, entryPoint: 'fs_fill', targets },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: STENCIL_WRITE, multisample: msaaState,
        label: `fill-${variant.key}${suffix}`,
      }),
      // Ground (depth-disabled) variant — coplanar painter's-order
      // resolve for `extrude.kind === 'none'` layers. Mirrors the
      // unconditional `fillPipelineGround` (renderer.ts:983) so
      // variant-driven ground layers don't write depth and force
      // z-fighting against subsequent coplanar layers in the same
      // source. Required after b98c449/e655b25 began routing variant
      // shows away from the base-only fillPipelineGround substitution.
      fillGround: device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_main_ecef', buffers: [vertexBufferLayout] },
        fragment: { module, entryPoint: 'fs_fill', targets },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: STENCIL_WRITE_NO_DEPTH, multisample: msaaState,
        label: `fill-ground-${variant.key}${suffix}`,
      }),
      line: device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_main', buffers: [lineVertexBufferLayout] },
        fragment: { module, entryPoint: 'fs_stroke', targets },
        primitive: { topology: 'line-list', cullMode: 'none' },
        depthStencil: STENCIL_WRITE, multisample: msaaState,
        label: `line-${variant.key}${suffix}`,
      }),
      fillFallback: device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_main_ecef', buffers: [vertexBufferLayout] },
        fragment: { module, entryPoint: 'fs_fill', targets },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: STENCIL_TEST, multisample: msaaState,
        label: `fill-fallback-${variant.key}${suffix}`,
      }),
      // Ground depth-disabled fallback variant — same role as
      // `fillGround` but for the parent-ancestor fallback path
      // (stencil test, no stencil write). Without this the
      // ancestor draw path keeps writing depth which would block
      // siblings during the brief "current zoom missing, parent
      // showing" window.
      fillGroundFallback: device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_main_ecef', buffers: [vertexBufferLayout] },
        fragment: { module, entryPoint: 'fs_fill', targets },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: STENCIL_TEST_NO_DEPTH, multisample: msaaState,
        label: `fill-ground-fallback-${variant.key}${suffix}`,
      }),
      lineFallback: device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs_main', buffers: [lineVertexBufferLayout] },
        fragment: { module, entryPoint: 'fs_stroke', targets },
        primitive: { topology: 'line-list', cullMode: 'none' },
        depthStencil: STENCIL_TEST, multisample: msaaState,
        label: `line-fallback-${variant.key}${suffix}`,
      }),
    })

    const p = buildSet(colorTargets, '')
    const np = pickEnabled ? buildSet(colorTargetsNoPick, '-nopick') : p

    return {
      fillPipeline: p.fill,
      fillPipelineGround: p.fillGround,
      linePipeline: p.line,
      fillPipelineFallback: p.fillFallback,
      fillPipelineGroundFallback: p.fillGroundFallback,
      linePipelineFallback: p.lineFallback,
      fillPipelineNoPick: np.fill,
      fillPipelineGroundNoPick: np.fillGround,
      linePipelineNoPick: np.line,
      fillPipelineFallbackNoPick: np.fillFallback,
      fillPipelineGroundFallbackNoPick: np.fillGroundFallback,
      linePipelineFallbackNoPick: np.lineFallback,
    }
  }

  /** Compute-aware layout resolver. Injected by MapRenderer via
   *  `setLayoutResolver` so the variant pipeline builders route the
   *  compute-extended layout pick (the `variantComputeLayoutCache`
   *  branch) through the coordinator — that cache is COMPUTE-cluster
   *  state and STAYS on MapRenderer (plan §5 FB#1). Defaults to the
   *  factory's own non-compute lookup until MapRenderer wires the real
   *  resolver in its ctor (after `_pipelines` is built). */
  private _layoutFor: (v: ShaderVariantInfo) => GPUBindGroupLayout =
    (v) => this.getOrBuildVariantLayout(v)

  /** Inject the coordinator's compute-aware layout resolver. */
  setLayoutResolver(resolver: (v: ShaderVariantInfo) => GPUBindGroupLayout): void {
    this._layoutFor = resolver
  }
}
