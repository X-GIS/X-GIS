// ═══ X-GIS Frame Renderer — engine half (RHI / ring / pipeline machinery) ═══
//
// Step 1 of the P2 engine carve (docs/architecture/p2-engine-carve-plan.md):
// FrameRenderer is the CONTENT-BLIND engine half split out of the former
// `MapRenderer` god-object. It owns the RHI / ring / pipeline MACHINERY — the
// GPUContext, the PipelineFactory (+ its per-field delegating getters), the
// shared UniformRing, the compute-paint path, the pipeline rebuild, and the
// lazy compose pipelines. It holds NO content type (`ShowCommand`,
// `StyleProperties`, `RenderLayer`, atlas views) — those live in
// `MapRendererContent` (renderer.ts), which holds a FrameRenderer reference
// and reaches this machinery ONLY through the public methods / getters below.
// FrameRenderer holds NO back-reference to content.

import type { GPUContext, WebGpuDevice } from '@xgis/rhi-webgpu'
import { ComputeDispatcher } from '@xgis/rhi-webgpu'
import { ComputeLayerRegistry } from './compute-layer-registry'
import { extendBindGroupLayoutEntriesForCompute } from '@xgis/rhi-webgpu'
import type { ShaderVariantInfo, CachedPipeline } from './renderer-types'
import { UniformRing } from './uniform-ring'
import { PipelineFactory } from './pipeline-factory'
import { polygonUniformStride } from './polygon-uniform-slots'
import { markStart as perfMarkStart, markEnd as perfMarkEnd } from '../__profile__/perf-marks'

// ═══ FrameRenderer ═══

