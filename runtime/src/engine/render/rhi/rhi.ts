// ═══ RHI — Render Hardware Interface (vertical-pilot seam) ═══
//
// Backend-agnostic GPU surface. The whole architecture refactor hangs off this:
// renderers stop calling GPUDevice / GPURenderPassEncoder directly and target
// THIS interface instead, so a backend swap (WebGPU → WebGL2) is one impl, not
// an edit to every renderer.
//
// SCOPE (pilot): exactly the surface the raster renderer uses today — buffers,
// textures, samplers, resource sets (bind groups), pipelines, and a draw pass.
// Deliberately minimal; grow it ONLY as later primitives need (dynamic offsets,
// vertex/index buffers, MRT, compute) so it never becomes a speculative god.
//
// Handles are opaque — callers never see GPUBuffer / WebGLBuffer. The WebGPU
// impl (rhi-webgpu.ts) wraps the native objects; a future WebGL2 impl wraps gl.

/** Opaque GPU resource handles — backend types stay hidden behind the impl. */
export interface RhiBuffer { readonly __rhi: 'buffer' }
export interface RhiTexture { readonly __rhi: 'texture' }
export interface RhiTextureView { readonly __rhi: 'view' }
export interface RhiSampler { readonly __rhi: 'sampler' }
export interface RhiBindGroup { readonly __rhi: 'bindgroup' }
export interface RhiBindGroupLayout { readonly __rhi: 'bindlayout' }
export interface RhiPipeline { readonly __rhi: 'pipeline' }

/** Semantic buffer roles (impl maps to backend usage flags). */
export type RhiBufferUsage = 'uniform' | 'vertex' | 'index' | 'storage'

export interface RhiBufferDesc {
  size: number
  usage: RhiBufferUsage
  /** Buffer is written after creation via writeBuffer (the common case). */
  writable?: boolean
  label?: string
}

/** Semantic texture formats — impl maps to backend (e.g. swapchain bgra8). */
export type RhiTextureFormat = 'rgba8unorm' | 'bgra8unorm' | 'depth24plus-stencil8' | 'rg32uint' | 'r16float'

export interface RhiTextureDesc {
  width: number
  height: number
  format: RhiTextureFormat
  usage: ReadonlyArray<'sample' | 'render' | 'copy-dst' | 'copy-src'>
  sampleCount?: number
  label?: string
}

export type RhiFilter = 'nearest' | 'linear'
export interface RhiSamplerDesc { mag: RhiFilter; min: RhiFilter; label?: string }

/** One entry in a bind-group LAYOUT — what kind of resource lives at a slot.
 *  Derived from the shader's reflection (DSL), not hand-authored, in the full
 *  design; the pilot passes it explicitly to keep the seam small. */
export interface RhiBindLayoutEntry {
  binding: number
  /** 'storage' = read-only storage buffer (point feat_data / shape / segment).
   *  WebGPU-native; a WebGL2 backend would lower these to textures/UBOs. */
  kind: 'uniform' | 'texture' | 'sampler' | 'storage'
  /** Uniform bound with a per-draw dynamic offset (per-tile slot pattern). */
  dynamic?: boolean
  /** The shader's reflection NAME for this binding (from the DSL). A WebGL2
   *  backend reflects the linked program BY NAME with it — a `uniform` block's
   *  tag = the struct name, a `texture`'s sampler-uniform name = the binding
   *  name — so multi-resource groups bind correctly regardless of declaration
   *  order. Optional + additive: WebGPU ignores it; WebGL2 falls back to
   *  by-order pairing when it is absent. */
  name?: string
}

/** A concrete resource bound at a slot when building a bind GROUP. */
export type RhiBindResource =
  | { buffer: RhiBuffer; offset?: number; size?: number }
  | { view: RhiTextureView }
  | { sampler: RhiSampler }

export interface RhiBindEntry { binding: number; resource: RhiBindResource }

/** Backend-agnostic blend/depth/target state (pilot: raster = alpha, no depth). */
export interface RhiPipelineDesc {
  /** WGSL today; GLSL once the DSL GLSL backend lands. Impl picks by backend. */
  code: string
  /** Shader entry points (WGSL single module). The DSL knows these per shader. */
  vsEntry: string
  fsEntry: string
  /** Split GLSL ES 3.00 source for split-source backends (WebGL2). DIVERGENCE:
   *  WGSL is ONE module (`code` + vsEntry/fsEntry pick the two entries); GLSL ES is
   *  single-`main()`-per-compilation-unit, so the GLSL backend emits TWO strings —
   *  emitGlslModule(m,'vertex') / (m,'fragment'). Optional + additive: the WebGPU
   *  impl ignores these (uses `code`); the WebGL2 impl requires them. */
  vsCode?: string
  fsCode?: string
  bindGroupLayouts: RhiBindGroupLayout[]
  colorTargets: ReadonlyArray<{ format: RhiTextureFormat; blend?: 'alpha' | 'premult' | 'additive' | 'none' }>
  depthStencil?: {
    format: RhiTextureFormat; write: boolean; compare: 'always' | 'less' | 'less-equal'
    /** Polygon-offset depth bias (point markers pull toward camera). */
    bias?: { constant: number; slopeScale: number; clamp: number }
  }
  sampleCount?: number
  /** Procedural-grid draws (raster/drape) have no vertex buffers. */
  vertexBuffers?: ReadonlyArray<{ stride: number; attributes: ReadonlyArray<{ location: number; offset: number; format: string }> }>
  label?: string
}

