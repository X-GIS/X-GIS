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
export interface RhiBuffer {
  readonly __rhi: 'buffer'
}
export interface RhiTexture {
  readonly __rhi: 'texture'
}
export interface RhiTextureView {
  readonly __rhi: 'view'
}
export interface RhiSampler {
  readonly __rhi: 'sampler'
}
export interface RhiBindGroup {
  readonly __rhi: 'bindgroup'
}
export interface RhiBindGroupLayout {
  readonly __rhi: 'bindlayout'
}
export interface RhiPipeline {
  readonly __rhi: 'pipeline'
}

/** Semantic buffer roles (impl maps to backend usage flags). */
export type RhiBufferUsage = 'uniform' | 'vertex' | 'index' | 'storage'

export interface RhiBufferDesc {
  size: number
  usage: RhiBufferUsage
  /** Buffer is written after creation via writeBuffer (the common case). */
  writable?: boolean
  /** Buffer can be read as the SOURCE of a `copyBufferToBuffer` (e.g. an
   *  arena compaction/grow ping-pong reading the old buffer as the copy source).
   *  WebGPU ORs in `GPUBufferUsage.COPY_SRC`; WebGL2 ignores it (any GL buffer is
   *  a valid `copyBufferSubData` read source). Additive + default false: an
   *  un-set buffer's usage flags are byte-identical to before. */
  copySrc?: boolean
  label?: string
}

/** Semantic texture formats — impl maps to backend (e.g. swapchain bgra8).
 *  `rgba16float` is a half-float accumulation target (e.g. weighted-blend OIT);
 *  WebGL2 fail-closes on it (rendering to it needs EXT_color_buffer_float —
 *  deferred to the WebGL2 full-frame phase). */
export type RhiTextureFormat =
  | 'rgba8unorm'
  | 'r8unorm'
  | 'bgra8unorm'
  | 'depth24plus-stencil8'
  | 'rg32uint'
  | 'r32uint'
  | 'r16float'
  | 'rgba16float'

export interface RhiTextureDesc {
  width: number
  height: number
  format: RhiTextureFormat
  usage: ReadonlyArray<'sample' | 'render' | 'copy-dst' | 'copy-src'>
  sampleCount?: number
  label?: string
}

export type RhiFilter = 'nearest' | 'linear'
export interface RhiSamplerDesc {
  mag: RhiFilter
  min: RhiFilter
  label?: string
}

/** One entry in a bind-group LAYOUT — what kind of resource lives at a slot.
 *  Derived from the shader's reflection (DSL), not hand-authored, in the full
 *  design; the pilot passes it explicitly to keep the seam small. */
export interface RhiBindLayoutEntry {
  binding: number
  /** 'storage' = read-only storage buffer (e.g. per-instance attribute data).
   *  WebGPU-native; a WebGL2 backend would lower these to textures/UBOs. */
  kind: 'uniform' | 'texture' | 'sampler' | 'storage'
  /** Uniform bound with a per-draw dynamic offset (a shared-buffer slot pattern). */
  dynamic?: boolean
  /** The shader's reflection NAME for this binding (from the DSL). A WebGL2
   *  backend reflects the linked program BY NAME with it — a `uniform` block's
   *  tag = the struct name, a `texture`'s sampler-uniform name = the binding
   *  name — so multi-resource groups bind correctly regardless of declaration
   *  order. WebGPU ignores it. WebGL2 falls back to by-order pairing when it
   *  is absent — safe for a SINGLE entry of a kind (the documented raster
   *  pattern), ambiguous for ≥2 same-kind entries, so `WebGl2Device`
   *  fail-louds at layout creation when a multi-same-kind group leaves any
   *  entry unnamed (#783). */
  name?: string
}

/** A backend-neutral routing handle for a render pipeline (#834 M-B3). Some
 *  consumers receive a pipeline object ONLY to route a draw to its pre-built
 *  RHI Material twin by stable factory `label` — they never issue a native
 *  `setPipeline` on it (the draw runs the twin's own pipeline). Those
 *  pass-through / route-by-label params type as `RhiPipelineHandle` so that path
 *  names no native GPU pipeline symbol; a concrete backend pipeline (which has a
 *  `label`) is structurally one of these. Paths that genuinely `setPipeline` a
 *  native pipeline keep the native type until their pass topology moves to the
 *  RHI (Layer-2). */
export interface RhiPipelineHandle {
  readonly label: string
}

