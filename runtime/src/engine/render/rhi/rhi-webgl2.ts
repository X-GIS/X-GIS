// ═══ RHI — WebGL2 backend (fallback proof) ═══
//
// The SECOND RHI impl: when WebGPU is unavailable, renderers that target the RHI
// run unchanged on WebGL2. This module wraps a WebGL2RenderingContext behind the
// same RhiDevice / RhiRenderPass the WebGPU impl (rhi-webgpu.ts) wraps GPUDevice.
//
// ─── INTERFACE DIVERGENCES (WebGPU-shaped RHI → WebGL2) ───────────────────────
// The RHI was shaped around WebGPU. WebGL2 has a different resource model, so the
// impl absorbs the gaps (callers stay backend-blind). The notable ones:
//
//  • SHADER SOURCE. WGSL is ONE module (`desc.code` + vsEntry/fsEntry). GLSL ES
//    3.00 is single-`main()`-per-stage, so this backend needs the TWO strings
//    emitGlslModule(m,'vertex') / (m,'fragment') — carried on the additive
//    RhiPipelineDesc.vsCode / fsCode. createPipeline THROWS if they are absent.
//
//  • NO PIPELINE OBJECTS. WebGPU bakes blend/depth/vertex-layout into an immutable
//    pipeline. WebGL2 is mutable global state, so a "pipeline" here is a linked
//    PROGRAM + the recorded state; setPipeline = useProgram + apply blend/depth.
//
//  • NO BIND GROUPS. WebGPU bundles resources into an immutable group bound in one
//    call. WebGL2 binds each resource to its own GL slot (UBO block binding point /
//    texture unit / sampler unit), so a "bind group" is just the RECORDED resource
//    list, replayed at setBindGroup time onto GL slots.
//
//  • NO TEXTURE VIEWS / FUSED SAMPLERS. WebGL2 has no view objects (the texture IS
//    the view), and GLSL fuses texture+sampler into one combined sampler2D — the
//    standalone sampler binding (dropped by the GLSL backend) re-attaches as a GL
//    sampler object bound to the paired texture's unit.
//
//  • REFLECTION BY NAME (+ by-order fallback). When a RhiBindLayoutEntry carries
//    the shader binding NAME (the DSL reflection feeds it — a uniform block's tag =
//    struct name, a texture's sampler-uniform name = binding name), createPipeline
//    binds the program's blocks/samplers BY NAME (getUniformBlockIndex /
//    getUniformLocation), so a MULTI-resource group binds correctly regardless of
//    declaration order. An un-named entry falls back to BY ORDER (exact for the
//    one-UBO + one-texture render-shader shape). Names close the former order-only
//    gap (the proof's first finding).
//
// FAIL-CLOSED: a `storage` buffer/binding has no WebGL2 equivalent (no SSBO in ES
// 3.00) — createBuffer('storage') / a storage layout entry throw, mirroring the
// GLSL backend's fail-closed (point/line/heatmap stay WebGPU-only until data-
// texture emulation lands).

import type {
  RhiDevice, RhiBuffer, RhiTexture, RhiTextureView, RhiSampler, RhiBindGroup,
  RhiBindGroupLayout, RhiPipeline, RhiRenderPass, RhiBufferDesc, RhiTextureDesc,
  RhiSamplerDesc, RhiBindLayoutEntry, RhiBindEntry, RhiPipelineDesc, RhiTextureFormat, RhiBufferUsage,
  RhiScreenPassDesc, RhiCommandEncoder,
} from './rhi'