export class FrameRenderer {
  private ctx: GPUContext
  /** Pipeline-construction collaborator (Unit 1 of
   *  renderer-decomposition-2026-06-09). Owns every render pipeline +
   *  bind-group layout + the atlas STUB textures + the shared sampler +
   *  the per-variant shader cache. Built in the ctor; the external read
   *  contract (map.ts / source-manager.ts push these fields into VTR's
   *  set*Pipelines) is preserved by the per-field delegating getters
   *  below — byte-identical external API, ZERO call-site changes. The
   *  factory holds NO back-reference to FrameRenderer. */
  private readonly _pipelines: PipelineFactory
  // ── Per-field delegating getters: the external pipeline-field read
  //    contract (plan §0) — every field map.ts / source-manager.ts /
  //    the OIT/opaque passes read MUST stay readable. ──
  get fillPipeline(): GPURenderPipeline {
    return this._pipelines.fillPipeline
  }
  /** P1.6 — the polygon flat-fill RHI Material twins + pipeline refs for VectorTileRenderer.setFillRhi. */
  fillRhiState(): import('./material/polygon-fill-material').FillRhiState | null {
    return this._pipelines.fillRhiState()
  }
  get fillPipelineGround(): GPURenderPipeline {
    return this._pipelines.fillPipelineGround
  }
  get fillPipelineExtruded(): GPURenderPipeline {
    return this._pipelines.fillPipelineExtruded
  }
  get fillPipelineExtrudedOIT(): GPURenderPipeline {
    return this._pipelines.fillPipelineExtrudedOIT
  }
  get oitComposePipeline(): GPURenderPipeline {
    return this._pipelines.oitComposePipeline
  }
  get oitComposeBindGroupLayout(): GPUBindGroupLayout {
    return this._pipelines.oitComposeBindGroupLayout
  }
  get overdrawComposePipeline(): GPURenderPipeline | null {
    return this._pipelines.overdrawComposePipeline
  }
  get overdrawComposeBindGroupLayout(): GPUBindGroupLayout {
    return this._pipelines.overdrawComposeBindGroupLayout
  }
  get heatmapBlurBindGroupLayout(): GPUBindGroupLayout {
    return this._pipelines.heatmapBlurBindGroupLayout
  }
  get heatmapComposeBindGroupLayout(): GPUBindGroupLayout {
    return this._pipelines.heatmapComposeBindGroupLayout
  }
  get fillPipelineOverdraw(): GPURenderPipeline | null {
    return this._pipelines.fillPipelineOverdraw
  }
  get fillPipelineOverdrawFeature(): GPURenderPipeline | null {
    return this._pipelines.fillPipelineOverdrawFeature
  }
  get linePipelineOverdraw(): GPURenderPipeline | null {
    return this._pipelines.linePipelineOverdraw
  }
  get linePipeline(): GPURenderPipeline {
    return this._pipelines.linePipeline
  }
  get fillPipelineFallback(): GPURenderPipeline {
    return this._pipelines.fillPipelineFallback
  }
  get fillPipelineGroundFallback(): GPURenderPipeline {
    return this._pipelines.fillPipelineGroundFallback
  }
  get fillPipelineExtrudedFallback(): GPURenderPipeline {
    return this._pipelines.fillPipelineExtrudedFallback
  }
  get fillPipelinePatternGround(): GPURenderPipeline {
    return this._pipelines.fillPipelinePatternGround
  }
  get fillPipelinePatternGroundFallback(): GPURenderPipeline {
    return this._pipelines.fillPipelinePatternGroundFallback
  }
  get fillPipelinePatternExtruded(): GPURenderPipeline {
    return this._pipelines.fillPipelinePatternExtruded
  }
  get fillPipelinePatternExtrudedFallback(): GPURenderPipeline {
    return this._pipelines.fillPipelinePatternExtrudedFallback
  }
  get linePipelineFallback(): GPURenderPipeline {
    return this._pipelines.linePipelineFallback
  }
  get fillPipelineNoPick(): GPURenderPipeline {
    return this._pipelines.fillPipelineNoPick
  }
  get fillPipelineGroundNoPick(): GPURenderPipeline {
    return this._pipelines.fillPipelineGroundNoPick
  }
  get fillPipelineExtrudedNoPick(): GPURenderPipeline {
    return this._pipelines.fillPipelineExtrudedNoPick
  }
  get linePipelineNoPick(): GPURenderPipeline {
    return this._pipelines.linePipelineNoPick
  }
  get fillPipelineFallbackNoPick(): GPURenderPipeline {
    return this._pipelines.fillPipelineFallbackNoPick
  }
  get fillPipelineGroundFallbackNoPick(): GPURenderPipeline {
    return this._pipelines.fillPipelineGroundFallbackNoPick
  }
  get fillPipelineExtrudedFallbackNoPick(): GPURenderPipeline {
    return this._pipelines.fillPipelineExtrudedFallbackNoPick
  }
  get linePipelineFallbackNoPick(): GPURenderPipeline {
    return this._pipelines.linePipelineFallbackNoPick
  }
  get bindGroupLayout(): GPUBindGroupLayout {
    return this._pipelines.bindGroupLayout
  }
  get featureBindGroupLayout(): GPUBindGroupLayout {
    return this._pipelines.featureBindGroupLayout
  }
  /** Palette/sprite sampler — owned by the factory (shared by both
   *  atlases at bindings 4 + 6). In the external read contract
   *  (map.ts:557 / source-manager.ts). */
  get paletteSampler(): GPUSampler {
    return this._pipelines.paletteSampler
  }
  /** The factory's 1×1 transparent palette + white sprite STUB views.
   *  MapRendererContent seeds its LIVE atlas views from these at ctor
   *  time (plan §5 FB#3) before the real atlases land. */
  get paletteStubTextureView(): GPUTextureView {
    return this._pipelines.paletteStubTextureView
  }
  get spriteAtlasStubTextureView(): GPUTextureView {
    return this._pipelines.spriteAtlasStubTextureView
  }
  private uniformRing!: UniformRing
  /** Live uniform ring buffer. Public — read by the OIT / opaque /
   *  translucent passes via `host.renderer.uniformBuffer` (routed through
   *  MapRendererContent's delegating getter). Delegates to the shared
   *  UniformRing so those callers keep working unchanged. */
  get uniformBuffer(): GPUBuffer {
    // The ring is RHI-neutral (#832 M2); this getter is the WebGPU frame
    // path's seam, so the native unwrap lives here (never called on webgl2 —
    // the forced-WebGL2 frame renders via renderFrameViaRhi).
    return (this.ctx.rhi as WebGpuDevice).unwrapBuffer(this.uniformRing.rhiBuffer!)
  }
  /** The shared UniformRing itself — MapRendererContent hands it to the
   *  graticule collaborator per frame (renderToPass). */
  get uniformRingHandle(): UniformRing {
    return this.uniformRing
  }