/** A concrete resource bound at a slot when building a bind GROUP. */
export type RhiBindResource =
  | { buffer: RhiBuffer; offset?: number; size?: number }
  | { view: RhiTextureView }
  | { sampler: RhiSampler }

export interface RhiBindEntry {
  binding: number
  resource: RhiBindResource
}

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
  /** `writeMask` (colour-write bitmask; 0xf = ALL) defaults per format: rg32uint pick targets
   *  default 0 (the non-pickable pattern — a primitive that writes vec2u(0,0)), every other target
   *  defaults 0xf. A PICKABLE primitive (one that writes a feature id) sets the pick
   *  target's writeMask to 0xf explicitly to override the default. */
  colorTargets: ReadonlyArray<{
    format: RhiTextureFormat
    blend?: 'alpha' | 'premult' | 'additive' | 'max' | 'none'
    writeMask?: number
  }>
  depthStencil?: {
    format: RhiTextureFormat
    write: boolean
    compare: 'always' | 'less' | 'less-equal'
    /** Polygon-offset depth bias (e.g. primitives pulled toward the camera). */
    bias?: { constant: number; slopeScale: number; clamp: number }
    /** Clip-mask stencil state. Absent = inert stencil (byte-identical to a
     *  disabled-stencil pipeline). `compare`/`passOp` + the masks express the
     *  write / test / clip-mask stencil states; the runtime sets the reference
     *  per-draw via `setStencilReference`. */
    stencil?: {
      compare: 'always' | 'equal'
      passOp: 'keep' | 'replace'
      writeMask: number
      readMask: number
    }
  }
  sampleCount?: number
  /** Draws with no vertex buffers (e.g. procedural full-screen / grid draws). */
  vertexBuffers?: ReadonlyArray<{
    stride: number
    attributes: ReadonlyArray<{ location: number; offset: number; format: string }>
  }>
  /** Triangle face culling. Default 'none' (byte-identical to the prior hardcoded primitive).
   *  'back' back-face culls (e.g. dropping a sphere's far hemisphere). */
  cullMode?: 'none' | 'back' | 'front'
  /** Winding that counts as front-facing (#1049). Default 'ccw' — BOTH
   *  backends previously relied on their implicit CCW defaults; modeling it
   *  here means a future winding flip is expressed in the descriptor instead
   *  of ad-hoc native calls. */
  frontFace?: 'ccw' | 'cw'
  /** Primitive topology. Default 'triangle-list' (byte-identical to the prior hardcoded
   *  primitive). 'line-list' draws each vertex pair as an independent segment — the
   *  lat/lon graticule overlay's geometry (the only line-list consumer so far). */
  topology?: 'triangle-list' | 'line-list'
  label?: string
}

/** A draw scope — the renderer records draws against this, never the native
 *  pass encoder. The WebGPU impl wraps GPURenderPassEncoder; a WebGL2 impl sets
 *  gl state + issues drawArrays. setBindGroup's dynamicOffsets back a shared-buffer
 *  uniform-slot pattern (WebGPU dynamic offset / WebGL2 bindBufferRange). */