// Each opaque RHI handle stores a rich GL record (cast both ways inside this
// module). WebGL2 needs MORE per-handle metadata than WebGPU (a buffer's GL
// target, a bind group's recorded resources, a pipeline's program + state), so
// the records are structs, not bare native objects.
interface Gl2Buffer { buf: WebGLBuffer; target: GLenum; usage: RhiBufferUsage; size: number }
// A 'storage' RHI buffer has no WebGL2 equivalent (no SSBO in ES 3.00) — it is emulated
// as a 2D-TILED R32F DATA TEXTURE (W×H, the GLSL pre-pass reads element i at texel
// (i%W, i/W)). `tex` is bound to a texture unit like a sampled texture; width × height
// holds the f32 count (W capped at 2048 so large arrays wrap across rows).
interface Gl2StorageBuffer { storageTex: WebGLTexture; width: number; height: number; size: number }
interface Gl2Texture { tex: WebGLTexture; width: number; height: number; format: RhiTextureFormat }
interface Gl2View { texture: Gl2Texture }
interface Gl2Sampler { samp: WebGLSampler }
interface Gl2BindGroupLayout { entries: ReadonlyArray<RhiBindLayoutEntry> }
interface Gl2BindGroup { layout: Gl2BindGroupLayout; entries: ReadonlyArray<RhiBindEntry> }
interface Gl2Pipeline {
  program: WebGLProgram
  blend: 'alpha' | 'premult' | 'additive' | 'max' | 'none' | undefined
  depth?: { write: boolean; compare: 'always' | 'less' | 'less-equal'; bias?: { constant: number; slopeScale: number; clamp: number } }
  vertexBuffers: ReadonlyArray<{ stride: number; attributes: ReadonlyArray<{ location: number; offset: number; format: string }> }>
  layouts: ReadonlyArray<Gl2BindGroupLayout>
}

const wrap = <T>(rec: unknown): T => rec as T
const un = <T>(h: unknown): T => h as T

// ── format / blend mapping (mirrors rhi-webgpu so a future pixel-parity holds) ──

function texFmt(gl: WebGL2RenderingContext, f: RhiTextureFormat): { internal: GLenum; format: GLenum; type: GLenum } {
  switch (f) {
    case 'rgba8unorm': return { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE }
    case 'bgra8unorm': return { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE } // WebGL2 has no BGRA8 storage; host orders bytes
    case 'r16float': return { internal: gl.R16F, format: gl.RED, type: gl.HALF_FLOAT }
    case 'rg32uint': return { internal: gl.RG32UI, format: gl.RG_INTEGER, type: gl.UNSIGNED_INT }
    case 'r32uint': return { internal: gl.R32UI, format: gl.RED_INTEGER, type: gl.UNSIGNED_INT } // core color-renderable, no extension — the compute-as-draw target
    case 'depth24plus-stencil8': return { internal: gl.DEPTH24_STENCIL8, format: gl.DEPTH_STENCIL, type: gl.UNSIGNED_INT_24_8 }
    case 'rgba16float':
      // Fail-CLOSED: the OIT weighted-blend accum target. Rendering TO rgba16float
      // needs EXT_color_buffer_float, and the OIT MRT topology is offscreen anyway —
      // both are the WebGL2 full-frame phase, not slice-1.
      throw new Error('webgl2: rgba16float (OIT accum) not yet supported (needs EXT_color_buffer_float; deferred to the WebGL2 full-frame phase)')
  }
}

const VFMT: Readonly<Record<string, { size: number; type: 'f32' | 'u8'; normalized: boolean }>> = {
  float32: { size: 1, type: 'f32', normalized: false },
  float32x2: { size: 2, type: 'f32', normalized: false },
  float32x3: { size: 3, type: 'f32', normalized: false },
  float32x4: { size: 4, type: 'f32', normalized: false },
  unorm8x4: { size: 4, type: 'u8', normalized: true },
  uint8x4: { size: 4, type: 'u8', normalized: false },
}

