// ═══ Shader DSL playground — a dependency-free WebGL2 + WebGPU renderer ═══
//
// The /shader-dsl page emits each example's GLSL ES 3.00 + WGSL + std140 reflection at
// BUILD time (in the Astro frontmatter, via @xgis/shader-dsl) and ships only the strings
// here. This runtime compiles + draws a fullscreen-triangle pass on EITHER backend, packing
// the uniform block straight from the reflection — the SAME reflection-driven packing the
// unit/e2e gates use — and reads live values (time, canvas size, sliders) each frame. No
// shader-dsl on the client. The two backends share one input/state layer (createInputState)
// and differ only in compile + upload + draw, so the WebGL2 ⟷ WebGPU toggle is a live A/B of
// the SAME source — which matters for fp64, where a driver's fast-math (Apple Metal via both
// APIs; ANGLE/fxc on WebGL2 vs Dawn on WebGPU) decides whether the df64 error terms survive.

export type Control =
  | { kind: 'time' }
  | { kind: 'resolution' }
  // Pointer state → vec4 [x, y, down, used]: x/y in device pixels (bottom-left
  // origin, matching uv), down = button/touch held, used = 1 once the pointer
  // has ever entered — the shader's autopilot flag. Mirrors examples/_shared.ts.
  | { kind: 'mouse' }
  | { kind: 'const'; value: number[] }
  | {
      kind: 'slider'
      label: string
      min: number
      max: number
      step: number
      value: number
      wheel?: boolean // page also drives this slider from wheel over the canvas
    }
  // On/off switch → f32 1/0. Live state rides the same SliderValues record the
  // sliders use (the page writes 1/0 under the field name). Mirrors _shared.ts.
  | { kind: 'toggle'; label: string; value: boolean }
  // Drag-to-pan camera → a vec2<f64> uniform (DF64Vec2 hi/lo planes). The
  // camera center accumulates drags in FULL JS-double precision here and is
  // split into [hi.x, hi.y, lo.x, lo.y] each frame — the host-side half of the
  // fp64 story. Drag scale: unitsPerWidth × 10^(−zoomExpField's live value)
  // per full canvas width. Mirrors _shared.ts.
  | { kind: 'pan2d'; value: [number, number]; zoomExpField: string; unitsPerWidth: number }
  // Log-magnitude sweep → a vec2<f64> uniform: `base·10^s + offset` for s = the
  // live `magField` slider, packed as a DF64Vec2 host-side. Sweeping s walks the
  // world coordinate through the ~2^24 f32 precision threshold, so the f32 half
  // visibly collapses at a point the viewer controls while the f64 half holds.
  | { kind: 'logmag2d'; magField: string; base: [number, number]; offset: [number, number] }
  // Scalar twin of logmag2d → a SCALAR f64 uniform (`base·10^s + offset`).
  | { kind: 'logmag1d'; magField: string; base: number; offset: number }

export interface ReflField {
  name: string
  offset: number
}
export interface RenderSpec {
  id: string
  vertex: string
  fragment: string
  /** The single WGSL module (both entry points) — the WebGPU backend path. */
  wgsl: string
  /** reflect(module) — only the first uniform block is bound (the examples use one). */
  reflection: { uniforms: Array<{ name: string; size: number; fields: ReflField[] }> }
  controls: Record<string, Control>
}

export type Backend = 'webgl2' | 'webgpu'

/** Live slider values, keyed by uniform-field name. The page mutates this; the loop reads it. */
export type SliderValues = Record<string, number>

export interface Mounted {
  destroy(): void
  /** Pause/resume the shader clock (rendering keeps running so sliders,
   *  resize, and pointer input stay live on the frozen frame). */
  setPlaying(playing: boolean): void
  /** Shader-clock rate multiplier (1 = real time). */
  setSpeed(speed: number): void
  /** Jump the shader clock to `t` seconds. */
  setTime(t: number): void
  getTime(): number
  isPlaying(): boolean
  /** Restore every pan2d camera to its declared default center. */
  resetCamera(): void
}