export interface RhiRenderPass {
  setPipeline(p: RhiPipeline): void
  setBindGroup(index: number, group: RhiBindGroup, dynamicOffsets?: number[]): void
  /** Bind a vertex buffer, optionally a byte sub-range (a sub-slice of a
   *  shared arena buffer). `offset`/`size` default to the whole buffer (offset 0)
   *  — byte-identical to the no-offset bind. WebGPU: native setVertexBuffer offset/
   *  size; WebGL2: `offset` is added to each attribute's `vertexAttribPointer` byte
   *  offset (`size` is implied by the draw count). */
  setVertexBuffer(slot: number, buffer: RhiBuffer, offset?: number, size?: number): void
  setIndexBuffer(
    buffer: RhiBuffer,
    format: 'uint16' | 'uint32',
    offset?: number,
    size?: number,
  ): void
  draw(vertexCount: number, instanceCount?: number, firstVertex?: number): void
  drawIndexed(indexCount: number, instanceCount?: number): void
  /** Per-draw stencil reference value (the clip-mask ID). Inert on a
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
// `beginScreenPass` covers ONLY the single-sample backbuffer. A richer offscreen
// topology (an MRT pass writing a pick target at `@location1`, a weighted-OIT
// accum+revealage MRT, MSAA-resolve, an offscreen MAX-blend pass, a
// single-channel-float multi-pass) runs RAW
// `encoder.beginRenderPass(GPURenderPassDescriptor)` today. These descriptors
// express that topology backend-agnostically so passes can originate through
// `RhiCommandEncoder.beginRenderPass` instead at P1.
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
 *  attachments (a consumer uses 1, or 2 for an opaque-pick or OIT-fill MRT
 *  pair) + an optional depth-stencil. Timestamp profiling is
 *  intentionally NOT modelled here — it is a WebGPU-encoder concern layered at
 *  the migration call-site (the gpuTimer seam), not part of the topology. */
export interface RhiRenderPassDesc {
  colorAttachments: ReadonlyArray<RhiColorAttachment>
  depthStencilAttachment?: RhiDepthStencilAttachment
  label?: string
}

// ── Compute (P0.4, gap #4) ───────────────────────────────────────────────────
// A compute dispatcher runs RAW device.createComputePipeline +
// encoder.beginComputePass + dispatchWorkgroups today. This contract expresses
// that dispatch backend-agnostically. WebGPU maps 1:1 (byte-identical to the raw
// calls); WebGL2 FAIL-CLOSES — ES 3.00 has no compute, so a kernel that tries to
// originate through the RHI can never silently produce a wrong frame (a WebGL2
// consumer emulates compute separately via data textures). Additive + inert +
// OPTIONAL: no caller routes through here until the P1 compute flip —
// `WebGpuDevice` implements these, `WebGl2Device` throws.
export interface RhiComputePipeline {
  readonly __rhi: 'computepipeline'
}

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
export interface RhiComputePassDesc {
  label?: string
}

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
  /** GPU→GPU buffer copy of `size` bytes from `src[srcOffset]` to `dst[dstOffset]`
   *  (e.g. an arena defrag/grow ping-pong relocating the live set from the old
   *  buffer into a freshly-packed one). WebGPU maps 1:1 to
   *  `GPUCommandEncoder.copyBufferToBuffer`; WebGL2 binds the two buffers to
   *  COPY_READ/COPY_WRITE and issues `gl.copyBufferSubData` immediately. `size`
   *  + the offsets must be 4-byte aligned (WebGPU requirement; the caller aligns). */
  copyBufferToBuffer(
    src: RhiBuffer,
    srcOffset: number,
    dst: RhiBuffer,
    dstOffset: number,
    size: number,
  ): void
  /** Finish recording + submit this encoder's work (WebGPU: queue.submit of
   *  encoder.finish()). One encoder → one submit, matching the loop's single
   *  per-frame submit. WebGL2 is immediate-mode (copies already executed) → no-op. */
  finish(): void
}

/** Immutable device capability record — the answers a frame asks of its device.
 *  Populated once at device creation; every field must be phrased as a device
 *  truth any hypothetical backend (Metal/D3D/GLES) could answer, and every
 *  field lists its consumer seam — a cap with no consumer is dead weight,
 *  a cap only one backend can answer honestly is identity in disguise (§5.3). */
export interface RhiCaps {
  /** Max MSAA sample count for the frame's colour/depth targets (1 = none).
   *  WebGPU: 4. WebGL2: 1 today (ES 3.0 renderbuffer MSAA is a future value
   *  change, not a shape change). Consumer: RenderTargets.ensure + pipeline
   *  sampleCount + the resolveOwner logic. */
  readonly maxSampleCount: number
  /** A render pass presenting to the screen can carry additional MRT colour
   *  attachments (the live rg32uint pick target). WebGPU: true (the swapchain
   *  is an ordinary texture). WebGL2: false (default framebuffer cannot MRT).
   *  Consumer: opaque-pass pick-attachment build; false selects the on-demand
   *  offscreen pick strategy. */
  readonly presentablePassMrt: boolean
  /** How a pick texel comes back: 'async' = copy-to-buffer + map (pool);
   *  'sync' = immediate readPixels. Consumer: interaction-controller readback
   *  strategy behind the unchanged async pickAt() public contract. */
  readonly pickReadback: 'async' | 'sync'
  /** Render-to-float-and-blend targets (r16float/rgba16float attachments with
   *  additive/max blend): heatmap accumulation, weighted OIT. WebGPU: true.
   *  WebGL2: feature-DETECTED (EXT_color_buffer_float && EXT_float_blend) —
   *  the canonical proof this is a capability, not an alias for backend
   *  identity: a desktop WebGL2 context commonly answers true. Consumer:
   *  heatmap/oit shouldRun gates + RenderTargets float-target allocation. */
  readonly floatBlendTargets: boolean
  /** Compute execution: native compute passes or the fragment-GPGPU lowering.
   *  Consumer: the compute dispatcher seam only — passes never read it. */
  readonly compute: 'native' | 'fragment-emulated'
  /** GPU timestamp profiling available. Consumer: GPUTimer construction gate
   *  (replaces GPUContext.timestampQuerySupported plumbed per-backend). */
  readonly timestampQuery: boolean
  /** Command execution semantics: 'deferred' (work runs at submit) or
   *  'immediate' (draws execute at record time). CONFINED consumer: engine
   *  upload/draw primitives (UniformRing / staging flush policy inside
   *  executeItems) — never passes, never renderers (§5.3 confinement gate). */
  readonly executionModel: 'deferred' | 'immediate'
}

