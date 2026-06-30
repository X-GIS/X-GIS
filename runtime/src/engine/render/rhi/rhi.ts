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

/** Semantic texture formats — impl maps to backend (e.g. swapchain bgra8).
 *  `rgba16float` is the OIT weighted-blend accum target (gpu-shared
 *  OIT_ACCUM_FORMAT); WebGL2 fail-closes on it (rendering to it needs
 *  EXT_color_buffer_float — deferred to the WebGL2 full-frame phase). */
export type RhiTextureFormat = 'rgba8unorm' | 'bgra8unorm' | 'depth24plus-stencil8' | 'rg32uint' | 'r32uint' | 'r16float' | 'rgba16float'

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
  /** `writeMask` (GPUColorWrite bitmask; 0xf = ALL) defaults per format: rg32uint pick targets
   *  default 0 (the raster/line non-pickable pattern — they write vec2u(0,0)), every other target
   *  defaults 0xf. A PICKABLE primitive (VTR polygon fill writes the feature id) sets the pick
   *  target's writeMask to 0xf explicitly to override the default. */
  colorTargets: ReadonlyArray<{ format: RhiTextureFormat; blend?: 'alpha' | 'premult' | 'additive' | 'max' | 'none'; writeMask?: number }>
  depthStencil?: {
    format: RhiTextureFormat; write: boolean; compare: 'always' | 'less' | 'less-equal'
    /** Polygon-offset depth bias (point markers pull toward camera). */
    bias?: { constant: number; slopeScale: number; clamp: number }
    /** Per-tile clip-mask stencil state. Absent = inert stencil (byte-identical
     *  to the renderers' STENCIL_DISABLED). `compare`/`passOp` + the masks mirror
     *  the gpu-shared STENCIL_WRITE / STENCIL_TEST / STENCIL_CLIPMASK_* states;
     *  the runtime sets the reference per-draw via `setStencilReference`. */
    stencil?: { compare: 'always' | 'equal'; passOp: 'keep' | 'replace'; writeMask: number; readMask: number }
  }
  sampleCount?: number
  /** Procedural-grid draws (raster/drape) have no vertex buffers. */
  vertexBuffers?: ReadonlyArray<{ stride: number; attributes: ReadonlyArray<{ location: number; offset: number; format: string }> }>
  /** Triangle face culling. Default 'none' (byte-identical to the prior hardcoded primitive). The
   *  VTR ground-fill variants cull 'back' (GPU back-cull of the far hemisphere on the globe). */
  cullMode?: 'none' | 'back' | 'front'
  label?: string
}

/** A draw scope — the renderer records draws against this, never the native
 *  pass encoder. The WebGPU impl wraps GPURenderPassEncoder; a WebGL2 impl sets
 *  gl state + issues drawArrays. setBindGroup's dynamicOffsets back the per-tile
 *  uniform-slot pattern (WebGPU dynamic offset / WebGL2 bindBufferRange). */