function applyBlend(gl: WebGL2RenderingContext, mode: Gl2Pipeline['blend']): void {
  if (!mode || mode === 'none') { gl.disable(gl.BLEND); return }
  gl.enable(gl.BLEND)
  if (mode === 'max') { gl.blendEquation(gl.MAX); gl.blendFunc(gl.ONE, gl.ONE); return } // translucent-line offscreen accum
  gl.blendEquation(gl.FUNC_ADD)
  if (mode === 'alpha') {
    // STRAIGHT alpha — byte-matches rhi-webgpu BLEND_ALPHA (color src-alpha, alpha one).
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  } else if (mode === 'premult') {
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
  } else { // additive
    gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE)
  }
}

function compile(gl: WebGL2RenderingContext, type: GLenum, src: string): WebGLShader {
  const sh = gl.createShader(type)
  if (!sh) throw new Error('webgl2: createShader failed')
  gl.shaderSource(sh, src); gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) ?? ''
    throw new Error(`webgl2: ${type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'} compile failed:\n${log}\n--- source ---\n${src}`)
  }
  return sh
}

const SAMPLER_TYPES = new Set<number>()

// UBO binding-point namespace stride: a uniform's GL binding point is `group * STRIDE +
// binding`, so two bind groups can each use binding 0 without colliding on point 0. group 0
// maps to its raw binding (single-group gates unchanged). 8 = max bindings/group, well clear
// of WebGL2's MAX_UNIFORM_BUFFER_BINDINGS (≥ 24).
const GROUP_BINDING_STRIDE = 8

class WebGl2RenderPass implements RhiRenderPass {
  private cur?: Gl2Pipeline
  private vbuf?: Gl2Buffer
  private vbufOffset = 0
  private ibuf?: { buf: Gl2Buffer; type: GLenum }
  constructor(private readonly gl: WebGL2RenderingContext) {}

  setPipeline(p: RhiPipeline): void {
    const pl = un<Gl2Pipeline>(p)
    this.cur = pl
    const gl = this.gl
    gl.useProgram(pl.program)
    applyBlend(gl, pl.blend)
    if (pl.depth) {
      gl.enable(gl.DEPTH_TEST)
      gl.depthMask(pl.depth.write)
      gl.depthFunc(pl.depth.compare === 'less' ? gl.LESS : pl.depth.compare === 'less-equal' ? gl.LEQUAL : gl.ALWAYS)
      if (pl.depth.bias) { gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(pl.depth.bias.slopeScale, pl.depth.bias.constant) }
      else gl.disable(gl.POLYGON_OFFSET_FILL)
    } else {
      gl.disable(gl.DEPTH_TEST)
      gl.depthMask(false)
    }
  }

  // Bind each recorded resource onto its GL slot. The UBO block binding point and
  // texture unit are the RHI binding NUMBER (the proof's single bind-group keeps
  // them distinct + small); a multi-group impl would namespace by group. A sampler
  // binds to the most-recent texture unit seen in this group (the fused-sampler pair).
  setBindGroup(index: number, group: RhiBindGroup, dynamicOffsets?: number[]): void {
    const gl = this.gl
    const bg = un<Gl2BindGroup>(group)
    const kindOf = (binding: number) => bg.layout.entries.find((e) => e.binding === binding)
    let lastTexUnit = 0
    let dynIdx = 0
    // iterate in binding order so a sampler sees its paired texture's unit first.
    const sorted = [...bg.entries].sort((a, b) => a.binding - b.binding)
    for (const e of sorted) {
      const le = kindOf(e.binding)
      const r = e.resource
      if (le?.kind === 'uniform' && 'buffer' in r) {
        const ubo = un<Gl2Buffer>(r.buffer)
        // UBO binding point is namespaced BY GROUP — two groups can each have binding 0
        // (raster: global UBO @group0/binding0 + per-tile UBO @group1/binding0). Without the
        // group stride both would bind to point 0 and collide, making the larger block read a
        // too-small buffer → INVALID_OPERATION at draw. group 0 maps to its raw binding, so
        // the single-group gates are unchanged. createPipeline assigns the matching points.
        const bp = index * GROUP_BINDING_STRIDE + e.binding
        const dyn = le.dynamic ? (dynamicOffsets?.[dynIdx++] ?? 0) : 0
        const offset = (r.offset ?? 0) + dyn
        const size = r.size ?? ubo.size - offset
        if (offset === 0 && size >= ubo.size) gl.bindBufferBase(gl.UNIFORM_BUFFER, bp, ubo.buf)
        else gl.bindBufferRange(gl.UNIFORM_BUFFER, bp, ubo.buf, offset, size)
      } else if (le?.kind === 'texture' && 'view' in r) {
        const unit = e.binding
        lastTexUnit = unit
        gl.activeTexture(gl.TEXTURE0 + unit)
        gl.bindTexture(gl.TEXTURE_2D, un<Gl2View>(r.view).texture.tex)
      } else if (le?.kind === 'sampler' && 'sampler' in r) {
        gl.bindSampler(lastTexUnit, un<Gl2Sampler>(r.sampler).samp)
      } else if (le?.kind === 'storage' && 'buffer' in r) {
        // storage emulated as a data texture → bind it to its unit like a sampled texture.
        const unit = e.binding
        lastTexUnit = unit
        gl.activeTexture(gl.TEXTURE0 + unit)
        gl.bindTexture(gl.TEXTURE_2D, un<Gl2StorageBuffer>(r.buffer).storageTex)
      }
    }
  }