/** The device — creates resources + pipelines. One impl per backend. */
export interface RhiDevice {
  /** Which backend this device is — a POSITIVE marker so a forced-WebGL2 path can be
   *  asserted to have actually run on WebGL2 (on a WebGPU-equipped box a silently-ignored
   *  toggle would otherwise look like a pass). 'webgpu' (WebGpuDevice) | 'webgl2' (WebGl2Device). */
  readonly backend: 'webgpu' | 'webgl2'
  /** Immutable capability record, populated + frozen at device construction. A frame
   *  asks the device "can I…?" through this instead of branching on `backend` (§2.2).
   *  Required (not `?`-optional) by design: a backend that forgets to answer fails to
   *  compile, and no consumer ever needs a null-fallback that silently guesses. */
  readonly caps: RhiCaps
  createBuffer(desc: RhiBufferDesc): RhiBuffer
  writeBuffer(buffer: RhiBuffer, byteOffset: number, data: BufferSource): void
  /** Release a buffer's GPU memory (WebGPU `GPUBuffer.destroy()`; WebGL2
   *  `gl.deleteBuffer`). Called at the SAME teardown sites the raw `.destroy()`
   *  was — resource lifetime is the caller's, not centralized by the RHI. */
  destroyBuffer(buffer: RhiBuffer): void
  createTexture(desc: RhiTextureDesc): RhiTexture
  /** Write a width×height region of texels. `x`/`y` (default 0) place the region's
   *  top-left origin (e.g. a sub-region atlas upload); omitting them is
   *  byte-identical to the pre-origin signature. */
  writeTexture(
    texture: RhiTexture,
    data: BufferSource,
    bytesPerRow: number,
    width: number,
    height: number,
    x?: number,
    y?: number,
  ): void
  /** Release a texture's GPU memory (#782 — closes the `create*` ×N / `destroyBuffer`-only
   *  asymmetry). WebGPU `GPUTexture.destroy()`; WebGL2 `gl.deleteTexture`. Called at the SAME
   *  teardown sites the caller would otherwise reach behind the opaque handle for — lifetime is
   *  the caller's, not centralized by the RHI (mirrors `destroyBuffer`). */
  destroyTexture(texture: RhiTexture): void
  /** Upload a decoded browser image (ImageBitmap / canvas) into a texture —
   *  the backend-neutral `copyExternalImageToTexture` (e.g. decoded raster
   *  images). Top-left origin on both backends: WebGPU
   *  `queue.copyExternalImageToTexture`; WebGL2 `texSubImage2D` with the
   *  bitmap source (no CPU readback). */
  copyExternalImage(
    texture: RhiTexture,
    source: ImageBitmap | HTMLCanvasElement,
    width: number,
    height: number,
  ): void
  createView(texture: RhiTexture): RhiTextureView
  createSampler(desc: RhiSamplerDesc): RhiSampler
  /** Release a sampler (#782). WebGL2 `gl.deleteSampler`; on WebGPU a `GPUSampler` has NO native
   *  destroy (GC-owned) → no-op. A texture VIEW likewise has no destroy (WebGL2: the view IS the
   *  texture; WebGPU: `GPUTextureView` is GC-owned), so there is deliberately no `destroyView`. */
  destroySampler(sampler: RhiSampler): void
  createBindGroupLayout(entries: RhiBindLayoutEntry[]): RhiBindGroupLayout
  createBindGroup(layout: RhiBindGroupLayout, entries: RhiBindEntry[]): RhiBindGroup
  createPipeline(desc: RhiPipelineDesc): RhiPipeline
  /** Release a pipeline (#782). WebGL2 `gl.deleteProgram` — reclaims the linked `WebGLProgram`;
   *  without it a WebGL2 pipeline leaks its GL program on repeat creation. On WebGPU a
   *  `GPURenderPipeline` has NO native destroy (GC-owned) → no-op. Bind groups + bind-group
   *  layouts hold no ownable GPU resource (WebGL2: plain JS records; WebGPU: GC-owned), so they
   *  stay GC-owned with no `destroy` — the documented exception to the create/destroy pairing. */
  destroyPipeline(pipeline: RhiPipeline): void