  // Compute-paint scaffolding (plan P4-5). Lazily initialised on the
  // first request — the registry owns ComputeLayerHandle instances
  // and dispatches their kernels once per frame. Stays null until a
  // variant with `computeBindings` is encountered, so the production
  // path (no enableComputePath flag) pays nothing.
  private computeRegistry: ComputeLayerRegistry | null = null
  private computeDispatcher: ComputeDispatcher | null = null
  /** Per-variant cached extended bind-group layout (legacy feature
   *  entries + one read-only-storage per computeBindings spec). Keyed
   *  by `variant.key` — same key as `shaderCache` so a cache hit on
   *  one implies a hit on the other. Pipelines built against the
   *  legacy `featureBindGroupLayout` use that directly; compute
   *  variants take a freshly-built per-variant layout from here. */
  private variantComputeLayoutCache = new Map<string, GPUBindGroupLayout>()
  /** Scene plan provided by the orchestrator before addLayer is
   *  called. ComputeLayerHandle filters this by renderNodeIndex —
   *  the runtime never holds an opinion about which subset goes
   *  where; the variant.computeBindings + plan filter agree by
   *  construction (compiler post-condition). Read by
   *  MapRendererContent.addLayer via the `computePlan` getter. */
  private currentComputePlan: readonly import('@xgis/compiler').ComputePlanEntry[] | undefined

  constructor(ctx: GPUContext) {
    this.ctx = ctx
    // Unit 1 split (plan §5 FB#4): the factory builds layouts → pipelines
    // → atlas stubs (its ctor calls build()). The live atlas-view seed +
    // the uniform-ring build (the ring-tail that STAYS here) are driven by
    // MapRendererContent: it seeds the LIVE atlas views from the factory's
    // 1×1 stubs, then calls `initUniformRing(...)`. ORDER is load-bearing
    // (DO-NOT-SPLIT #2): the factory finishes layout + pipeline + stub
    // creation BEFORE the ring bind groups reference `bindGroupLayout`.
    this._pipelines = new PipelineFactory(ctx)
    // Route the variant pipeline builders' compute-aware layout pick back
    // through FrameRenderer's getOrBuildVariantLayout — the
    // `variantComputeLayoutCache` (compute branch) is COMPUTE-cluster
    // state that STAYS here (plan §5 FB#1); the factory's own resolver
    // only covers the non-compute base layouts.
    this._pipelines.setLayoutResolver((v) => this.getOrBuildVariantLayout(v))
  }

  /** Build the per-draw uniform ring + fire its first bind-group build.
   *  Called by MapRendererContent AFTER it has seeded the live atlas views,
   *  so the `onGrow` callback (content's per-frame bind-group rebuild) sees
   *  a fully-initialised content half. Preserves the original MapRenderer
   *  ctor order: PipelineFactory build → atlas-view seed → ring create +
   *  ensure().
   *
   *  Uniform ring buffer: 240-byte slots (shared polygon/line struct), 256-slot
   *  initial capacity, dynamic offsets per draw. Guarantees that multi-layer
   *  draws don't overwrite each other's uniforms. ensure() fires the onGrow
   *  callback → builds the content's base bindGroup (and the per-layer loop,
   *  empty at init since no layers are registered yet), faithfully replacing
   *  the inline build at the same point in init. */
  initUniformRing(onGrow: () => void): void {
    this.uniformRing = new UniformRing(
      this.ctx.rhi,
      polygonUniformStride(),
      256,
      'uniform-ring',
      onGrow,
      () => perfMarkStart('uniform-ring.grow'),
      () => perfMarkEnd('uniform-ring.grow'),
    )
    this.uniformRing.ensure()
  }

  /** Get-or-create the compute registry. Lazy because most scenes
   *  don't use the compute path; we don't want to allocate the
   *  dispatcher unless we actually have a compute kernel to run.
   *  Public so MapRendererContent.addLayer can attach handles. */
  ensureComputeRegistry(): ComputeLayerRegistry {
    if (this.computeRegistry) return this.computeRegistry
    this.computeDispatcher = new ComputeDispatcher(this.ctx)
    this.computeRegistry = new ComputeLayerRegistry(this.computeDispatcher)
    return this.computeRegistry
  }

  /** The live compute registry (or null before the first attach). Read by
   *  MapRendererContent.setPaletteColorAtlas / setSpriteAtlas / clearLayers. */
  get registry(): ComputeLayerRegistry | null {
    return this.computeRegistry
  }

  /** The scene compute plan handed in via setComputePlan. Read by
   *  MapRendererContent.addLayer. */
  get computePlan(): readonly import('@xgis/compiler').ComputePlanEntry[] | undefined {
    return this.currentComputePlan
  }

  /** Run every attached compute kernel onto the encoder. Call ONCE
   *  per frame from the orchestrator (map.ts) BEFORE the first
   *  beginRenderPass — compute output buffers must be populated
   *  before the fragment shader reads them.
   *
   *  No-op when no compute layer is attached (the registry is null
   *  or empty). Safe to call unconditionally from the orchestrator. */
  dispatchComputePass(
    encoder: GPUCommandEncoder,
    timestampWritesProvider?: { computeWrites(): GPUComputePassTimestampWrites | null } | null,
  ): void {
    this.computeRegistry?.dispatchAll(encoder, timestampWritesProvider)
  }