  setVertexBuffer(_slot: number, buffer: RhiBuffer, offset = 0): void { this.vbuf = un<Gl2Buffer>(buffer); this.vbufOffset = offset }
  setIndexBuffer(buffer: RhiBuffer, format: 'uint16' | 'uint32'): void {
    this.ibuf = { buf: un<Gl2Buffer>(buffer), type: format === 'uint16' ? this.gl.UNSIGNED_SHORT : this.gl.UNSIGNED_INT }
  }

  private bindAttributes(): void {
    const gl = this.gl
    const pl = this.cur
    if (!pl || !this.vbuf) return
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbuf.buf)
    for (const vb of pl.vertexBuffers) {
      for (const a of vb.attributes) {
        const fmt = VFMT[a.format]
        if (!fmt) throw new Error(`webgl2: unsupported vertex format '${a.format}'`)
        gl.enableVertexAttribArray(a.location)
        // `vbufOffset` (default 0) shifts the per-tile arena sub-range start into the
        // attribute byte offset — default 0 is byte-identical to the no-offset bind.
        gl.vertexAttribPointer(a.location, fmt.size, fmt.type === 'f32' ? gl.FLOAT : gl.UNSIGNED_BYTE, fmt.normalized, vb.stride, a.offset + this.vbufOffset)
      }
    }
  }

  draw(vertexCount: number, instanceCount = 1, firstVertex = 0): void {
    this.bindAttributes()
    if (instanceCount > 1) this.gl.drawArraysInstanced(this.gl.TRIANGLES, firstVertex, vertexCount, instanceCount)
    else this.gl.drawArrays(this.gl.TRIANGLES, firstVertex, vertexCount)
  }

  setStencilReference(_ref: number): void {
    // WebGL2 stencil-state binding is deferred to the WebGL2 full-frame phase. The
    // WebGL2 pipeline does not enable GL_STENCIL_TEST yet, so the ref is inert; and
    // createPipeline fail-CLOSES on a stencil-configured pipeline, so a clip-mask
    // pipeline can never silently reach this path without its stencil.
  }

  drawIndexed(indexCount: number, instanceCount = 1): void {
    this.bindAttributes()
    if (!this.ibuf) throw new Error('webgl2: drawIndexed without an index buffer')
    this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, this.ibuf.buf)
    if (instanceCount > 1) this.gl.drawElementsInstanced(this.gl.TRIANGLES, indexCount, this.ibuf.type, 0, instanceCount)
    else this.gl.drawElements(this.gl.TRIANGLES, indexCount, this.ibuf.type, 0)
  }

  // WebGL2 is immediate-mode: there is no pass object to close, so ending is a
  // no-op (the next pass rebinds its FBO + viewport). The screen pass is finished
  // via WebGl2Device.endScreenPass instead.
  end(): void {}
}