/** Is a WebGPU device reachable in this browser? (async — probes an adapter). */
export async function webgpuAvailable(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator)) return false
  try {
    return (await navigator.gpu.requestAdapter()) != null
  } catch {
    return false
  }
}

// ── Shared input + uniform-packing state (backend-agnostic) ─────────────────

interface InputState {
  readonly block: { name: string; size: number; fields: ReflField[] } | undefined
  /** Padded uniform bytes (0 when the example has no uniform block). */
  readonly byteLength: number
  /** Advance the clock, poll visibility/resize, and repack the uniforms.
   *  Returns whether a redraw is needed this frame (draw-on-demand). */
  beginFrame(now: number): { draw: boolean; resized: boolean }
  /** The packed uniform bytes for this frame (upload target). */
  readonly data: Float32Array | null
  markForceDraw(): void
  readonly mounted: Mounted // control methods + destroy (destroy tears down input listeners)
}

function createInputState(
  canvas: HTMLCanvasElement,
  spec: RenderSpec,
  sliders: SliderValues,
  onDestroy: () => void,
): InputState {
  const block = spec.reflection.uniforms[0]
  const byteLength = block ? Math.ceil(block.size / 16) * 16 : 0
  const data = byteLength ? new Float32Array(byteLength / 4) : null
  const prevU = data ? new Float32Array(data.length) : null

  let timeSec = 0
  let speed = 1
  let playing = true
  let visible = true
  let hasDrawn = false
  let forceDraw = true
  let settleAt = 0

  const reduceMotion = (): boolean =>
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

  // Pointer state for {kind:'mouse'}: [x, y, down, used] in device px, bottom-left origin.
  const mouse = [0, 0, 0, 0]
  const toCanvasXY = (e: PointerEvent): void => {
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    mouse[0] = ((e.clientX - rect.left) / rect.width) * canvas.width
    mouse[1] = (1 - (e.clientY - rect.top) / rect.height) * canvas.height
    mouse[3] = 1
  }
  const onPointerMove = (e: PointerEvent): void => toCanvasXY(e)
  const onPointerDown = (e: PointerEvent): void => {
    mouse[2] = 1
    toCanvasXY(e)
    canvas.setPointerCapture(e.pointerId)
  }
  const onPointerUp = (): void => {
    mouse[2] = 0
  }
  const hasMouse = Object.values(spec.controls).some((c) => c.kind === 'mouse')
  if (hasMouse) {
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerUp)
  }

  // pan2d cameras: per-field [x, y] centers held as FULL JS doubles.
  const cameras: Record<string, [number, number]> = {}
  const pan2ds = Object.entries(spec.controls).filter(
    (e): e is [string, Extract<Control, { kind: 'pan2d' }>] => e[1].kind === 'pan2d',
  )
  for (const [field, c] of pan2ds) cameras[field] = [c.value[0], c.value[1]]
  let dragging = false
  let dragX = 0
  let dragY = 0
  const onPanDown = (e: PointerEvent): void => {
    dragging = true
    dragX = e.clientX
    dragY = e.clientY
    canvas.setPointerCapture(e.pointerId)
    canvas.style.cursor = 'grabbing'
  }
  const onPanMove = (e: PointerEvent): void => {
    if (!dragging) return
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0) return
    const pxPerClient = canvas.width / rect.width
    const dxPx = (e.clientX - dragX) * pxPerClient
    const dyPx = (e.clientY - dragY) * pxPerClient
    dragX = e.clientX
    dragY = e.clientY
    for (const [field, c] of pan2ds) {
      const zoomCtl = spec.controls[c.zoomExpField]
      const zoomDefault = zoomCtl && zoomCtl.kind === 'slider' ? zoomCtl.value : 0
      const unitsPerPx =
        (c.unitsPerWidth * Math.pow(10, -(sliders[c.zoomExpField] ?? zoomDefault))) / canvas.width
      const cam = cameras[field]
      cam[0] -= dxPx * unitsPerPx
      cam[1] += dyPx * unitsPerPx
    }
  }
  const onPanUp = (): void => {
    dragging = false
    canvas.style.cursor = 'grab'
  }
  if (pan2ds.length > 0) {
    canvas.style.cursor = 'grab'
    canvas.addEventListener('pointerdown', onPanDown)
    canvas.addEventListener('pointermove', onPanMove)
    canvas.addEventListener('pointerup', onPanUp)
    canvas.addEventListener('pointercancel', onPanUp)
  }

  const fr = Math.fround
  const df64 = (x: number): [number, number] => [fr(x), fr(x - fr(x))]

  const resize = (): boolean => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr))
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr))
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
      return true
    }
    return false
  }

  /** Pack the uniforms; return true when the bytes changed since last frame. */
  const pack = (): boolean => {
    if (!block || !data || !prevU) return false
    const tSec = reduceMotion() ? 3 : timeSec
    for (const field of block.fields) {
      const c = spec.controls[field.name]
      let v: number[]
      if (!c) v = [0]
      else if (c.kind === 'time') v = [tSec]
      else if (c.kind === 'resolution') v = [canvas.width, canvas.height]
      else if (c.kind === 'mouse') v = mouse
      else if (c.kind === 'slider') v = [sliders[field.name] ?? c.value]
      else if (c.kind === 'toggle') v = [sliders[field.name] ?? (c.value ? 1 : 0)]
      else if (c.kind === 'pan2d') {
        const cam = cameras[field.name]
        const [hx, lx] = df64(cam[0])
        const [hy, ly] = df64(cam[1])
        v = [hx, hy, lx, ly]
      } else if (c.kind === 'logmag2d') {
        const m = Math.pow(10, sliders[c.magField] ?? 0)
        const [hx, lx] = df64(c.base[0] * m + c.offset[0])
        const [hy, ly] = df64(c.base[1] * m + c.offset[1])
        v = [hx, hy, lx, ly]
      } else if (c.kind === 'logmag1d') {
        v = df64(c.base * Math.pow(10, sliders[c.magField] ?? 0) + c.offset)
      } else v = c.value
      for (let i = 0; i < v.length; i++) data[field.offset / 4 + i] = v[i]
    }
    let changed = false
    for (let i = 0; i < data.length; i++) {
      if (data[i] !== prevU[i]) {
        changed = true
        break
      }
    }
    if (changed) prevU.set(data)
    return changed
  }

  const io = new IntersectionObserver(
    (entries) => {
      const nowVisible = entries[0]?.isIntersecting ?? true
      if (nowVisible && !visible) forceDraw = true
      visible = nowVisible
    },
    { threshold: 0 },
  )
  io.observe(canvas)
  const onVisibility = (): void => {
    if (!document.hidden) forceDraw = true
  }
  document.addEventListener('visibilitychange', onVisibility)

  let lastNow = performance.now()
  const beginFrame = (now: number): { draw: boolean; resized: boolean } => {
    if (playing) timeSec += ((now - lastNow) / 1000) * speed
    lastNow = now
    if (!visible) return { draw: false, resized: false }
    const resized = resize()
    const changed = pack()
    const settle = settleAt !== 0 && now >= settleAt
    const draw = !hasDrawn || changed || resized || forceDraw || settle
    if (draw) {
      settleAt = changed || resized ? now + 300 : 0
      forceDraw = false
      hasDrawn = true
    }
    return { draw, resized }
  }

  const mounted: Mounted = {
    destroy(): void {
      io.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      if (hasMouse) {
        canvas.removeEventListener('pointermove', onPointerMove)
        canvas.removeEventListener('pointerdown', onPointerDown)
        canvas.removeEventListener('pointerup', onPointerUp)
        canvas.removeEventListener('pointercancel', onPointerUp)
      }
      if (pan2ds.length > 0) {
        canvas.removeEventListener('pointerdown', onPanDown)
        canvas.removeEventListener('pointermove', onPanMove)
        canvas.removeEventListener('pointerup', onPanUp)
        canvas.removeEventListener('pointercancel', onPanUp)
      }
      onDestroy()
    },
    setPlaying(p: boolean): void {
      playing = p
      lastNow = performance.now()
    },
    setSpeed(s: number): void {
      speed = s
    },
    setTime(t: number): void {
      timeSec = t
      lastNow = performance.now()
    },
    getTime(): number {
      return timeSec
    },
    isPlaying(): boolean {
      return playing
    },
    resetCamera(): void {
      for (const [field, c] of pan2ds) cameras[field] = [c.value[0], c.value[1]]
    },
  }

  return { block, byteLength, beginFrame, data, markForceDraw: () => (forceDraw = true), mounted }
}

