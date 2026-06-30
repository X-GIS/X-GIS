// ═══ X-GIS Map Renderer — WebGPU ═══

import type { GPUContext } from '../gpu/gpu'
import type { Camera } from '../projection/camera'
import type { MeshData, LineMeshData } from '../../loader/geojson'
import { DEBUG_OVERDRAW } from '../debug-flags'
import { resolveNumberShape, resolveColorShape } from './paint-shape-resolve'
import { ComputeDispatcher } from '../gpu/compute'
import { ComputeLayerRegistry } from './compute-layer-registry'
import { extendBindGroupLayoutEntriesForCompute } from './compute-bind-layout'
import type { ShaderVariantInfo, CachedPipeline, ShowCommand, RenderLayer } from './renderer-types'
import { parseColor } from './renderer-helpers'
import { UniformRing } from './uniform-ring'
import { GraticuleRenderer } from './graticule-renderer'
import { PipelineFactory } from './pipeline-factory'
import { polygonUniformBytes, polygonUniformStride, polygonUniformSlots } from './polygon-uniform-slots'
import { writeFrameProjectionUniform } from './frame-projection-uniform'

// Re-export the extracted types so this module's public surface stays
// byte-identical (external consumers import these from './renderer').
export type { ShaderVariantInfo, CachedPipeline, Easing, ShowCommand } from './renderer-types'
// Re-export the extracted pure interpolators (external consumers + tests
// import these from './renderer').
export {
  interpolateZoom, interpolateZoomRgba, interpolateTime, interpolateTimeColor,
} from './renderer-helpers'

// ═══ Show command (parsed from AST) ═══
// `ShowCommand` + `Easing` moved to renderer-types.ts (re-exported above).

/**
 * Dynamic property store — X-GIS 속성을 런타임에 변경 가능.
 * 컴파일된 기본값 + 클라이언트 오버라이드.
 */
export class StyleProperties {
  private defaults = new Map<string, unknown>()
  private overrides = new Map<string, unknown>()

  setDefault(key: string, value: unknown): void {
    this.defaults.set(key, value)
  }

  set(key: string, value: unknown): void {
    this.overrides.set(key, value)
  }

  get(key: string): unknown {
    return this.overrides.get(key) ?? this.defaults.get(key)
  }

  getColor(key: string): [number, number, number, number] | null {
    const v = this.get(key)
    if (typeof v === 'string') return parseColor(v)
    if (v === null || v === undefined) return null
    return v as [number, number, number, number]
  }

  getNumber(key: string, fallback = 0): number {
    const v = this.get(key)
    if (typeof v === 'number') return v
    return fallback
  }

  getBool(key: string, fallback = true): boolean {
    const v = this.get(key)
    if (typeof v === 'boolean') return v
    return fallback
  }

  reset(key: string): void {
    this.overrides.delete(key)
  }

  resetAll(): void {
    this.overrides.clear()
  }

  /** List all property names */
  keys(): string[] {
    return [...new Set([...this.defaults.keys(), ...this.overrides.keys()])]
  }
}

// ═══ MapRenderer ═══