/** Begin an RHI render pass over the gl context's CURRENTLY-bound framebuffer
 *  (the caller sets viewport / clears / binds the target FBO first), mirroring how
 *  wrapWebGpuPass adopts an externally-created encoder. */
export function wrapWebGl2Pass(device: WebGl2Device): RhiRenderPass {
  return new WebGl2RenderPass(device.gl)
}

export class WebGl2Device implements RhiDevice {
  readonly backend = 'webgl2' as const
  /** GL errors drained at endScreenPass (the WebGPU `_validationErrors` analog —
   *  WebGL2 has no async validation queue, so we poll `gl.getError()` per frame). */
  private _glErrors: string[] = []
  constructor(public readonly gl: WebGL2RenderingContext) {
    if (SAMPLER_TYPES.size === 0) {
      // sampler GLSL types (for createPipeline reflection); collected once per ctx kind.
      SAMPLER_TYPES.add(gl.SAMPLER_2D); SAMPLER_TYPES.add(gl.SAMPLER_CUBE)
      SAMPLER_TYPES.add(gl.SAMPLER_3D); SAMPLER_TYPES.add(gl.SAMPLER_2D_ARRAY)
    }
  }

  /** Begin the backbuffer screen pass: target FBO 0 (the default framebuffer the
   *  canvas presents), set the viewport, optionally clear. Slice-1 is single-sample
   *  + isolated — NO MSAA renderbuffer, NO shared depth (that is Story-5). The caller
   *  records draws against the returned pass, then calls endScreenPass. */
  beginScreenPass(desc: RhiScreenPassDesc): RhiRenderPass {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, desc.width, desc.height)
    gl.disable(gl.SCISSOR_TEST)
    if (desc.clear) {
      const [r, g, b, a] = desc.clear
      gl.clearColor(r, g, b, a)
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    }
    return new WebGl2RenderPass(gl)
  }

  /** Finish + present the screen pass. WebGL2 presents the default framebuffer
   *  implicitly at the end of the rAF turn; `gl.flush()` pushes the recorded commands.
   *  Drains `gl.getError()` into the queue so the loop can surface any fault (R4). */
  endScreenPass(_pass: RhiRenderPass): void {
    const gl = this.gl
    gl.flush()
    let err = gl.getError()
    while (err !== gl.NO_ERROR) {
      this._glErrors.push(`gl.getError 0x${err.toString(16)}`)
      err = gl.getError()
    }
  }

  /** Return + clear the accumulated GL errors (the loop pushes them into the shared
   *  `_validationErrors` sink the tests already assert empty). */
  takeGlErrors(): string[] {
    const out = this._glErrors
    this._glErrors = []
    return out
  }

  /** Fail-CLOSED: the offscreen / MRT command-encoder topology (opaque pick MRT,
   *  OIT accum+revealage MRT, the offscreen line + heatmap r16float passes) has
   *  no WebGL2 path in slice-1 — multi-attachment FBOs + EXT_color_buffer_float
   *  targets are the WebGL2 full-frame phase. Throwing here means a pass that
   *  tries to originate through the RHI on WebGL2 can never silently fall back to
   *  the screen pass and corrupt the frame. (Slice-1 WebGL2 = `beginScreenPass`.) */
  createCommandEncoder(): RhiCommandEncoder {
    throw new Error('webgl2: offscreen/MRT render passes (createCommandEncoder) not yet supported (slice-1 WebGL2 is screen-pass only; deferred to the WebGL2 full-frame phase)')
  }

  createBuffer(desc: RhiBufferDesc): RhiBuffer {
    const gl = this.gl
    if (desc.usage === 'storage') {
      // emulate as a 2D-TILED R32F data texture (the GLSL storageFetchF32 reads it via
      // texelFetch(t, ivec2(i % W, i / W))). R32F sampling/texelFetch is core WebGL2
      // (rendering-TO R32F needs EXT_color_buffer_float, but we only sample). width is
      // capped at 2048 (the guaranteed-safe WebGL2 MAX_TEXTURE_SIZE floor) so an array of
      // any size wraps across rows; the shader reads the actual width via textureSize().
      const tex = gl.createTexture()
      if (!tex) throw new Error('webgl2: createTexture (storage) failed')
      const floats = Math.max(1, Math.ceil(desc.size / 4))
      const width = Math.min(floats, 2048)
      const height = Math.ceil(floats / width)
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, height, 0, gl.RED, gl.FLOAT, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      return wrap<RhiBuffer>({ storageTex: tex, width, height, size: desc.size } satisfies Gl2StorageBuffer)
    }
    const buf = gl.createBuffer()
    if (!buf) throw new Error('webgl2: createBuffer failed')
    const target = desc.usage === 'index' ? gl.ELEMENT_ARRAY_BUFFER : desc.usage === 'uniform' ? gl.UNIFORM_BUFFER : gl.ARRAY_BUFFER
    gl.bindBuffer(target, buf)
    gl.bufferData(target, desc.size, gl.DYNAMIC_DRAW)
    return wrap<RhiBuffer>({ buf, target, usage: desc.usage, size: desc.size } satisfies Gl2Buffer)
  }

  writeBuffer(buffer: RhiBuffer, byteOffset: number, data: BufferSource): void {
    const b = un<Gl2Buffer | Gl2StorageBuffer>(buffer)
    const gl = this.gl
    if ('storageTex' in b) {
      // upload the f32 array into the W×H data texture, row-major (texel (i%W, i/W) = data[i]).
      // padded to the full W*H so the texSubImage covers the whole texture; a partial last row
      // reads 0 past the array end. byteOffset 0 = whole-array write (the storage-buffer case).
      const f32 = data instanceof Float32Array ? data : new Float32Array(data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer)
      const cap = b.width * b.height
      const padded = f32.length === cap ? f32 : (() => { const p = new Float32Array(cap); p.set(f32.subarray(0, Math.min(f32.length, cap)), byteOffset / 4); return p })()
      gl.bindTexture(gl.TEXTURE_2D, b.storageTex)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, b.width, b.height, gl.RED, gl.FLOAT, padded)
      return
    }
    gl.bindBuffer(b.target, b.buf)
    gl.bufferSubData(b.target, byteOffset, data as ArrayBufferView)
  }

  createTexture(desc: RhiTextureDesc): RhiTexture {
    const gl = this.gl
    const tex = gl.createTexture()
    if (!tex) throw new Error('webgl2: createTexture failed')
    gl.bindTexture(gl.TEXTURE_2D, tex)
    const { internal, format, type } = texFmt(gl, desc.format)
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, desc.width, desc.height, 0, format, type, null)
    // default sampling: nearest + clamp (a bound RhiSampler overrides via a sampler object).
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return wrap<RhiTexture>({ tex, width: desc.width, height: desc.height, format: desc.format } satisfies Gl2Texture)
  }

  writeTexture(texture: RhiTexture, data: BufferSource, _bytesPerRow: number, width: number, height: number): void {
    const t = un<Gl2Texture>(texture)
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, t.tex)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    const { format, type } = texFmt(gl, t.format)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, format, type, data as ArrayBufferView)
  }

  // WebGL2 has no texture views — the texture is its own view.
  createView(texture: RhiTexture): RhiTextureView { return wrap<RhiTextureView>({ texture: un<Gl2Texture>(texture) } satisfies Gl2View) }

  createSampler(desc: RhiSamplerDesc): RhiSampler {
    const gl = this.gl
    const samp = gl.createSampler()
    if (!samp) throw new Error('webgl2: createSampler failed')
    gl.samplerParameteri(samp, gl.TEXTURE_MIN_FILTER, desc.min === 'linear' ? gl.LINEAR : gl.NEAREST)
    gl.samplerParameteri(samp, gl.TEXTURE_MAG_FILTER, desc.mag === 'linear' ? gl.LINEAR : gl.NEAREST)
    gl.samplerParameteri(samp, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.samplerParameteri(samp, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return wrap<RhiSampler>({ samp } satisfies Gl2Sampler)
  }

  // A 'storage' entry is allowed — it is emulated as a data-texture sampler (see
  // createBuffer/setBindGroup + the GLSL storage→data-texture pre-pass). The GLSL emits a
  // sampler2D named after the binding, so it reflects + binds by NAME like a texture.
  createBindGroupLayout(entries: RhiBindLayoutEntry[]): RhiBindGroupLayout {
    return wrap<RhiBindGroupLayout>({ entries: [...entries] } satisfies Gl2BindGroupLayout)
  }

  createBindGroup(layout: RhiBindGroupLayout, entries: RhiBindEntry[]): RhiBindGroup {
    return wrap<RhiBindGroup>({ layout: un<Gl2BindGroupLayout>(layout), entries: [...entries] } satisfies Gl2BindGroup)
  }

  createPipeline(desc: RhiPipelineDesc): RhiPipeline {
    if (!desc.vsCode || !desc.fsCode) {
      throw new Error('webgl2: createPipeline requires GLSL vsCode/fsCode (emitGlslModule m,"vertex"/"fragment"); desc.code is WGSL — the single-module vs split-source divergence')
    }
    if (desc.depthStencil?.stencil) {
      // Fail-CLOSED: stencil pipeline state (the per-tile clip mask) has no WebGL2
      // path yet — deferred to the WebGL2 full-frame phase. A clip-mask pipeline
      // therefore never silently runs without its stencil on WebGL2.
      throw new Error('webgl2: stencil pipeline state not yet supported (deferred to the WebGL2 full-frame phase)')
    }
    const gl = this.gl
    const vs = compile(gl, gl.VERTEX_SHADER, desc.vsCode)
    const fs = compile(gl, gl.FRAGMENT_SHADER, desc.fsCode)
    const program = gl.createProgram()
    if (!program) throw new Error('webgl2: createProgram failed')
    gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`webgl2: link failed:\n${gl.getProgramInfoLog(program) ?? ''}`)
    }
    gl.deleteShader(vs); gl.deleteShader(fs)
    gl.useProgram(program)

    // ── REFLECTION ──
    // BY NAME when the layout entry carries the shader binding name (the DSL
    // reflection feeds it) — a uniform block's tag = struct name, a texture's
    // sampler-uniform name = binding name — so a multi-resource group binds
    // correctly regardless of declaration order. Falls back to BY ORDER for an
    // un-named entry (the single-texture proof shape, exact for 1 of each).
    const layouts = desc.bindGroupLayouts.map((l) => un<Gl2BindGroupLayout>(l))
    // Carry the GROUP index so the uniform-block binding point is namespaced the SAME way
    // setBindGroup binds the buffer (group * stride + binding) — else two groups' binding-0
    // blocks both map to point 0 and collide (INVALID_OPERATION at draw, raster's 2 UBOs).
    const uniformEntries = layouts.flatMap((l, g) => l.entries.filter((e) => e.kind === 'uniform').map((e) => ({ name: e.name, point: g * GROUP_BINDING_STRIDE + e.binding })))
    // a 'storage' binding emits as a sampler2D (data-texture emulation), so it reflects +
    // binds like a texture (its sampler uniform = the binding name → a texture unit).
    const textureEntries = layouts.flatMap((l) => l.entries.filter((e) => e.kind === 'texture' || e.kind === 'storage'))

    // uniform-block → block binding point = the entry's RHI binding number.
    const numBlocks = gl.getProgramParameter(program, gl.ACTIVE_UNIFORM_BLOCKS) as number
    let blockOrder = 0
    for (const ue of uniformEntries) {
      if (ue.name !== undefined) {
        const idx = gl.getUniformBlockIndex(program, ue.name)
        if (idx !== gl.INVALID_INDEX) gl.uniformBlockBinding(program, idx, ue.point)
      } else if (blockOrder < numBlocks) {
        gl.uniformBlockBinding(program, blockOrder++, ue.point)
      }
    }
    // collect active sampler-uniform locations in GL order (the by-order fallback).
    const numUniforms = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number
    const samplerLocs: WebGLUniformLocation[] = []
    for (let i = 0; i < numUniforms; i++) {
      const info = gl.getActiveUniform(program, i)
      if (!info || !SAMPLER_TYPES.has(info.type)) continue
      const loc = gl.getUniformLocation(program, info.name)
      if (loc) samplerLocs.push(loc)
    }
    // sampler uniform → texture unit = the entry's RHI binding number.
    let texOrder = 0
    for (const te of textureEntries) {
      if (te.name !== undefined) {
        const loc = gl.getUniformLocation(program, te.name)
        if (loc) gl.uniform1i(loc, te.binding)
      } else {
        const loc = samplerLocs[texOrder++]
        if (loc) gl.uniform1i(loc, te.binding)
      }
    }

    return wrap<RhiPipeline>({
      program,
      blend: desc.colorTargets[0]?.blend,
      depth: desc.depthStencil ? { write: desc.depthStencil.write, compare: desc.depthStencil.compare, bias: desc.depthStencil.bias } : undefined,
      vertexBuffers: desc.vertexBuffers ?? [],
      layouts,
    } satisfies Gl2Pipeline)
  }

  /** Run a compute-as-draw (the M2 compute→fragment-GPGPU lowering) into an offscreen
   *  R32UI target and read it back. `pipeline`'s fragment shader is the lowered kernel
   *  (`emitGlslModule {emulateCompute}`); `bindGroup` carries the storage input(s)
   *  (feat_data → data-texture). `u_count` is a BARE `uniform uvec4` set DIRECTLY here
   *  (it is not a UBO, so it bypasses the bind-group reflection). NOT `createCommandEncoder`
   *  — this is the narrow single-attachment integer-output path compute needs (R32UI is
   *  core color-renderable, no extension). Returns the packed-u32 per texel, row-major. */
  dispatchComputeToR32UI(pipeline: RhiPipeline, bindGroup: RhiBindGroup, wOut: number, hOut: number, uCount: Uint32Array): Uint32Array {
    const gl = this.gl
    const outTex = un<Gl2Texture>(this.createTexture({ format: 'r32uint', width: wOut, height: hOut, usage: ['render', 'copy-src'] }))
    const fbo = gl.createFramebuffer()
    if (!fbo) throw new Error('webgl2: createFramebuffer (compute) failed')
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outTex.tex, 0)
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`webgl2: compute R32UI FBO incomplete (0x${status.toString(16)})`)
    gl.viewport(0, 0, wOut, hOut)
    gl.disable(gl.BLEND) // blending is illegal on an integer attachment
    gl.clearBufferuiv(gl.COLOR, 0, new Uint32Array([0, 0, 0, 0]))
    const pass = new WebGl2RenderPass(gl)
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    const loc = gl.getUniformLocation(un<Gl2Pipeline>(pipeline).program, 'u_count')
    if (loc) gl.uniform4uiv(loc, uCount)
    pass.draw(3) // gl_VertexID fullscreen triangle — no VBO
    gl.readBuffer(gl.COLOR_ATTACHMENT0)
    const out = new Uint32Array(wOut * hOut)
    gl.readPixels(0, 0, wOut, hOut, gl.RED_INTEGER, gl.UNSIGNED_INT, out)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.deleteFramebuffer(fbo)
    gl.deleteTexture(outTex.tex)
    return out
  }
}