// ── WebGL2 backend ──────────────────────────────────────────────────────────

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) ?? ''
    gl.deleteShader(sh)
    throw new Error(log || 'shader compile failed')
  }
  return sh
}

/** Mount on WebGL2. Throws synchronously if WebGL2 / compilation is unavailable. */
export function mountShader(
  canvas: HTMLCanvasElement,
  spec: RenderSpec,
  sliders: SliderValues,
): Mounted {
  const gl = canvas.getContext('webgl2', { antialias: true, premultipliedAlpha: false })
  if (!gl) throw new Error('WebGL2 is not supported in this browser.')

  const vs = compileShader(gl, gl.VERTEX_SHADER, spec.vertex)
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, spec.fragment)
  const prog = gl.createProgram()!
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(prog) || 'program link failed')
  }
  gl.useProgram(prog)

  let raf = 0
  const state = createInputState(canvas, spec, sliders, () => {
    cancelAnimationFrame(raf)
    canvas.removeEventListener('webglcontextlost', onLost)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  })

  const block = state.block
  let ubo: WebGLBuffer | null = null
  if (block && state.data) {
    ubo = gl.createBuffer()
    gl.bindBuffer(gl.UNIFORM_BUFFER, ubo)
    gl.bufferData(gl.UNIFORM_BUFFER, state.byteLength, gl.DYNAMIC_DRAW)
    const idx = gl.getUniformBlockIndex(prog, block.name)
    if (idx !== 0xffffffff) {
      gl.uniformBlockBinding(prog, idx, 0)
      gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, ubo)
    }
  }

  // fp64 anti-fast-math guard: a 1×1 texture bound as `_fp64`, texel 1.0.
  const guardLoc = gl.getUniformLocation(prog, '_fp64')
  if (guardLoc) {
    const gtex = gl.createTexture()
    gl.activeTexture(gl.TEXTURE7)
    gl.bindTexture(gl.TEXTURE_2D, gtex)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([255, 255, 255, 255]),
    )
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.uniform1i(guardLoc, 7)
    gl.activeTexture(gl.TEXTURE0)
  }

  gl.bindVertexArray(gl.createVertexArray())

  const onLost = (e: Event): void => {
    e.preventDefault()
    cancelAnimationFrame(raf)
  }
  canvas.addEventListener('webglcontextlost', onLost, false)

  const frame = (): void => {
    raf = requestAnimationFrame(frame)
    const { draw } = state.beginFrame(performance.now())
    if (!draw) return
    if (ubo && state.data) {
      gl.bindBuffer(gl.UNIFORM_BUFFER, ubo)
      gl.bufferSubData(gl.UNIFORM_BUFFER, 0, state.data)
    }
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }
  raf = requestAnimationFrame(frame)
  return state.mounted
}