  /** Release the ENTIRE device — the whole-device teardown keystone (distinct from
   *  the per-resource `destroy*` above, which free one handle). The map's lifecycle
   *  teardown (`destroy()` / re-init) routes through HERE instead of reaching for a
   *  native `GPUDevice.destroy()`, so a backend whose native device object is a
   *  fail-loud stub (the forced-WebGL2 `ctx.device` proxy) is never touched. WebGPU
   *  calls `GPUDevice.destroy()`; WebGL2 drops the GL context via WEBGL_lose_context
   *  (releasing every GL resource + returning the per-page context to the browser's
   *  pool). Required (not `?`-optional): a backend that can't tear down doesn't compile. */
  destroy(): void

  // ── Frame shell (required — #1046 F2 / #991 G2+G3, doc §2.4) ──────────────────
  // The render loop minted its command encoder + acquired the swapchain view RAW
  // (device.createCommandEncoder / context.getCurrentTexture().createView) and
  // submitted RAW (queue.submit). F2 sources those touchpoints HERE so the frame
  // shell no longer names the raw device/context — the seam F1 threaded onto the
  // frame (FrameContext.rhi). Required (not `?`-optional): a backend that can't
  // originate a frame doesn't compile (§2.2 verified-by-construction).

  /** Acquire the presentation surface's colour view for THIS frame (G2). WebGPU
   *  wraps `context.getCurrentTexture().createView()`; WebGL2 returns the FBO-0
   *  sentinel (inert until the F3 unified chain). Backends REUSE one wrapper across
   *  frames — the native view is re-minted every frame but the RHI handle is
   *  frame-invariant, so the allocation-paranoid 60 Hz loop never allocates a
   *  wrapper per frame (§5.5). */
  acquireScreenView(): RhiTextureView
  /** The per-frame command encoder, sourced through the RHI (G3). WebGPU mints a
   *  fresh native `GPUCommandEncoder` each frame behind a REUSED wrapper
   *  (frame-invariant, §5.5); `finish()` owns the single per-frame submit. DISTINCT
   *  from `createCommandEncoder`, which hands out an INDEPENDENT transient encoder
   *  for utility copies (arena compaction, VTR bake) that must not share the
   *  frame's reused wrapper. WebGL2 is inert here — the forced-WebGL2 twin renders
   *  through the screen-pass lifecycle, not this encoder. */
  acquireFrameEncoder(): RhiCommandEncoder

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
  /** Begin an OFFSCREEN pass nested inside the frame's screen pass (e.g. a
   *  MAX-blend accumulation target; an on-demand pick pass's colour+rg32uint MRT
   *  + depth-stencil). WebGL2: bind an FBO with the
   *  attachments' textures, set the viewport to the first attachment's size,
   *  clear per attachment (integer formats via clearBufferuiv); the returned
   *  pass's `end()` restores FBO 0 + the screen viewport so subsequent
   *  screen-pass draws continue unaffected. Resolve targets stay fail-closed
   *  (no MSAA on this isolated slice). */
  beginOffscreenPass?(desc: RhiRenderPassDesc): RhiRenderPass
  /** Read one RG32UI texel — a two-channel uint readback (e.g. a pick buffer:
   *  R = id, G = packed metadata). WebGL2: synchronous readPixels off an FBO
   *  bound to the texture; `y` is in TEXTURE rows (bottom-up — the caller
   *  flips from screen coords). WebGPU omits it (its pick readback is the
   *  async copyTextureToBuffer + mapAsync pool in interaction-controller). */
  readPixelRg32ui?(texture: RhiTexture, x: number, y: number): [number, number]
  /** Drain accumulated GL errors (WebGL2) so the loop can surface them into the same
   *  `_validationErrors` sink the WebGPU path uses. Returns + clears the queue. */
  takeGlErrors?(): string[]

