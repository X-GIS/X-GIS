// ═══ X-GIS Map Renderer — content half (WebGPU) ═══
//
// Step 1 of the P2 engine carve (docs/architecture/p2-engine-carve-plan.md):
// `MapRendererContent` is the CONTENT half split out of the former
// `MapRenderer` god-object. It owns *what to paint* — the non-tiled
// RenderLayer set + addLayer, the per-draw paint struct + renderToPass, the
// palette / sprite atlas LIVE views, the base bindGroup, the graticule
// overlay, and StyleProperties. It holds a `FrameRenderer` (the engine half,
// frame-renderer.ts: RHI / ring / pipeline machinery) and reaches that
// machinery ONLY through its public methods / getters. The engine holds NO
// back-reference to content.
//
// The external read contract is preserved here: `map.ts` constructs this
// object as `this.renderer`, and the passes / source-manager read the engine
// pipeline fields off it. The engine pipeline getters are re-exposed below as
// thin delegations to the FrameRenderer — byte-identical external API, ZERO
// call-site changes.

import type { GPUContext } from '@xgis/rhi-webgpu'
import type { Camera } from '../camera'
import type { MeshData, LineMeshData } from '@xgis/data'
import { DEBUG_OVERDRAW } from '../debug-flags'
import { activeBody } from '@xgis/shared'
import { resolveNumberShape, resolveColorShape } from './paint-shape-resolve'
import type { ShaderVariantInfo, CachedPipeline, ShowCommand, RenderLayer } from './renderer-types'
import { parseColor } from './renderer-helpers'
import { GraticuleRenderer } from './graticule-renderer'
import { polygonUniformBytes } from './polygon-uniform-slots'
import { uniformBlock, type UniformBlockOf } from '@xgis/engine'
import { polygonU as POLYGON_U } from '../shaders/dsl/polygon'
import { globeEyeUniform } from './globe-eye-uniform'

// Typed pack target for the non-tiled layer path's polygon 'Uniforms' writes
// (#733 P2c) — layout from wgslLayout(U.struct) (module-free), write() typed by
// the same field record the WGSL is emitted from. LAZY memo (draw time).
let _polyBlock: UniformBlockOf<typeof POLYGON_U> | null = null
function polyBlock(): UniformBlockOf<typeof POLYGON_U> {
  return (_polyBlock ??= uniformBlock(POLYGON_U))
}
import { FrameRenderer } from './frame-renderer'