  /** Hand the scene's compute plan to the renderer before issuing
   *  addLayer calls. ComputeLayerHandle filters the plan by
   *  `show.renderNodeIndex`; calling this with `undefined` clears
   *  the plan (back-compat for scenes without compute kernels). */
  setComputePlan(plan: readonly import('@xgis/compiler').ComputePlanEntry[] | undefined): void {
    this.currentComputePlan = plan
  }

  /** Return the bind-group layout the renderer should bind for a
   *  given variant. Variants without `computeBindings` keep using
   *  the shared `featureBindGroupLayout`; variants WITH compute
   *  bindings get a per-key extended layout (cached). The returned
   *  layout matches the bind-group entries `addLayer` constructs
   *  for the same variant — drift between the two surfaces as a
   *  WebGPU validation error at pipeline / bind-group create.
   *
   *  Public so VTR / point-renderer (which build their own per-tile
   *  bind groups against this same layout) can request the right
   *  layout per variant during their setBindGroupLayout / pipeline-
   *  build call sites. */
  getOrBuildVariantLayout(variant: ShaderVariantInfo): GPUBindGroupLayout {
    if (!variant.computeBindings || variant.computeBindings.length === 0) {
      // Non-compute half — a trivial read of the two factory-owned base
      // layouts (plan §5 FB#1 split). Forwarded to the factory.
      return this._pipelines.getOrBuildVariantLayout(variant)
    }
    // Compute half — STAYS on FrameRenderer. The `variantComputeLayoutCache`
    // is COMPUTE-cluster state keyed by `variant.key` (same key as the
    // factory's shaderCache) and MUST stay consistent with the bind-group
    // entries addLayer constructs — plan §5 FB#1, NOT factory state.
    const cached = this.variantComputeLayoutCache.get(variant.key)
    if (cached) return cached
    // Build extended entries from the legacy feature entries (the
    // single source of truth for the polygon path's uniform / feature-
    // data / palette layout). `extendBindGroupLayoutEntriesForCompute`
    // appends one read-only-storage entry per computeBindings spec at
    // the binding indices the compiler chose. The base entries live on
    // the factory (PipelineFactory.FEATURE_LAYOUT_ENTRIES) so the two
    // layouts cannot drift.
    const legacy = PipelineFactory.getFeatureLayoutEntries()
    // FRAGMENT bit = 2 (raw spec value; see FEATURE_LAYOUT_ENTRIES
    // comment for why we don't reference GPUShaderStage here).
    const extended = extendBindGroupLayoutEntriesForCompute(variant, legacy, /* FRAGMENT */ 2)
    const layout = this.ctx.device.createBindGroupLayout({
      label: `mr-featureBindGroupLayout-compute(${variant.key})`,
      entries: extended as GPUBindGroupLayoutEntry[],
    })
    this.variantComputeLayoutCache.set(variant.key, layout)
    return layout
  }

  /** Public mirror of the factory's PALETTE_LAYOUT_ENTRIES for the
   *  bind-group-drift invariant test (`bind-group-drift.test.ts` reads
   *  `FrameRenderer.PALETTE_LAYOUT_ENTRIES`). The canonical array lives on
   *  PipelineFactory after Unit 1 — forwarded here so the external
   *  static read contract stays byte-identical. Same array; do not
   *  duplicate. */
  static readonly PALETTE_LAYOUT_ENTRIES: readonly GPUBindGroupLayoutEntry[] =
    PipelineFactory.PALETTE_LAYOUT_ENTRIES

  /** Public mirror of the factory's FEATURE_LAYOUT_ENTRIES for the drift
   *  invariant test (`bind-group-drift.test.ts` reads
   *  `FrameRenderer.getFeatureLayoutEntries()`). The canonical array lives
   *  on PipelineFactory after Unit 1. Same array; do not duplicate. */
  static getFeatureLayoutEntries(): readonly GPUBindGroupLayoutEntry[] {
    return PipelineFactory.getFeatureLayoutEntries()
  }