export class MapRenderer {
  private ctx: GPUContext
  // Cached per-frame allocation (avoid GC pressure in render loop). Sized to
  // the polygon Uniforms struct byte count (reflect-derived via
  // polygonUniformBytes()). Out-of-bounds typed-array writes are silent no-ops
  // so a mismatch here = uniform never reaches the GPU.
  private uniformDataBuf = new ArrayBuffer(polygonUniformBytes())
  // Polygon Uniforms stride / bind-range size are read LAZILY via
  // polygonUniformStride() / polygonUniformBytes() (memoised) at ctor/draw time.
  // They MUST NOT be `static readonly` fields: polygonUniformBytes() reflects the
  // polygon module = a projection emit, which throws until configureProjections()
  // has run (post-GPU-init), and a static field evaluates at class-definition
  // (IMPORT) time — that crashed the entire map init. The BGL omits minBindingSize,
  // so a smaller bind `size` than the shader-derived struct fails draw validation.
  /** Pipeline-construction collaborator (Unit 1 of
   *  renderer-decomposition-2026-06-09). Owns every render pipeline +
   *  bind-group layout + the atlas STUB textures + the shared sampler +
   *  the per-variant shader cache. Built in the ctor; the external read
   *  contract (map.ts / source-manager.ts push these fields into VTR's
   *  set*Pipelines) is preserved by the per-field delegating getters
   *  below — byte-identical external API, ZERO call-site changes. The
   *  factory holds NO back-reference to MapRenderer. */
  private readonly _pipelines: PipelineFactory
  // ── Per-field delegating getters: the external pipeline-field read
  //    contract (plan §0) — every field map.ts / source-manager.ts /
  //    the OIT/opaque passes read MUST stay readable on MapRenderer. ──
  get fillPipeline(): GPURenderPipeline { return this._pipelines.fillPipeline }
  get fillFlatMaterial(): import('./material/material').Material | undefined { return this._pipelines.fillFlatMaterial }
  get fillGroundMaterial(): import('./material/material').Material | undefined { return this._pipelines.fillGroundMaterial }
  get fillPipelineGround(): GPURenderPipeline { return this._pipelines.fillPipelineGround }
  get fillPipelineExtruded(): GPURenderPipeline { return this._pipelines.fillPipelineExtruded }
  get fillPipelineExtrudedOIT(): GPURenderPipeline { return this._pipelines.fillPipelineExtrudedOIT }
  get oitComposePipeline(): GPURenderPipeline { return this._pipelines.oitComposePipeline }
  get oitComposeBindGroupLayout(): GPUBindGroupLayout { return this._pipelines.oitComposeBindGroupLayout }
  get overdrawComposePipeline(): GPURenderPipeline | null { return this._pipelines.overdrawComposePipeline }
  get overdrawComposeBindGroupLayout(): GPUBindGroupLayout { return this._pipelines.overdrawComposeBindGroupLayout }
  get heatmapBlurBindGroupLayout(): GPUBindGroupLayout { return this._pipelines.heatmapBlurBindGroupLayout }
  get heatmapComposeBindGroupLayout(): GPUBindGroupLayout { return this._pipelines.heatmapComposeBindGroupLayout }
  get fillPipelineOverdraw(): GPURenderPipeline | null { return this._pipelines.fillPipelineOverdraw }
  get fillPipelineOverdrawFeature(): GPURenderPipeline | null { return this._pipelines.fillPipelineOverdrawFeature }
  get linePipelineOverdraw(): GPURenderPipeline | null { return this._pipelines.linePipelineOverdraw }
  get linePipeline(): GPURenderPipeline { return this._pipelines.linePipeline }
  get fillPipelineFallback(): GPURenderPipeline { return this._pipelines.fillPipelineFallback }
  get fillPipelineGroundFallback(): GPURenderPipeline { return this._pipelines.fillPipelineGroundFallback }
  get fillPipelineExtrudedFallback(): GPURenderPipeline { return this._pipelines.fillPipelineExtrudedFallback }
  get fillPipelinePatternGround(): GPURenderPipeline { return this._pipelines.fillPipelinePatternGround }
  get fillPipelinePatternGroundFallback(): GPURenderPipeline { return this._pipelines.fillPipelinePatternGroundFallback }
  get fillPipelinePatternExtruded(): GPURenderPipeline { return this._pipelines.fillPipelinePatternExtruded }
  get fillPipelinePatternExtrudedFallback(): GPURenderPipeline { return this._pipelines.fillPipelinePatternExtrudedFallback }
  get linePipelineFallback(): GPURenderPipeline { return this._pipelines.linePipelineFallback }
  get fillPipelineNoPick(): GPURenderPipeline { return this._pipelines.fillPipelineNoPick }
  get fillPipelineGroundNoPick(): GPURenderPipeline { return this._pipelines.fillPipelineGroundNoPick }
  get fillPipelineExtrudedNoPick(): GPURenderPipeline { return this._pipelines.fillPipelineExtrudedNoPick }
  get linePipelineNoPick(): GPURenderPipeline { return this._pipelines.linePipelineNoPick }
  get fillPipelineFallbackNoPick(): GPURenderPipeline { return this._pipelines.fillPipelineFallbackNoPick }
  get fillPipelineGroundFallbackNoPick(): GPURenderPipeline { return this._pipelines.fillPipelineGroundFallbackNoPick }
  get fillPipelineExtrudedFallbackNoPick(): GPURenderPipeline { return this._pipelines.fillPipelineExtrudedFallbackNoPick }
  get linePipelineFallbackNoPick(): GPURenderPipeline { return this._pipelines.linePipelineFallbackNoPick }
  get bindGroupLayout(): GPUBindGroupLayout { return this._pipelines.bindGroupLayout }
  get featureBindGroupLayout(): GPUBindGroupLayout { return this._pipelines.featureBindGroupLayout }
  /** Palette/sprite sampler — owned by the factory (shared by both
   *  atlases at bindings 4 + 6). In the external read contract
   *  (map.ts:557 / source-manager.ts). */
  get paletteSampler(): GPUSampler { return this._pipelines.paletteSampler }
  private uniformRing!: UniformRing
  /** Live uniform ring buffer. Public — read by the OIT / opaque /
   *  translucent passes via `host.renderer.uniformBuffer`. Delegates to
   *  the shared UniformRing so those callers keep working unchanged. */
  get uniformBuffer(): GPUBuffer { return this.uniformRing.buffer! }
  // P3 Step 3c palette atlas — the LIVE view stays on MapRenderer (plan
  // §5 FB#3). It starts as the factory's 1×1 transparent STUB view (so
  // every bind group is valid before the real atlas lands) and
  // `setPaletteColorAtlas` swaps it in-place + rebuilds bindGroup +
  // per-layer groups when the scene compile finishes. Seeded in the
  // ctor from `_pipelines.paletteStubTextureView`.
  /** Currently-bound color gradient atlas view. Defaults to the factory's
   *  1×1 stub; set to the real atlas via `setPaletteColorAtlas`. In the
   *  external read contract (map.ts:557 / source-manager.ts). */
  paletteColorAtlasView!: GPUTextureView
  // iter-181 — sprite atlas LIVE view, same FB#3 ownership as the palette
  // view: starts as the factory's 1×1 white STUB; swapped by
  // setSpriteAtlas once IconStage's atlas lands. Seeded in the ctor.
  /** Currently-bound sprite atlas view. In the external read contract
   *  (map.ts:558 / source-manager.ts / render-loop.ts:681). */
  spriteAtlasView!: GPUTextureView
  private bindGroup!: GPUBindGroup
  private layers: RenderLayer[] = []
  /** Lat/lon grid overlay collaborator. Owns its own GPU-buffer lifecycle
   *  + zoom-bucket regeneration + WeakMap cache; borrows linePipeline +
   *  base bindGroup + uniformRing per frame (passed into renderFrame).
   *  Built in the ctor (after `this.ctx` is set). */
  private readonly _graticule: GraticuleRenderer