/** A draw scope — the renderer records draws against this, never the native
 *  pass encoder. The WebGPU impl wraps GPURenderPassEncoder; a WebGL2 impl sets
 *  gl state + issues drawArrays. setBindGroup's dynamicOffsets back the per-tile
 *  uniform-slot pattern (WebGPU dynamic offset / WebGL2 bindBufferRange). */
export interface RhiRenderPass {
  setPipeline(p: RhiPipeline): void
  setBindGroup(index: number, group: RhiBindGroup, dynamicOffsets?: number[]): void
  setVertexBuffer(slot: number, buffer: RhiBuffer): void
  setIndexBuffer(buffer: RhiBuffer, format: 'uint16' | 'uint32'): void
  draw(vertexCount: number, instanceCount?: number, firstVertex?: number): void
  drawIndexed(indexCount: number, instanceCount?: number): void
}

/** A backbuffer screen-pass request — the screen render target + how to load it.
 *  Slice-1 (forced-WebGL2): an ISOLATED single-sample pass that clears then presents
 *  (the shared opaque-pass MSAA topology is Story-5). */
export interface RhiScreenPassDesc {
  /** Backbuffer size in physical px (WebGL2 `gl.viewport`; WebGPU derives from the view). */
  width: number
  height: number
  /** Clear colour applied at load (RGBA 0..1). Omit to load/preserve existing contents. */
  clear?: readonly [number, number, number, number]
  /** WebGPU only: the swapchain texture view to render into (the loop builds it via
   *  `context.getCurrentTexture().createView()`). WebGL2 ignores it (renders to FBO 0).
   *  Optional + additive. */
  screenView?: RhiTextureView
}

/** The device — creates resources + pipelines. One impl per backend. */
export interface RhiDevice {
  /** Which backend this device is — a POSITIVE marker so a forced-WebGL2 path can be
   *  asserted to have actually run on WebGL2 (on a WebGPU-equipped box a silently-ignored
   *  toggle would otherwise look like a pass). 'webgpu' (WebGpuDevice) | 'webgl2' (WebGl2Device). */
  readonly backend: 'webgpu' | 'webgl2'
  createBuffer(desc: RhiBufferDesc): RhiBuffer
  writeBuffer(buffer: RhiBuffer, byteOffset: number, data: BufferSource): void
  createTexture(desc: RhiTextureDesc): RhiTexture
  writeTexture(texture: RhiTexture, data: BufferSource, bytesPerRow: number, width: number, height: number): void
  createView(texture: RhiTexture): RhiTextureView
  createSampler(desc: RhiSamplerDesc): RhiSampler
  createBindGroupLayout(entries: RhiBindLayoutEntry[]): RhiBindGroupLayout
  createBindGroup(layout: RhiBindGroupLayout, entries: RhiBindEntry[]): RhiBindGroup
  createPipeline(desc: RhiPipelineDesc): RhiPipeline

  // ── Screen-pass lifecycle (additive, OPTIONAL) ───────────────────────────────
  // The render loop does device-creation / swapchain-acquire / begin-pass / submit
  // RAW today (render-loop.ts:199-200/484). To originate a frame on WebGL2 the RHI
  // must own that lifecycle. These are OPTIONAL + additive: `WebGl2Device` implements
  // them (the forced-WebGL2 slice-1 frame renders through here); `WebGpuDevice` OMITS
  // them in slice-1 (the WebGPU path keeps its raw render-loop lifecycle, byte-
  // identical). Full WebGPU-via-RHI lifecycle is Story-7 convergence scope.

  /** Begin the backbuffer screen pass; record draws against the returned pass, then
   *  `endScreenPass`. WebGL2: bind FBO 0 + set viewport + optional clear. */
  beginScreenPass?(desc: RhiScreenPassDesc): RhiRenderPass
  /** Finish + present the screen pass. WebGL2: `gl.flush()` + drain `gl.getError()`. */
  endScreenPass?(pass: RhiRenderPass): void
  /** Drain accumulated GL errors (WebGL2) so the loop can surface them into the same
   *  `_validationErrors` sink the WebGPU path uses. Returns + clears the queue. */
  takeGlErrors?(): string[]
}