// Re-export the extracted types so this module's public surface stays
// byte-identical (external consumers import these from './renderer').
export type { ShaderVariantInfo, CachedPipeline, Easing, ShowCommand } from './renderer-types'
// Re-export the extracted pure interpolators (external consumers + tests
// import these from './renderer').
export {
  interpolateZoom,
  interpolateZoomRgba,
  interpolateTime,
  interpolateTimeColor,
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

// ═══ MapRendererContent ═══

export class MapRendererContent {
  /** Shared GPU context — the SAME instance held by the engine half.
   *  Content needs `ctx.device` (buffer / bind-group creation) + `ctx.canvas`
   *  (camera framing) directly; the device is shared infra. */
  private ctx: GPUContext
  /** The ENGINE half — RHI / ring / pipeline machinery. Content reaches it
   *  ONLY through its public methods / getters; the engine holds NO back-
   *  reference to content (plan Step 1 invariant). */
  private readonly engine: FrameRenderer
  // (Per-frame uniform packing goes through the memoised polyBlock() — #733 P2c.)
  // The polygon Uniforms bind-range size is read LAZILY via polygonUniformBytes()
  // (memoised) at ctor/draw time. It MUST NOT be a `static readonly` field:
  // polygonUniformBytes() reflects the polygon module = a projection emit, which
  // throws until configureProjections() has run (post-GPU-init), and a static
  // field evaluates at class-definition (IMPORT) time — that crashed the entire
  // map init. The BGL omits minBindingSize, so a smaller bind `size` than the
  // shader-derived struct fails draw validation.
  // P3 Step 3c palette atlas — the LIVE view stays on the CONTENT half (plan
  // §5 FB#3 + Step 1 invariant: atlas views do NOT survive in the engine). It
  // starts as the factory's 1×1 transparent STUB view (so every bind group is
  // valid before the real atlas lands) and `setPaletteColorAtlas` swaps it
  // in-place + rebuilds bindGroup + per-layer groups when the scene compile
  // finishes. Seeded in the ctor from `engine.paletteStubTextureView`.
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
   *  base bindGroup + the engine's uniformRing per frame (passed into
   *  renderFrame). Built in the ctor. */
  private readonly _graticule: GraticuleRenderer

  constructor(ctx: GPUContext) {
    this.ctx = ctx
    this._graticule = new GraticuleRenderer(ctx)
    // Engine half: PipelineFactory build (layouts → pipelines → atlas stubs)
    // + setLayoutResolver. ORDER preserves the original MapRenderer ctor:
    // graticule → pipelines → atlas-view seed → ring create + ensure().
    this.engine = new FrameRenderer(ctx)
    // Seed the LIVE atlas views from the factory's 1×1 stubs (FB#3). The
    // setters (setPaletteColorAtlas / setSpriteAtlas) swap these in-place
    // once the real atlases land.
    this.paletteColorAtlasView = this.engine.paletteStubTextureView
    this.spriteAtlasView = this.engine.spriteAtlasStubTextureView
    // Build the uniform ring + fire the first rebuildUniformBindGroups via
    // the onGrow hook (layers empty at init → base bindGroup only). This
    // runs AFTER the atlas-view seed so the rebuild sees the live views.
    this.engine.initUniformRing(() => this.rebuildUniformBindGroups())
    // Graticule init is lazy — first frame after setGraticuleEnabled(true)
    // builds the buffer. Default off so the ctor stays cheap and the
    // grid doesn't render unless the host opts in.
  }

  // ── Engine read-contract re-exposers (plan Step 1 "preserve the external
  //    read contract"): every pipeline field / method that map.ts /
  //    source-manager.ts / the OIT/opaque/translucent/heatmap/overdraw
  //    passes read off `renderer` MUST stay readable on the object map.ts
  //    constructs. Thin delegations to the engine half — byte-identical
  //    external API, ZERO call-site changes. ──
  get fillPipeline(): GPURenderPipeline {
    return this.engine.fillPipeline
  }
  fillRhiState(): import('./material/polygon-fill-material').FillRhiState | null {
    return this.engine.fillRhiState()
  }
  get fillPipelineGround(): GPURenderPipeline {
    return this.engine.fillPipelineGround
  }
  get fillPipelineExtruded(): GPURenderPipeline {
    return this.engine.fillPipelineExtruded
  }
  get fillPipelineExtrudedOIT(): GPURenderPipeline {
    return this.engine.fillPipelineExtrudedOIT
  }
  get oitComposePipeline(): GPURenderPipeline {
    return this.engine.oitComposePipeline
  }
  get oitComposeBindGroupLayout(): GPUBindGroupLayout {
    return this.engine.oitComposeBindGroupLayout
  }
  get overdrawComposePipeline(): GPURenderPipeline | null {
    return this.engine.overdrawComposePipeline
  }
  get overdrawComposeBindGroupLayout(): GPUBindGroupLayout {
    return this.engine.overdrawComposeBindGroupLayout
  }
  get heatmapBlurBindGroupLayout(): GPUBindGroupLayout {
    return this.engine.heatmapBlurBindGroupLayout
  }
  get heatmapComposeBindGroupLayout(): GPUBindGroupLayout {
    return this.engine.heatmapComposeBindGroupLayout
  }
  get fillPipelineOverdraw(): GPURenderPipeline | null {
    return this.engine.fillPipelineOverdraw
  }
  get fillPipelineOverdrawFeature(): GPURenderPipeline | null {
    return this.engine.fillPipelineOverdrawFeature
  }
  get linePipelineOverdraw(): GPURenderPipeline | null {
    return this.engine.linePipelineOverdraw
  }
  get linePipeline(): GPURenderPipeline {
    return this.engine.linePipeline
  }
  get fillPipelineFallback(): GPURenderPipeline {
    return this.engine.fillPipelineFallback
  }
  get fillPipelineGroundFallback(): GPURenderPipeline {
    return this.engine.fillPipelineGroundFallback
  }
  get fillPipelineExtrudedFallback(): GPURenderPipeline {
    return this.engine.fillPipelineExtrudedFallback
  }
  get fillPipelinePatternGround(): GPURenderPipeline {
    return this.engine.fillPipelinePatternGround
  }
  get fillPipelinePatternGroundFallback(): GPURenderPipeline {
    return this.engine.fillPipelinePatternGroundFallback
  }
  get fillPipelinePatternExtruded(): GPURenderPipeline {
    return this.engine.fillPipelinePatternExtruded
  }
  get fillPipelinePatternExtrudedFallback(): GPURenderPipeline {
    return this.engine.fillPipelinePatternExtrudedFallback
  }
  get linePipelineFallback(): GPURenderPipeline {
    return this.engine.linePipelineFallback
  }
  get fillPipelineNoPick(): GPURenderPipeline {
    return this.engine.fillPipelineNoPick
  }
  get fillPipelineGroundNoPick(): GPURenderPipeline {
    return this.engine.fillPipelineGroundNoPick
  }
  get fillPipelineExtrudedNoPick(): GPURenderPipeline {
    return this.engine.fillPipelineExtrudedNoPick
  }
  get linePipelineNoPick(): GPURenderPipeline {
    return this.engine.linePipelineNoPick
  }
  get fillPipelineFallbackNoPick(): GPURenderPipeline {
    return this.engine.fillPipelineFallbackNoPick
  }
  get fillPipelineGroundFallbackNoPick(): GPURenderPipeline {
    return this.engine.fillPipelineGroundFallbackNoPick
  }
  get fillPipelineExtrudedFallbackNoPick(): GPURenderPipeline {
    return this.engine.fillPipelineExtrudedFallbackNoPick
  }
  get linePipelineFallbackNoPick(): GPURenderPipeline {
    return this.engine.linePipelineFallbackNoPick
  }
  get bindGroupLayout(): GPUBindGroupLayout {
    return this.engine.bindGroupLayout
  }
  get featureBindGroupLayout(): GPUBindGroupLayout {
    return this.engine.featureBindGroupLayout
  }
  /** Palette/sprite sampler — owned by the engine's factory (shared by both
   *  atlases at bindings 4 + 6). In the external read contract
   *  (map.ts:557 / source-manager.ts). */
  get paletteSampler(): GPUSampler {
    return this.engine.paletteSampler
  }
  /** Live uniform ring buffer — read by the OIT / opaque / translucent
   *  passes via `host.renderer.uniformBuffer`. */
  get uniformBuffer(): GPUBuffer {
    return this.engine.uniformBuffer
  }
  /** Rebuild all pipelines + invalidate shader variant cache (map.setQuality). */
  rebuildForQuality(): void {
    this.engine.rebuildForQuality()
  }
  /** Lazy-build the `?debug=overdraw` final compose pipeline. */
  ensureOverdrawCompose(): GPURenderPipeline {
    return this.engine.ensureOverdrawCompose()
  }
  /** Lazy-build the heatmap blur pipeline (Phase R). */
  ensureHeatmapBlur(): GPURenderPipeline {
    return this.engine.ensureHeatmapBlur()
  }
  /** Lazy-build the heatmap compose pipeline (Phase R). */
  ensureHeatmapCompose(): GPURenderPipeline {
    return this.engine.ensureHeatmapCompose()
  }
  /** Reset the ring-buffer slot cursor. Call once per frame before any draws. */
  beginFrame(): void {
    this.engine.beginFrame()
  }
  /** Flush the staged uniform bytes before queue.submit(). */
  endFrame(): void {
    this.engine.endFrame()
  }
  /** Run every attached compute kernel onto the encoder (once per frame). */
  dispatchComputePass(
    encoder: GPUCommandEncoder,
    timestampWritesProvider?: { computeWrites(): GPUComputePassTimestampWrites | null } | null,
  ): void {
    this.engine.dispatchComputePass(encoder, timestampWritesProvider)
  }
  /** Hand the scene's compute plan to the renderer before addLayer calls. */
  setComputePlan(plan: readonly import('@xgis/compiler').ComputePlanEntry[] | undefined): void {
    this.engine.setComputePlan(plan)
  }
  /** Return the bind-group layout the renderer binds for a given variant. */
  getOrBuildVariantLayout(variant: ShaderVariantInfo): GPUBindGroupLayout {
    return this.engine.getOrBuildVariantLayout(variant)
  }
  /** Get or create variant pipelines (public for vector tile renderer). */
  getOrCreateVariantPipelines(variant: ShaderVariantInfo): CachedPipeline {
    return this.engine.getOrCreateVariantPipelines(variant)
  }
  /** Async prewarm — forwarder to the engine's factory. */
  async prewarmShaderVariantsAsync(variants: ShaderVariantInfo[]): Promise<void> {
    return this.engine.prewarmShaderVariantsAsync(variants)
  }

  /** Toggle the lat/lon grid overlay at runtime. Default off. */
  setGraticuleEnabled(on: boolean): void {
    this._graticule.setEnabled(on)
  }

  /** Read the current graticule on/off state. */
  isGraticuleEnabled(): boolean {
    return this._graticule.isEnabled()
  }

  /** Get rendering stats for all layers */
  getDrawStats(): { drawCalls: number; vertices: number; triangles: number; lines: number } {
    let drawCalls = 0,
      vertices = 0,
      triangles = 0,
      lines = 0
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

  /** Rebuild the bind group(s) that reference the uniform ring. Invoked
   *  on first `ensure()` and after every ring grow (the `onGrow`
   *  callback). Rebuilds the base `bindGroup` plus every registered
   *  layer's `perLayerBindGroup` against the CURRENT ring buffer (read
   *  via the `uniformBuffer` getter). At init the layer loop is empty
   *  (no layers yet), so this matches the original inline init build. */
  private rebuildUniformBindGroups(): void {
    // #832 M2 — these are NATIVE WebGPU bind groups for the WebGPU frame path;
    // on the webgl2 backend that path never runs (renderFrameViaRhi renders the
    // frame) and reading the native uniformBuffer getter would unwrap-throw at
    // boot. Skip: the WebGL2 fill draws bind RHI-native groups instead.
    if (this.ctx.rhi.backend === 'webgl2') return
    const { device } = this.ctx
    this.bindGroup = device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.uniformBuffer, offset: 0, size: polygonUniformBytes() },
        },
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
            {
              binding: 0,
              resource: { buffer: this.uniformBuffer, offset: 0, size: polygonUniformBytes() },
            },
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
      const cached = this.engine.getCachedVariant(variant.key)
      if (cached) {
        layerFillPipeline = cached.fillPipeline
        layerLinePipeline = cached.linePipeline
      } else {
        const pipelines = this.engine.cacheVariantPipelines(variant)
        layerFillPipeline = pipelines.fillPipeline
        layerLinePipeline = pipelines.linePipeline
        console.log(
          `[X-GIS] Specialized shader for layer "${show.targetName}" (key: ${variant.key})`,
        )
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

    // #834 device retirement S5 — every block below is a NATIVE upload
    // (feature-data storage + per-layer bind group + polygon/line mesh
    // buffers) consumed only by the WebGPU frame path. On webgl2 the layer
    // RECORD still registers (bookkeeping: show/props/pickId), with null
    // buffers — exactly the state the palette/sprite rebuild loops and the
    // draw path already treat as "nothing uploaded".
    if (this.ctx.rhi.backend === 'webgl2') {
      this.layers.push(layer)
      return
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
          const registry = this.engine.ensureComputeRegistry()
          const handle = registry.attach(
            show.targetName,
            variant,
            this.engine.computePlan,
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
            {
              binding: 0,
              resource: { buffer: this.uniformBuffer, offset: 0, size: polygonUniformBytes() },
            },
            { binding: 1, resource: { buffer: layer.featureDataBuffer } },
            { binding: 2, resource: this.paletteColorAtlasView },
            { binding: 4, resource: this.paletteSampler },
            { binding: 5, resource: this.spriteAtlasView },
            { binding: 6, resource: this.paletteSampler },
            ...extraComputeEntries,
          ],
        })

        console.log(
          `[X-GIS] Feature data buffer: ${featureCount} features × ${fieldCount} fields for "${show.targetName}"`,
        )
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
          {
            binding: 0,
            resource: { buffer: this.uniformBuffer, offset: 0, size: polygonUniformBytes() },
          },
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
          ? (this.engine.registry?.getHandle(layer.show.targetName)?.getBindGroupEntries() ?? [])
          : []
        layer.perLayerBindGroup = this.ctx.device.createBindGroup({
          layout: variant ? this.getOrBuildVariantLayout(variant) : this.featureBindGroupLayout,
          entries: [
            {
              binding: 0,
              resource: { buffer: this.uniformBuffer, offset: 0, size: polygonUniformBytes() },
            },
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
          {
            binding: 0,
            resource: { buffer: this.uniformBuffer, offset: 0, size: polygonUniformBytes() },
          },
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
          ? (this.engine.registry?.getHandle(layer.show.targetName)?.getBindGroupEntries() ?? [])
          : []
        layer.perLayerBindGroup = this.ctx.device.createBindGroup({
          layout: variant ? this.getOrBuildVariantLayout(variant) : this.featureBindGroupLayout,
          entries: [
            {
              binding: 0,
              resource: { buffer: this.uniformBuffer, offset: 0, size: polygonUniformBytes() },
            },
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
    this.engine.registry?.destroyAll()
  }

  /** Render all layers into an existing render pass (RTC projection) */
  renderToPass(
    pass: GPURenderPassEncoder,
    camera: Camera,
    projType = 0,
    projCenterLon = 0,
    projCenterLat = 20,
    elapsedMs = 0,
  ): void {
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
      const opacity =
        ps.common.opacity.kind === 'constant'
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
      const fillColor: readonly [number, number, number, number] = fillRaw
        ? [fillRaw[0], fillRaw[1], fillRaw[2], fillRaw[3] * opacity]
        : [0, 0, 0, 0]
      const strokeColor: readonly [number, number, number, number] = strokeRaw
        ? [strokeRaw[0], strokeRaw[1], strokeRaw[2], strokeRaw[3] * opacity]
        : [0, 0, 0, 0]

      // Non-tiled layer: vertices are stored in absolute Mercator meters
      // (DSFUN stride 5/6) so tile_origin_merc = (0, 0) and
      // cam_h/cam_l = splitF64(cam_merc). The DSFUN subtraction in vs_main
      // then yields camera-relative meters exactly like the tiled path.
      const DEG2RAD = Math.PI / 180
      const R = activeBody().sphereR
      const cx = projCenterLon * DEG2RAD * R
      const cy =
        projType < 0.5
          ? Math.log(
              Math.tan(
                Math.PI / 4 +
                  (Math.max(-85.051129, Math.min(85.051129, projCenterLat)) * DEG2RAD) / 2,
              ),
            ) * R // Mercator
          : projCenterLat * DEG2RAD * R // Equirectangular fallback (non-Mercator rebuilds lon/lat in the shader)
      const cxH = Math.fround(cx)
      const cxL = Math.fround(cx - cxH)
      const cyH = Math.fround(cy)
      const cyL = Math.fround(cy - cyH)
      // Full-struct typed pack (#733 P2c) — every field named, completeness
      // compile-time (the #600 missing-globe_eye vector-path leak does not
      // compile). Field notes, unchanged from the slot writer this replaces:
      // · pick_id: low16 = layerId, high16 = instanceId (0 for non-tiled).
      // · clip_bounds: the "no clip" sentinel — non-tiled layers own their
      //   entire screen area; the fragment shader's `clip_bounds.x > -1e29`
      //   gate skips the discard test. Without this write the shader read
      //   garbage at that offset and discarded most fragments (the hero map
      //   showed ~1/4 of the world after the per-tile clip mask in 9c026b3).
      // · zoom: P3 palette gradient sample reads u.zoom.
      // · RTC (cam_ecef_off_h/l) + extrude/light fields stay zero — this
      //   fill/line path never extrudes.
      const ge = globeEyeUniform(frame.eye)
      const B = polyBlock()
      B.write({
        mvp,
        fill_color: fillColor,
        stroke_color: strokeColor,
        proj_params: [projType, projCenterLon, projCenterLat, 0],
        cam_h: [cxH, cyH],
        cam_l: [cxL, cyL],
        tile_origin_merc: [0, 0],
        opacity,
        log_depth_fc: frame.logDepthFc,
        pick_id: layer.pickId,
        layer_depth_offset: 0,
        tile_extent_m: 0,
        extrude_height_m: 0,
        clip_bounds: [-1e30, 0, 0, 0],
        zoom: camera.zoom,
        extrude_base_m: 0,
        fill_translate_x: 0,
        fill_translate_y: 0,
        tile_dequant_scale: 0,
        tile_dequant_half: 0,
        light_color_packed: 0,
        _pad_light_align: 0,
        cam_ecef_off_h: [0, 0, 0, 0],
        cam_ecef_off_l: [0, 0, 0, 0],
        light_dir_ecef: [0, 0, 0, 0],
        globe_eye: [ge[0], ge[1], ge[2], ge[3]],
      })
      const slotOffset = this.engine.allocUniformSlot()
      this.engine.stageUniformSlot(slotOffset, B.buffer)

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
    this._graticule.renderFrame(
      pass,
      this.linePipeline,
      this.bindGroup,
      this.engine.uniformRingHandle,
      {
        mvp,
        logDepthFc: frame.logDepthFc,
        projType,
        projCenterLon,
        projCenterLat,
        zoom: camera.zoom,
        eye: frame.eye, // #600 globe_eye for the graticule's globe(7) cull
      },
      // #729 — the graticule routes its own MVP + world-copy fan-out through the
      // camera (getViewForProjection + visibleWorldCopiesFor) for flat display;
      // frame.mvp above is only consumed on the globe/tilted ECEF fast path.
      camera,
      canvas.width,
      canvas.height,
      dpr,
    )

    // pass.end() and submit() are handled by caller
  }
}