// ── WebGPU backend ──────────────────────────────────────────────────────────

const wgslEntry = (src: string, tag: 'vertex' | 'fragment'): string => {
  const m = src.match(new RegExp(`@${tag}\\s+fn\\s+([A-Za-z_]\\w*)`))
  if (!m) throw new Error(`WGSL has no @${tag} entry point`)
  return m[1]
}
const wgslBinding = (src: string, decl: RegExp): number | null => {
  const m = src.match(decl)
  return m ? Number(m[1]) : null
}

/** Mount on WebGPU. Async (device + pipeline creation). Rejects if WebGPU is
 *  unavailable or the module fails to compile — the caller shows the error. */
export async function mountShaderWebGPU(
  canvas: HTMLCanvasElement,
  spec: RenderSpec,
  sliders: SliderValues,
): Promise<Mounted> {
  if (typeof navigator === 'undefined' || !('gpu' in navigator))
    throw new Error('WebGPU is not supported in this browser.')
  const adapter = await navigator.gpu.requestAdapter()
  if (!adapter) throw new Error('No WebGPU adapter available.')
  const device = await adapter.requestDevice()
  const ctx = canvas.getContext('webgpu')
  if (!ctx) throw new Error('Could not get a WebGPU canvas context.')
  const format = navigator.gpu.getPreferredCanvasFormat()
  ctx.configure({ device, format, alphaMode: 'opaque' })

  // Surface a shader compile error as a thrown Error (the caller shows it).
  device.pushErrorScope('validation')
  const shaderModule = device.createShaderModule({ code: spec.wgsl })
  const info = await shaderModule.getCompilationInfo()
  const err = info.messages.find((m) => m.type === 'error')
  if (err) {
    void device.popErrorScope()
    throw new Error(`WGSL: ${err.message}`)
  }

  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: shaderModule, entryPoint: wgslEntry(spec.wgsl, 'vertex') },
    fragment: {
      module: shaderModule,
      entryPoint: wgslEntry(spec.wgsl, 'fragment'),
      targets: [{ format }],
    },
    primitive: { topology: 'triangle-list' },
  })
  const pipeErr = await device.popErrorScope()
  if (pipeErr) throw new Error(`WebGPU pipeline: ${pipeErr.message}`)

  let raf = 0
  let destroyed = false
  const state = createInputState(canvas, spec, sliders, () => {
    destroyed = true
    cancelAnimationFrame(raf)
    device.destroy()
  })

  // Uniform buffer (std140 layout from reflection — the DSL's WGSL uses the same
  // offsets) + the fp64 guard texture, both in bind group 0.
  const uniBinding = wgslBinding(spec.wgsl, /@binding\((\d+)\)\s*var<uniform>/)
  const uniBuf =
    state.byteLength && uniBinding != null
      ? device.createBuffer({
          size: state.byteLength,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })
      : null

  const guardBinding = wgslBinding(spec.wgsl, /@binding\((\d+)\)\s*var\s+_fp64/)
  let guardView: GPUTextureView | null = null
  if (guardBinding != null) {
    const tex = device.createTexture({
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    device.queue.writeTexture({ texture: tex }, new Uint8Array([255, 255, 255, 255]), {}, [1, 1])
    guardView = tex.createView()
  }

  const entries: GPUBindGroupEntry[] = []
  if (uniBuf && uniBinding != null)
    entries.push({ binding: uniBinding, resource: { buffer: uniBuf } })
  if (guardView && guardBinding != null)
    entries.push({ binding: guardBinding, resource: guardView })
  const bindGroup =
    entries.length > 0
      ? device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries })
      : null

  const frame = (): void => {
    if (destroyed) return
    raf = requestAnimationFrame(frame)
    const { draw } = state.beginFrame(performance.now())
    if (!draw) return
    if (uniBuf && state.data) device.queue.writeBuffer(uniBuf, 0, state.data)
    const encoder = device.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: ctx.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    })
    pass.setPipeline(pipeline)
    if (bindGroup) pass.setBindGroup(0, bindGroup)
    pass.draw(3)
    pass.end()
    device.queue.submit([encoder.finish()])
  }
  raf = requestAnimationFrame(frame)
  return state.mounted
}