  /** Rebuild all pipelines + invalidate shader variant cache. Called by
   *  `map.setQuality()` when MSAA or picking flip at runtime — both force
   *  a pipeline `sampleCount` / fragment-target-count change that's baked
   *  at pipeline creation. Non-pipeline state (bind group layouts, the
   *  uniform ring, graticule geometry) survives the rebuild unchanged.
   *
   *  Forwarder (plan §6 DO-NOT-SPLIT #3): clears FrameRenderer's
   *  `variantComputeLayoutCache` (COMPUTE-cluster, FB#1) FIRST, then
   *  `_pipelines.rebuild()` clears the factory's shaderCache + rebuilds
   *  every pipeline. Both caches are keyed by `variant.key` and MUST be
   *  invalidated in lockstep — pinned by map-set-quality-invariant.test.ts
   *  (regression 6080a2f). */
  rebuildForQuality(): void {
    // Toss the per-show variant pipelines — their shader embeds the
    // PICK markers too, and their `multisample.count` is frozen.
    // map.setQuality (the only caller) follows up with an eager
    // re-resolve loop over vectorTileShows that calls
    // getOrCreateVariantPipelines + getOrBuildVariantLayout so
    // pipelines AND layouts stay self-consistent. Lazy rebuild from the
    // draw path was previously promised in a comment here but never
    // wired — that promise let entry.pipelines stay null with
    // entry.layout still feature/compute, tripping per-frame
    // BindGroupLayout validation (see commit 6080a2f).
    this.variantComputeLayoutCache.clear()
    this._pipelines.rebuild()
  }

  /** Lazy-build the `?debug=overdraw` final compose pipeline. Thin
   *  forwarder to the factory (the external read site is
   *  overdraw-compose-pass.ts:25 `host.renderer.ensureOverdrawCompose()`). */
  ensureOverdrawCompose(): GPURenderPipeline {
    return this._pipelines.ensureOverdrawCompose()
  }

  /** Lazy-build the heatmap blur pipeline (Phase R). Thin forwarder to the
   *  factory; the external read site is heatmap-pass.ts. */
  ensureHeatmapBlur(): GPURenderPipeline {
    return this._pipelines.ensureHeatmapBlur()
  }

  /** Lazy-build the heatmap compose pipeline (Phase R). Thin forwarder to the
   *  factory; the external read site is heatmap-pass.ts. */
  ensureHeatmapCompose(): GPURenderPipeline {
    return this._pipelines.ensureHeatmapCompose()
  }

  /** Reset the ring-buffer slot cursor. Call once per frame before any draws. */
  beginFrame(): void {
    this.uniformRing.resetSlot()
    for (const b of this.uniformRing.takeRetired()) this.ctx.rhi.destroyBuffer(b)
  }

  /** Copy a draw's uniform block into the staging mirror; tracked by
   *  dirty range so endFrame() can emit one writeBuffer instead of
   *  one per draw. Same pattern as VTR.stageUniformSlot. Public — called
   *  by MapRendererContent.renderToPass. */
  stageUniformSlot(slotOffset: number, src: ArrayBuffer): void {
    this.uniformRing.stageSlot(slotOffset, src)
  }

  /** Flush the staged uniform bytes before queue.submit(). Safe to
   *  call any number of times per frame — a no-op when no slots have
   *  been staged since the last flush. */
  endFrame(): void {
    this.uniformRing.flush()
  }

  /** Allocate the next ring slot. Public — called by
   *  MapRendererContent.renderToPass. */
  allocUniformSlot(): number {
    return this.uniformRing.allocSlot()
  }

  /** Cache lookup for MapRendererContent.addLayer — it logs only on a MISS
   *  (so the split getCachedVariant / cacheVariantPipelines stays intact). */
  getCachedVariant(key: string): CachedPipeline | undefined {
    return this._pipelines.getCachedVariant(key)
  }

  /** Build + cache the specialized pipelines for a variant. Forwarder to
   *  the factory (Unit 1). */
  cacheVariantPipelines(variant: ShaderVariantInfo): CachedPipeline {
    return this._pipelines.cacheVariantPipelines(variant)
  }

  /** Get or create variant pipelines (public for vector tile renderer).
   *  Thin forwarder — the shaderCache + construction live on the factory
   *  (Unit 1). External callers (map.ts:1540/2232/2276/2417/2520) unchanged. */
  getOrCreateVariantPipelines(variant: ShaderVariantInfo): CachedPipeline {
    return this._pipelines.getOrCreateVariantPipelines(variant)
  }

  /** Async prewarm — forwarder to the factory's
   *  prewarmShaderVariantsAsync (cold-start path; map.ts:2055). */
  async prewarmShaderVariantsAsync(variants: ShaderVariantInfo[]): Promise<void> {
    return this._pipelines.prewarmShaderVariantsAsync(variants)
  }
}