  /** Get rendering stats for all layers */
  getDrawStats(): { drawCalls: number; vertices: number; triangles: number; lines: number } {
    let drawCalls = 0, vertices = 0, triangles = 0, lines = 0
    for (const layer of this.layers) {
      if (layer.polygonIndexCount > 0) {
        drawCalls++
        vertices += layer.polygonIndexCount
        triangles += Math.floor(layer.polygonIndexCount / 3)
      }
      if (layer.lineIndexCount > 0) {
        drawCalls++
        lines += Math.floor(layer.lineIndexCount / 2)
      }
    }
    const gratVerts = this._graticule.vertexCount()
    if (gratVerts > 0) {
      drawCalls++
      lines += Math.floor(gratVerts / 2)
      vertices += gratVerts
    }
    return { drawCalls, vertices, triangles, lines }
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
   *  construction (compiler post-condition). */
  private currentComputePlan: readonly import('@xgis/compiler').ComputePlanEntry[] | undefined

  constructor(ctx: GPUContext) {
    this.ctx = ctx
    this._graticule = new GraticuleRenderer(ctx)
    // Unit 1 split (plan §5 FB#4): the factory builds layouts → pipelines
    // → atlas stubs (its ctor calls build()); MapRenderer then seeds the
    // live atlas views + builds the uniform ring (the ring-tail that
    // STAYS here) + fires the first rebuildUniformBindGroups. ORDER is
    // load-bearing (DO-NOT-SPLIT #2): the factory finishes layout +
    // pipeline + stub creation BEFORE the ring bind groups reference
    // `_pipelines.bindGroupLayout`.
    this._pipelines = new PipelineFactory(ctx)
    // Route the variant pipeline builders' compute-aware layout pick back
    // through MapRenderer's getOrBuildVariantLayout — the
    // `variantComputeLayoutCache` (compute branch) is COMPUTE-cluster
    // state that STAYS here (plan §5 FB#1); the factory's own resolver
    // only covers the non-compute base layouts.
    this._pipelines.setLayoutResolver((v) => this.getOrBuildVariantLayout(v))
    // Seed the LIVE atlas views from the factory's 1×1 stubs (FB#3). The
    // setters (setPaletteColorAtlas / setSpriteAtlas) swap these in-place
    // once the real atlases land.
    this.paletteColorAtlasView = this._pipelines.paletteStubTextureView
    this.spriteAtlasView = this._pipelines.spriteAtlasStubTextureView
    // Uniform ring buffer: 240-byte slots (shared polygon/line struct), 256-slot
    // initial capacity, dynamic offsets per draw. Guarantees that multi-
    // layer draws don't overwrite each other's uniforms.
    // ensure() fires the onGrow callback → builds this.bindGroup (and the
    // per-layer loop, empty at init since no layers are registered yet),
    // faithfully replacing the inline build at the same point in init.
    this.uniformRing = new UniformRing(this.ctx.device, polygonUniformStride(), 256, 'uniform-ring', () => this.rebuildUniformBindGroups())
    this.uniformRing.ensure()
    // Graticule init is lazy — first frame after setGraticuleEnabled(true)
    // builds the buffer. Default off so the ctor stays cheap and the
    // grid doesn't render unless the host opts in.
  }

  /** Toggle the lat/lon grid overlay at runtime. Default off. */
  setGraticuleEnabled(on: boolean): void {
    this._graticule.setEnabled(on)
  }

  /** Read the current graticule on/off state. */
  isGraticuleEnabled(): boolean {
    return this._graticule.isEnabled()
  }

  /** Get-or-create the compute registry. Lazy because most scenes
   *  don't use the compute path; we don't want to allocate the
   *  dispatcher unless we actually have a compute kernel to run. */
  private ensureComputeRegistry(): ComputeLayerRegistry {
    if (this.computeRegistry) return this.computeRegistry
    this.computeDispatcher = new ComputeDispatcher(this.ctx)
    this.computeRegistry = new ComputeLayerRegistry(this.computeDispatcher)
    return this.computeRegistry
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
    // Compute half — STAYS on MapRenderer. The `variantComputeLayoutCache`
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
    const extended = extendBindGroupLayoutEntriesForCompute(
      variant, legacy, /* FRAGMENT */ 2,
    )
    const layout = this.ctx.device.createBindGroupLayout({
      label: `mr-featureBindGroupLayout-compute(${variant.key})`,
      entries: extended as GPUBindGroupLayoutEntry[],
    })
    this.variantComputeLayoutCache.set(variant.key, layout)
    return layout
  }

  /** Public mirror of the factory's PALETTE_LAYOUT_ENTRIES for the
   *  bind-group-drift invariant test (`bind-group-drift.test.ts` reads
   *  `MapRenderer.PALETTE_LAYOUT_ENTRIES`). The canonical array lives on
   *  PipelineFactory after Unit 1 — forwarded here so the external
   *  static read contract stays byte-identical. Same array; do not
   *  duplicate. */
  static readonly PALETTE_LAYOUT_ENTRIES: readonly GPUBindGroupLayoutEntry[] =
    PipelineFactory.PALETTE_LAYOUT_ENTRIES

  /** Public mirror of the factory's FEATURE_LAYOUT_ENTRIES for the drift
   *  invariant test (`bind-group-drift.test.ts` reads
   *  `MapRenderer.getFeatureLayoutEntries()`). The canonical array lives
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
   *  Forwarder (plan §6 DO-NOT-SPLIT #3): clears MapRenderer's
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

  /** Rebuild the bind group(s) that reference the uniform ring. Invoked
   *  on first `ensure()` and after every ring grow (the `onGrow`
   *  callback). Rebuilds the base `bindGroup` plus every registered
   *  layer's `perLayerBindGroup` against the CURRENT ring buffer (read
   *  via the `uniformBuffer` getter). At init the layer loop is empty
   *  (no layers yet), so this matches the original inline init build. */
  private rebuildUniformBindGroups(): void {
    const { device } = this.ctx
    this.bindGroup = device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer, offset: 0, size: polygonUniformBytes() } },
        { binding: 2, resource: this.paletteColorAtlasView },
        { binding: 4, resource: this.paletteSampler },
        { binding: 5, resource: this.spriteAtlasView },
        { binding: 6, resource: this.paletteSampler },
      ],
    })
    for (const layer of this.layers) {
      if (layer.featureDataBuffer) {
        layer.perLayerBindGroup = device.createBindGroup({
          layout: this.featureBindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: this.uniformBuffer, offset: 0, size: polygonUniformBytes() } },
            { binding: 1, resource: { buffer: layer.featureDataBuffer } },
            { binding: 2, resource: this.paletteColorAtlasView },
            { binding: 4, resource: this.paletteSampler },
            { binding: 5, resource: this.spriteAtlasView },
        { binding: 6, resource: this.paletteSampler },
          ],
        })
      }
    }
  }

  /** Reset the ring-buffer slot cursor. Call once per frame before any draws. */
  beginFrame(): void {
    this.uniformRing.resetSlot()
    for (const b of this.uniformRing.takeRetired()) b.destroy()
  }

  /** Copy a draw's uniform block into the staging mirror; tracked by
   *  dirty range so endFrame() can emit one writeBuffer instead of
   *  one per draw. Same pattern as VTR.stageUniformSlot. */
  private stageUniformSlot(slotOffset: number, src: ArrayBuffer): void {
    this.uniformRing.stageSlot(slotOffset, src)
  }

  /** Flush the staged uniform bytes before queue.submit(). Safe to
   *  call any number of times per frame — a no-op when no slots have
   *  been staged since the last flush. */
  endFrame(): void {
    this.uniformRing.flush()
  }

  private allocUniformSlot(): number {
    return this.uniformRing.allocSlot()
  }

  /** Register data + show command as a render layer.
   *  `pickId` is the stable u16 from `LayerIdRegistry`; it gets baked into
   *  every uniform-stage write so the fragment shader can stamp the pick
   *  texture's G channel. 0 = "no layer" (e.g., graticule), which makes
   *  `pickAt()` return null for hits. */
  addLayer(show: ShowCommand, polygons: MeshData, lines: LineMeshData, pickId = 0): void {
    const { device } = this.ctx
    // Create dynamic property store with compiled defaults
    const props = new StyleProperties()
    props.setDefault('fill', show.fill)
    props.setDefault('stroke', show.stroke)
    props.setDefault('strokeWidth', show.strokeWidth)
    props.setDefault('visible', show.visible ?? true)
    props.setDefault('opacity', show.opacity ?? 1.0)

    // Create per-layer specialized pipelines if shader variant exists
    const variant = show.shaderVariant as ShaderVariantInfo | null | undefined
    let layerFillPipeline: GPURenderPipeline | null = null
    let layerLinePipeline: GPURenderPipeline | null = null

    // Phase 2.5 US-002 — fillIsDefault replaces the legacy string compare;
    // see buildShader() in pipeline-factory.ts for the migration rationale.
    if (variant && (variant.preamble || variant.needsFeatureBuffer || !variant.fillIsDefault)) {
      const cached = this._pipelines.getCachedVariant(variant.key)
      if (cached) {
        layerFillPipeline = cached.fillPipeline
        layerLinePipeline = cached.linePipeline
      } else {
        const pipelines = this._pipelines.cacheVariantPipelines(variant)
        layerFillPipeline = pipelines.fillPipeline
        layerLinePipeline = pipelines.linePipeline
        console.log(`[X-GIS] Specialized shader for layer "${show.targetName}" (key: ${variant.key})`)
      }
    }

    const layer: RenderLayer = {
      show,
      props,
      polygonVertexBuffer: null,
      polygonIndexBuffer: null,
      polygonIndexCount: 0,
      lineVertexBuffer: null,
      lineIndexBuffer: null,
      lineIndexCount: 0,
      fillPipeline: layerFillPipeline,
      linePipeline: layerLinePipeline,
      featureDataBuffer: null,
      perLayerBindGroup: null,
      pickId,
    }

    // Build per-feature storage buffer if needed
    if (variant?.needsFeatureBuffer && polygons.features.length > 0) {
      const fieldCount = variant.featureFields.length
      if (fieldCount > 0) {
        const featureCount = polygons.features.length
        const data = new Float32Array(featureCount * fieldCount)
        // Build string→categoryID maps for string fields
        const catMaps = new Map<string, Map<string, number>>()
        for (const fieldName of variant.featureFields) {
          const uniqueVals = new Set<string>()
          for (const feat of polygons.features) {
            const v = feat.properties[fieldName]
            if (typeof v === 'string') uniqueVals.add(v)
          }
          if (uniqueVals.size > 0) {
            const sorted = [...uniqueVals].sort()
            const map = new Map<string, number>()
            sorted.forEach((v, i) => map.set(v, i))
            catMaps.set(fieldName, map)
          }
        }

        for (let i = 0; i < featureCount; i++) {
          const props = polygons.features[i].properties
          for (let j = 0; j < fieldCount; j++) {
            const fieldName = variant.featureFields[j]
            const val = props[fieldName]
            const catMap = catMaps.get(fieldName)
            if (catMap && typeof val === 'string') {
              data[i * fieldCount + j] = catMap.get(val) ?? 0
            } else {
              data[i * fieldCount + j] = typeof val === 'number' ? val : 0
            }
          }
        }

        layer.featureDataBuffer = device.createBuffer({
          size: Math.max(data.byteLength, 16), // min 16 bytes for WebGPU
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
          label: `${show.targetName}-feat-data`,
        })
        device.queue.writeBuffer(layer.featureDataBuffer, 0, data)

        // ─── Compute path attach (P4-5 integration step 2) ───
        // When the variant carries `computeBindings`, attach a handle
        // BEFORE building the per-layer bind group so the compute
        // output buffer exists by the time we append its entry. The
        // registry filters the scene plan by renderNodeIndex; drift
        // between (variant.computeBindings.length) and
        // (plan entries with this index) propagates as a thrown error
        // from ComputeLayerHandle — surfacing the
        // compiler / runtime contract violation before the WebGPU
        // pipeline build does.
        let extraComputeEntries: { binding: number; resource: { buffer: GPUBuffer } }[] = []
        if ((variant.computeBindings?.length ?? 0) > 0 && show.renderNodeIndex !== undefined) {
          const registry = this.ensureComputeRegistry()
          const handle = registry.attach(
            show.targetName,
            variant,
            this.currentComputePlan,
            show.renderNodeIndex,
          )
          if (handle) {
            // Pack feature properties for the compute kernel(s). The
            // handle's TileComputeResources owns its own packer; we
            // pass a fid→props lookup mirroring the polygon feature
            // array's order (fid = polygons.features index).
            handle.uploadFromProps(
              (fid) => polygons.features[fid]?.properties ?? null,
              featureCount,
            )
            const bg = handle.getBindGroupEntries()
            if (bg) extraComputeEntries = bg
          }
        }

        layer.perLayerBindGroup = device.createBindGroup({
          layout: this.getOrBuildVariantLayout(variant),
          entries: [
            { binding: 0, resource: { buffer: this.uniformBuffer, offset: 0, size: polygonUniformBytes() } },
            { binding: 1, resource: { buffer: layer.featureDataBuffer } },
            { binding: 2, resource: this.paletteColorAtlasView },
            { binding: 4, resource: this.paletteSampler },
            { binding: 5, resource: this.spriteAtlasView },
        { binding: 6, resource: this.paletteSampler },
            ...extraComputeEntries,
          ],
        })

        console.log(`[X-GIS] Feature data buffer: ${featureCount} features × ${fieldCount} fields for "${show.targetName}"`)
      }
    }

    // Upload polygon mesh
    if (polygons.indices.length > 0) {
      layer.polygonVertexBuffer = device.createBuffer({
        size: polygons.vertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        label: `${show.targetName}-poly-vtx`,
      })
      device.queue.writeBuffer(layer.polygonVertexBuffer, 0, polygons.vertices)

      layer.polygonIndexBuffer = device.createBuffer({
        size: polygons.indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        label: `${show.targetName}-poly-idx`,
      })
      device.queue.writeBuffer(layer.polygonIndexBuffer, 0, polygons.indices)
      layer.polygonIndexCount = polygons.indices.length
    }

    // Upload line mesh
    if (lines.indices.length > 0) {
      layer.lineVertexBuffer = device.createBuffer({
        size: lines.vertices.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        label: `${show.targetName}-line-vtx`,
      })
      device.queue.writeBuffer(layer.lineVertexBuffer, 0, lines.vertices)

      layer.lineIndexBuffer = device.createBuffer({
        size: lines.indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        label: `${show.targetName}-line-idx`,
      })
      device.queue.writeBuffer(layer.lineIndexBuffer, 0, lines.indices)
      layer.lineIndexCount = lines.indices.length
    }

    this.layers.push(layer)
  }

  /** P3 Step 3c — swap the bound color gradient atlas. Caller uploads
   *  the texture via `uploadPalette` (palette-texture.ts), then hands
   *  the returned `colorPalette.createView()` here. We rebuild every
   *  bind group that referenced the previous view (default + every
   *  per-layer feature group) so the next frame samples the real
   *  atlas instead of the 1×1 transparent stub.
   *
   *  Mirrors `setBindGroupLayout` lifecycle — caller invokes once per
   *  scene compile (palette is scene-scoped). */
  setPaletteColorAtlas(view: GPUTextureView): void {
    this.paletteColorAtlasView = view
    if (this.bindGroup) {
      this.bindGroup = this.ctx.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer, offset: 0, size: polygonUniformBytes() } },
          { binding: 2, resource: this.paletteColorAtlasView },
          { binding: 4, resource: this.paletteSampler },
          { binding: 5, resource: this.spriteAtlasView },
        { binding: 6, resource: this.paletteSampler },
        ],
      })
    }
    for (const layer of this.layers) {
      if (layer.featureDataBuffer) {
        // Preserve compute output entries on palette swap. The
        // registry still owns the handle (palette changes are scene-
        // level, layer set is untouched); we look up the handle by
        // the same `targetName` key addLayer used. No-op for legacy
        // variants.
        const variant = layer.show.shaderVariant as ShaderVariantInfo | null | undefined
        const computeEntries = variant?.computeBindings
          ? (this.computeRegistry?.getHandle(layer.show.targetName)?.getBindGroupEntries() ?? [])
          : []
        layer.perLayerBindGroup = this.ctx.device.createBindGroup({
          layout: variant ? this.getOrBuildVariantLayout(variant) : this.featureBindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: this.uniformBuffer, offset: 0, size: polygonUniformBytes() } },
            { binding: 1, resource: { buffer: layer.featureDataBuffer } },
            { binding: 2, resource: this.paletteColorAtlasView },
            { binding: 4, resource: this.paletteSampler },
            { binding: 5, resource: this.spriteAtlasView },
        { binding: 6, resource: this.paletteSampler },
            ...computeEntries,
          ],
        })
      }
    }
  }

  /** iter-181 — fill-pattern Stage 2 infra. Swaps the sprite atlas
   *  view bound at binding 5 across every cached bind group. Called
   *  by map.ts once the IconStage's SpriteAtlasGPU finishes uploading
   *  the real atlas; until then every bind group points at the 1×1
   *  white stub so existing fill draws are unaffected. The setter
   *  mirrors `setPaletteColorAtlas`'s rebuild-all-bind-groups pattern
   *  since WebGPU bind groups are immutable once created. */
  setSpriteAtlas(view: GPUTextureView): void {
    this.spriteAtlasView = view
    if (this.bindGroup) {
      this.bindGroup = this.ctx.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer, offset: 0, size: polygonUniformBytes() } },
          { binding: 2, resource: this.paletteColorAtlasView },
          { binding: 4, resource: this.paletteSampler },
          { binding: 5, resource: this.spriteAtlasView },
        { binding: 6, resource: this.paletteSampler },
        ],
      })
    }
    for (const layer of this.layers) {
      if (layer.featureDataBuffer) {
        const variant = layer.show.shaderVariant as ShaderVariantInfo | null | undefined
        const computeEntries = variant?.computeBindings
          ? (this.computeRegistry?.getHandle(layer.show.targetName)?.getBindGroupEntries() ?? [])
          : []
        layer.perLayerBindGroup = this.ctx.device.createBindGroup({
          layout: variant ? this.getOrBuildVariantLayout(variant) : this.featureBindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: this.uniformBuffer, offset: 0, size: polygonUniformBytes() } },
            { binding: 1, resource: { buffer: layer.featureDataBuffer } },
            { binding: 2, resource: this.paletteColorAtlasView },
            { binding: 4, resource: this.paletteSampler },
            { binding: 5, resource: this.spriteAtlasView },
        { binding: 6, resource: this.paletteSampler },
            ...computeEntries,
          ],
        })
      }
    }
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

  /** Remove all layers (for re-projection) */
  getLayer(name: string): RenderLayer | undefined {
    return this.layers.find((l) => l.show.targetName === name)
  }

  listProperties(): Record<string, string[]> {
    const result: Record<string, string[]> = {}
    for (const layer of this.layers) {
      result[layer.show.targetName] = layer.props.keys()
    }
    return result
  }

  clearLayers(): void {
    for (const layer of this.layers) {
      layer.polygonVertexBuffer?.destroy()
      layer.polygonIndexBuffer?.destroy()
      layer.lineVertexBuffer?.destroy()
      layer.lineIndexBuffer?.destroy()
      layer.featureDataBuffer?.destroy()
    }
    this.layers = []
    // Drop every compute handle's GPU buffers. The registry survives
    // (lazy-allocated, cheap to re-fill); `destroyAll` only frees
    // owned device memory. Production never enters this branch
    // because no variant carries `computeBindings` today.
    this.computeRegistry?.destroyAll()
  }

  /** Render all layers into an existing render pass (RTC projection) */
  renderToPass(pass: GPURenderPassEncoder, camera: Camera, projType = 0, projCenterLon = 0, projCenterLat = 20, elapsedMs = 0): void {
    // Overdraw-debug v1: legacy MapRenderer layers (graticule, etc.)
    // bake their pipeline against the swapchain format. The pass
    // attachment in debug mode is r16float — formats mismatch. Skip
    // entirely. Vector content goes through VTR, not this path.
    if (DEBUG_OVERDRAW) return
    const { canvas } = this.ctx
    // RTC: no translation in MVP, projection center is at (0,0).
    // Compute the live DPR so the camera matrix uses CSS-pixel altitude
    // (matches what VTR / raster / point renderers do).
    const dpr = canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : 1
    // PR 2d.5 closeout: every VS reads `u.mvp` which IS the ECEF-MVP (the
    // legacy Mercator-`mvp` slot was retired and the struct shrunk
    // 256 → 192 bytes). `getECEFFrameView` is the canonical MVP builder.
    const frame = camera.getECEFFrameView(canvas.width, canvas.height, dpr)
    const mvp = frame.matrix

    for (const layer of this.layers) {
      // Read from dynamic properties (supports runtime override)
      if (!layer.props.getBool('visible')) continue

      // Opacity / fill / stroke — read straight off the typed
      // `paintShapes` bundle the compiler / interpreter populated.
      // For `constant` shapes the renderer keeps using the dynamic
      // `props` store so `props.setOverride('opacity', X)` keeps
      // working at runtime; for the four animated kinds the resolver
      // takes precedence.
      const ps = layer.show.paintShapes
      const opacity = ps.common.opacity.kind === 'constant'
        ? layer.props.getNumber('opacity', 1.0)
        : resolveNumberShape(ps.common.opacity, camera.zoom, elapsedMs).value

      let fillRaw = layer.props.getColor('fill')
      let strokeRaw = layer.props.getColor('stroke')
      if (ps.fill.fill !== null) {
        const r = resolveColorShape(ps.fill.fill, camera.zoom, elapsedMs)
        if (r !== null) fillRaw = [r.value[0], r.value[1], r.value[2], r.value[3]]
      }
      if (ps.line.stroke !== null) {
        const r = resolveColorShape(ps.line.stroke, camera.zoom, elapsedMs)
        if (r !== null) strokeRaw = [r.value[0], r.value[1], r.value[2], r.value[3]]
      }
      const fillColor = fillRaw ? [fillRaw[0], fillRaw[1], fillRaw[2], fillRaw[3] * opacity] : [0, 0, 0, 0]
      const strokeColor = strokeRaw ? [strokeRaw[0], strokeRaw[1], strokeRaw[2], strokeRaw[3] * opacity] : [0, 0, 0, 0]

      const uniformData = this.uniformDataBuf
      // ── 192-byte Uniforms struct layout (post PR 2d.5 closeout) ──
      // byte   0: mvp         (16 f32 = 64 B) — ECEF-MVP
      // byte  64: fill_color  (4 f32) | byte  80: stroke_color (4 f32)
      // byte  96: proj_params (4 f32)
      // byte 112: cam_h (2 f32) | cam_l (2 f32)
      // byte 128: tile_origin_merc (2 f32) | opacity | log_depth_fc
      // byte 144: pick_id (u32) | layer_depth_offset | tile_extent_m | extrude_height_m
      // byte 160: clip_bounds (4 f32)
      // byte 176: zoom + 3-float pad → total 192 B
      // Offsets reflect-derived (polygonUniformSlots().slot) — byte-identical to
      // the literals documented above, pinned by polygon-uniform-offset-parity.
      // test.ts; a struct field shift reflows these instead of corrupting the write.
      const S = polygonUniformSlots().slot
      new Float32Array(uniformData, S.mvp * 4, 16).set(mvp)
      new Float32Array(uniformData, S.fill_color * 4, 4).set(fillColor as number[])
      new Float32Array(uniformData, S.stroke_color * 4, 4).set(strokeColor as number[])
      // proj_params + globe_eye written TOGETHER (coupled so a missing globe_eye —
      // the #600 vector-path leak — is unrepresentable). frame.eye is the globe/ECEF
      // camera position (undefined off the globe → globe_eye zero, ignored by flat).
      writeFrameProjectionUniform(new Float32Array(uniformData), projType, projCenterLon, projCenterLat, frame.eye)
      // Non-tiled layer: vertices are stored in absolute Mercator meters
      // (DSFUN stride 5/6) so tile_origin_merc = (0, 0) and
      // cam_h/cam_l = splitF64(cam_merc). The DSFUN subtraction in vs_main
      // then yields camera-relative meters exactly like the tiled path.
      const DEG2RAD = Math.PI / 180
      const R = 6378137
      const cx = projCenterLon * DEG2RAD * R
      const cy = projType < 0.5
        ? Math.log(Math.tan(Math.PI / 4 + Math.max(-85.051129, Math.min(85.051129, projCenterLat)) * DEG2RAD / 2)) * R  // Mercator
        : projCenterLat * DEG2RAD * R  // Equirectangular fallback (non-Mercator rebuilds lon/lat in the shader)
      const cxH = Math.fround(cx)
      const cxL = Math.fround(cx - cxH)
      const cyH = Math.fround(cy)
      const cyL = Math.fround(cy - cyH)
      new Float32Array(uniformData, S.cam_h * 4, 4).set([cxH, cyH, cxL, cyL]) // cam_h.xy, cam_l.xy
      // tile_origin_merc=(0,0), opacity, log_depth_fc
      new Float32Array(uniformData, S.tile_origin_merc * 4, 4).set([0, 0, opacity, frame.logDepthFc])
      // pick_id (low16 = layerId, high16 = instanceId=0 for non-tiled),
      // followed by 12 bytes of vec3<u32> padding so the uniform struct
      // ends on a 16-byte boundary as required by WebGPU std140-ish layout.
      new Uint32Array(uniformData, S.pick_id * 4, 4).set([layer.pickId, 0, 0, 0])
      // clip_bounds (160-175): sentinel "no clip" — non-tiled layers
      // own their entire screen area, no per-tile fallback clipping
      // applies. The fragment shader's `clip_bounds.x > -1e29` gate
      // skips the discard test entirely. Without this write the
      // shader reads garbage at byte 160 (the sentinel happens to be
      // an unusual value) and discards most fragments — the symptom
      // was the hero map showing only ~1/4 of the world after the
      // per-tile clip mask landed in 9c026b3.
      new Float32Array(uniformData, S.clip_bounds * 4, 4).set([-1e30, 0, 0, 0])
      // zoom + 3-float pad (offsets 176-191) — P3 palette gradient
      // sample reads u.zoom. Pad slots stay zero (RTC fields 192-239 +
      // light_dir_ecef 240-255 too — this fill/line path never extrudes);
      // total struct size is 256 bytes (UNIFORM_SIZE constant).
      new Float32Array(uniformData, S.zoom * 4, 4).set([camera.zoom, 0, 0, 0])
      const slotOffset = this.allocUniformSlot()
      this.stageUniformSlot(slotOffset, uniformData)

      // Select bind group: per-layer (with feature data) or shared
      const bindGroup = layer.perLayerBindGroup ?? this.bindGroup

      // Draw filled polygons (use per-layer pipeline if specialized)
      // Data-driven fill: fillRaw is null but shader variant provides the color
      const hasFill = fillRaw || layer.fillPipeline
      if (hasFill && layer.polygonVertexBuffer && layer.polygonIndexBuffer) {
        pass.setPipeline(layer.fillPipeline ?? this.fillPipeline)
        pass.setBindGroup(0, bindGroup, [slotOffset])
        pass.setVertexBuffer(0, layer.polygonVertexBuffer)
        pass.setIndexBuffer(layer.polygonIndexBuffer, 'uint32')
        pass.drawIndexed(layer.polygonIndexCount)
      }

      // Draw line strokes (use per-layer pipeline if specialized)
      if (strokeRaw && layer.lineVertexBuffer && layer.lineIndexBuffer) {
        pass.setPipeline(layer.linePipeline ?? this.linePipeline)
        pass.setBindGroup(0, bindGroup, [slotOffset])
        pass.setVertexBuffer(0, layer.lineVertexBuffer)
        pass.setIndexBuffer(layer.lineIndexBuffer, 'uint32')
        pass.drawIndexed(layer.lineIndexCount)
      }

      // Draw polygon outlines (stroke on polygons)
      // For MVP: render polygon edges as lines
      if (layer.show.stroke && layer.polygonVertexBuffer && layer.polygonIndexBuffer) {
        // We reuse polygon vertices but need line topology
        // For simplicity in MVP, we skip polygon outlines (only line features get stroked)
        // Full implementation would extract edges from triangulated polygons
      }
    }

    // Graticule overlay — regenerate (zoom-bucket gate) + draw, at the SAME
    // point in the frame (after the layer draws). The collaborator borrows
    // the layer path's linePipeline + base bindGroup + uniformRing and
    // reuses the SAME 192-byte uniform offsets (passed in, not re-derived).
    this._graticule.renderFrame(pass, this.linePipeline, this.bindGroup, this.uniformRing, {
      mvp,
      logDepthFc: frame.logDepthFc,
      projType,
      projCenterLon,
      projCenterLat,
      zoom: camera.zoom,
      eye: frame.eye, // #600 globe_eye for the graticule's globe(7) cull
    })

    // pass.end() and submit() are handled by caller
  }
}