export interface RhiRenderPass {
  setPipeline(p: RhiPipeline): void
  setBindGroup(index: number, group: RhiBindGroup, dynamicOffsets?: number[]): void
  /** Bind a vertex buffer, optionally a byte sub-range (the per-tile slice of a
   *  shared arena buffer). `offset`/`size` default to the whole buffer (offset 0)
   *  — byte-identical to the no-offset bind. WebGPU: native setVertexBuffer offset/
   *  size; WebGL2: `offset` is added to each attribute's `vertexAttribPointer` byte
   *  offset (`size` is implied by the draw count). */
  setVertexBuffer(slot: number, buffer: RhiBuffer, offset?: number, size?: number): void
  setIndexBuffer(buffer: RhiBuffer, format: 'uint16' | 'uint32', offset?: number, size?: number): void
  draw(vertexCount: number, instanceCount?: number, firstVertex?: number): void
  drawIndexed(indexCount: number, instanceCount?: number): void
  /** Per-draw stencil reference value (the per-tile clip-mask ID). Inert on a
   *  pipeline built without a `depthStencil.stencil` config. WebGPU maps to
   *  `GPURenderPassEncoder.setStencilReference`; WebGL2 stencil-state binding is
   *  deferred to the WebGL2 full-frame phase (see rhi-webgl2.ts). */
  setStencilReference(ref: number): void
  /** Finish this render pass. WebGPU maps to `GPURenderPassEncoder.end()` (the
   *  raw `subPass.end()` every pass body calls); WebGL2 is immediate-mode so
   *  ending is a no-op (the next pass rebinds its FBO / viewport). A screen pass
   *  obtained via `beginScreenPass` is instead finished through `endScreenPass`. */
  end(): void
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

// ═══ Offscreen / MRT render-pass topology (passes/ — gap #2) ═══
//
// `beginScreenPass` covers ONLY the single-sample backbuffer. The whole
// passes/ topology (opaque pick `@location1` MRT, OIT accum+revealage MRT,
// MSAA-resolve, the offscreen MAX line pass, the heatmap r16float 3-pass)
// runs RAW `encoder.beginRenderPass(GPURenderPassDescriptor)` today. These
// descriptors express that topology backend-agnostically so passes can
// originate through `RhiCommandEncoder.beginRenderPass` instead at P1.
//
// The WebGPU impl maps these to a `GPURenderPassDescriptor` BYTE-IDENTICALLY
// to the inline descriptors each pass builds (rhiRenderPassToGpu, gated by
// rhi-renderpass-parity.test.ts) — so the migration is byte-for-byte the raw
// path, no topology drift. WebGL2 fail-closes (MRT / offscreen FBOs are the
// WebGL2 full-frame phase). Additive + inert: nothing in the live render loop
// builds these yet (the loop keeps its raw `GPUCommandEncoder`).

/** One colour attachment of an offscreen / MRT pass. `clearValue` is RGBA in
 *  straight-alpha unit floats (the array form the rest of the RHI uses, e.g.
 *  RhiScreenPassDesc.clear); the WebGPU impl converts it to the `{r,g,b,a}`
 *  GPUColor the raw passes write. Required only when `loadOp === 'clear'`.
 *  `resolveTarget` is the MSAA→single-sample resolve view (the swapchain) — set
 *  only on the pass that owns the resolve (the resolveOwner chain); absent =
 *  no resolve, byte-identical to the raw `resolveTarget: undefined`. */
export interface RhiColorAttachment {
  view: RhiTextureView
  resolveTarget?: RhiTextureView
  loadOp: 'load' | 'clear'
  storeOp: 'store' | 'discard'
  clearValue?: readonly [number, number, number, number]
}

/** The depth-stencil attachment of an offscreen pass. Every op is OPTIONAL so
 *  the descriptor reproduces each pass's exact shape: the opaque pass carries
 *  depth + stencil clear values even on a load sub-pass (they are ignored but
 *  present in the raw descriptor); the OIT-fill pass OMITS the clear values
 *  (pure load). A field left undefined is omitted from the mapped GPU
 *  descriptor — byte-identical to the raw inline form. */
export interface RhiDepthStencilAttachment {
  view: RhiTextureView
  depthLoadOp?: 'load' | 'clear'
  depthStoreOp?: 'store' | 'discard'
  depthClearValue?: number
  stencilLoadOp?: 'load' | 'clear'
  stencilStoreOp?: 'store' | 'discard'
  stencilClearValue?: number
}

/** A backend-agnostic offscreen / MRT render-pass request. Up to N colour
 *  attachments (the map's topology uses 1, or 2 for the opaque-pick and
 *  OIT-fill MRT pairs) + an optional depth-stencil. Timestamp profiling is
 *  intentionally NOT modelled here — it is a WebGPU-encoder concern layered at
 *  the migration call-site (the gpuTimer seam), not part of the topology. */
export interface RhiRenderPassDesc {
  colorAttachments: ReadonlyArray<RhiColorAttachment>
  depthStencilAttachment?: RhiDepthStencilAttachment
  label?: string
}

// ── Compute (P0.4, gap #4) ───────────────────────────────────────────────────
// The live ComputeDispatcher (gpu/compute.ts) runs RAW device.createComputePipeline
// + encoder.beginComputePass + dispatchWorkgroups today (per-feature paint kernels:
// match / case / interpolate). This contract expresses that dispatch backend-
// agnostically. WebGPU maps 1:1 (byte-identical to the raw calls); WebGL2 FAIL-
// CLOSES — ES 3.00 has no compute, so a kernel that tries to originate through the
// RHI can never silently produce a wrong frame (the GLSL paint path is a separate
// data-texture emulation). Additive + inert + OPTIONAL: no caller routes through
// here until the P1 compute flip — `WebGpuDevice` implements these, `WebGl2Device`
// throws.
export interface RhiComputePipeline { readonly __rhi: 'computepipeline' }

/** A compute-pipeline source. The bind-group layout is auto-derived (mirroring the
 *  live `layout: 'auto'`) and fetched via `RhiDevice.computeBindGroupLayout`. */
export interface RhiComputePipelineDesc {
  /** WGSL compute-shader source. */
  code: string
  /** Compute entry-point name (same body + different entry-point = a distinct
   *  pipeline, matching the ComputeKernel cache key). */
  entryPoint: string
  label?: string
}

/** A recorded compute pass — the `GPUComputePassEncoder` subset the dispatcher
 *  uses: set a pipeline + bind group, dispatch workgroups, end. */
export interface RhiComputePass {
  setPipeline(pipeline: RhiComputePipeline): void
  setBindGroup(index: number, group: RhiBindGroup): void
  /** Dispatch workgroups; `y`/`z` default to 1 (WebGPU semantics). */
  dispatchWorkgroups(x: number, y?: number, z?: number): void
  end(): void
}

/** Optional compute-pass parameters. Timestamp writes are intentionally NOT
 *  modelled — a WebGPU-encoder profiling concern layered at the call-site's
 *  gpuTimer seam (exactly like the render pass). */
export interface RhiComputePassDesc { label?: string }

/** A command encoder — the scope offscreen passes are recorded into and
 *  submitted from. WebGPU wraps `GPUCommandEncoder` (begin-pass + finish→
 *  queue.submit). WebGL2 fail-closes: `createCommandEncoder` throws (slice-1
 *  WebGL2 is screen-pass only; MRT + offscreen FBOs are the full-frame phase).
 *  Additive + inert: the render loop keeps creating + submitting its RAW
 *  `GPUCommandEncoder` today — this seam is what P1 adopts to route the passes
 *  through the RHI. */
export interface RhiCommandEncoder {
  /** Begin an offscreen / MRT render pass; record draws against the returned
   *  pass, then call `pass.end()` (mirroring the raw `subPass.end()` every
   *  pass body already calls). */
  beginRenderPass(desc: RhiRenderPassDesc): RhiRenderPass
  /** Finish recording + submit this encoder's work (WebGPU: queue.submit of
   *  encoder.finish()). One encoder → one submit, matching the loop's single
   *  per-frame submit. */
  finish(): void
}

/** The device — creates resources + pipelines. One impl per backend. */
export interface RhiDevice {
  /** Which backend this device is — a POSITIVE marker so a forced-WebGL2 path can be
   *  asserted to have actually run on WebGL2 (on a WebGPU-equipped box a silently-ignored
   *  toggle would otherwise look like a pass). 'webgpu' (WebGpuDevice) | 'webgl2' (WebGl2Device). */
  readonly backend: 'webgpu' | 'webgl2'
  createBuffer(desc: RhiBufferDesc): RhiBuffer
  writeBuffer(buffer: RhiBuffer, byteOffset: number, data: BufferSource): void
  /** Release a buffer's GPU memory (WebGPU `GPUBuffer.destroy()`; WebGL2
   *  `gl.deleteBuffer`). Called at the SAME teardown sites the raw `.destroy()`
   *  was — resource lifetime is the caller's, not centralized by the RHI. */
  destroyBuffer(buffer: RhiBuffer): void
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

  // ── Offscreen / MRT command encoder (additive, OPTIONAL) ─────────────────────
  // The render loop creates + submits its command encoder RAW today
  // (render-loop.ts:216/501). To originate the passes/ offscreen + MRT topology
  // through the RHI the encoder must come from here. OPTIONAL + additive +
  // INERT: `WebGpuDevice` returns a wrapper over a native `GPUCommandEncoder`
  // (begin-pass via the byte-identical rhiRenderPassToGpu mapper); `WebGl2Device`
  // FAIL-CLOSES (throws) — MRT + offscreen FBOs are the WebGL2 full-frame phase.
  // The live loop does NOT call this yet; it is the seam P1 adopts.

  /** Create a command encoder for offscreen / MRT passes. WebGL2 throws. */
  createCommandEncoder?(): RhiCommandEncoder
}