  // ── Offscreen / MRT command encoder (additive, OPTIONAL) ─────────────────────
  // The render loop creates + submits its command encoder RAW today
  // (render-loop.ts:216/501). To originate the passes/ offscreen + MRT topology
  // through the RHI the encoder must come from here. OPTIONAL + additive +
  // INERT: `WebGpuDevice` returns a wrapper over a native `GPUCommandEncoder`
  // (begin-pass via the byte-identical rhiRenderPassToGpu mapper). `WebGl2Device`
  // returns a COPY-SCOPED encoder: `copyBufferToBuffer` works (gl.copyBufferSubData)
  // — an arena compaction/grow path needs it — but `beginRenderPass` still
  // FAIL-CLOSES (MRT + offscreen FBOs are the WebGL2 full-frame phase).

  /** Create a command encoder for offscreen / MRT passes + buffer copies. The
   *  optional `label` rides the native `GPUCommandEncoder` (DevTools attribution,
   *  WebGPU). WebGL2 returns a copy-only encoder (beginRenderPass throws). */
  createCommandEncoder?(label?: string): RhiCommandEncoder

  // ── Context-loss lifecycle (additive, OPTIONAL) ──────────────────────────────
  // WebGPU signals device loss via `GPUDevice.lost` (a Promise the boot awaits,
  // gpu.ts). WebGL2 signals it via DOM 'webglcontextlost' / 'webglcontextrestored'
  // events on the canvas. These OPTIONAL hooks let the boot subscribe to a
  // backend's native loss/restore signal WITHOUT naming a DOM event: `WebGl2Device`
  // owns the canvas listeners + `preventDefault()` (the restorability contract)
  // and fans out to the registered callbacks; `WebGpuDevice` OMITS them (its loss
  // path is the native `GPUDevice.lost` promise). Additive + optional so a backend
  // with no separate context-loss event simply doesn't implement them (#1153 P2 R3).

  /** Subscribe to backend context loss (WebGL2 'webglcontextlost'). The device
   *  calls `preventDefault()` on the native event — required for the browser to
   *  ever restore the context — before invoking `cb`. Omitted on backends whose
   *  loss path is elsewhere (WebGPU: `GPUDevice.lost`). */
  onContextLost?(cb: () => void): void
  /** Subscribe to backend context restore (WebGL2 'webglcontextrestored'). */
  onContextRestored?(cb: () => void): void
}

/** The screen-pass lifecycle as a NON-optional capability (#783). The methods are
 *  `?`-optional on `RhiDevice` because only the WebGl2Device slice implements them
 *  today (the WebGPU path keeps its raw loop — Story-7 convergence). A consumer that
 *  reaches for them must narrow through `asScreenPassDevice` FIRST, so presence is
 *  proven by the type instead of asserted with `!` (the footgun: `device.beginScreenPass!`
 *  compiles green and throws at runtime on a device that omits it). */
export interface RhiScreenPassDevice {
  beginScreenPass(desc: RhiScreenPassDesc): RhiRenderPass
  endScreenPass(pass: RhiRenderPass): void
  beginOffscreenPass(desc: RhiRenderPassDesc): RhiRenderPass
  readPixelRg32ui(texture: RhiTexture, x: number, y: number): [number, number]
  takeGlErrors?(): string[]
}

/** Narrow an `RhiDevice` to its screen-pass capability, or `null` when the backend
 *  doesn't provide it (#783). The single source of the `backend === 'webgl2' &&
 *  beginScreenPass && endScreenPass` check the render loop used to inline + `!`-assert. */
export function asScreenPassDevice(
  d: RhiDevice | undefined,
): (RhiDevice & RhiScreenPassDevice) | null {
  return d && d.backend === 'webgl2' && d.beginScreenPass && d.endScreenPass && d.beginOffscreenPass
    ? (d as RhiDevice & RhiScreenPassDevice)
    : null
}

// ═══ Render context — NOT here ═══
//
// The neutral render context (`RenderContext`) and its family
// (`RhiDeviceLostInfo`, `BackendChoice`) live in @xgis/engine, not this package
// (#834 map→engine). A render HARDWARE interface describes GPU resources —
// buffers, textures, pipelines, passes — and must be justifiable without naming
// a host canvas, a per-frame render-loop state, or any consumer. Bundling a
// device with a canvas + frame metadata is an engine composition concern, so it
// sits one layer up. Consumers import those from @xgis/engine.
