// ═══ Shader DSL playground — a dependency-free WebGL2 renderer ═══
//
// The /shader-dsl page emits each example's GLSL ES 3.00 + std140 reflection at BUILD time
// (in the Astro frontmatter, via @xgis/shader-dsl) and ships only the strings here. This
// runtime compiles + draws a fullscreen-triangle pass, packing the uniform block straight
// from the reflection — the SAME reflection-driven packing the unit/e2e gates use — and
// reads live values (time, canvas size, sliders) each frame. No shader-dsl on the client.

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

export interface ReflField {
  name: string
  offset: number
}
export interface RenderSpec {
  id: string
  vertex: string
  fragment: string
  /** reflect(module) — only the first uniform block is bound (the examples use one). */
  reflection: { uniforms: Array<{ name: string; size: number; fields: ReflField[] }> }
  controls: Record<string, Control>
}

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

/** Mount a shader on a canvas. Animates via rAF, pauses when offscreen, reads sliders live.
 *  Throws synchronously if WebGL2 / compilation is unavailable — the caller shows the error. */
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

  // One std140 uniform block, packed from reflection.
  const block = spec.reflection.uniforms[0]
  const buf = block ? new ArrayBuffer(Math.ceil(block.size / 16) * 16) : null
  const f32 = buf ? new Float32Array(buf) : null
  let ubo: WebGLBuffer | null = null
  if (block && buf) {
    ubo = gl.createBuffer()
    gl.bindBuffer(gl.UNIFORM_BUFFER, ubo)
    gl.bufferData(gl.UNIFORM_BUFFER, buf.byteLength, gl.DYNAMIC_DRAW)
    const idx = gl.getUniformBlockIndex(prog, block.name)
    if (idx !== 0xffffffff) {
      gl.uniformBlockBinding(prog, idx, 0)
      gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, ubo)
    }
  }

  // The fp64 anti-fast-math guard (a 1×1 texture bound as `_fp64`, texel 1.0)
  // is injected at LOWERING, so it never appears in the authored reflection —
  // probe the linked program instead. A texture, not a uniform: some drivers
  // specialize pipelines on observed uniform values and hot-swap re-optimized
  // variants that fold the df64 error terms; texel values stay opaque.
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

  const vao = gl.createVertexArray()
  gl.bindVertexArray(vao)

  // Controllable shader clock: accumulates real time × speed while playing.
  // The render loop itself never pauses (sliders / resize / pointer stay live).
  let timeSec = 0
  let speed = 1
  let playing = true
  let lastNow = performance.now()
  let raf = 0
  let visible = true
  // Respect prefers-reduced-motion: freeze the `time` uniform so nothing animates,
  // while sliders + resolution stay live. (Re-evaluated each frame so an OS toggle applies.)
  const reduceMotion = (): boolean =>
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

  // Pointer state for {kind:'mouse'} controls: [x, y, down, used] in device px,
  // bottom-left origin (divides straight into uv space). Updated on hover as
  // well as drag; `used` flips to 1 on first entry and stays.
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

  // pan2d cameras: per-field [x, y] centers held as FULL JS doubles — the
  // drag deltas below can be ~1e-13 while the center is ~1, exactly the
  // regime the DF64Vec2 split preserves and plain f32 cannot.
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
      const unitsPerPx = (c.unitsPerWidth * Math.pow(10, -(sliders[c.zoomExpField] ?? zoomDefault))) / canvas.width
      const cam = cameras[field]
      // Grab semantics: content follows the cursor. Screen y is down, uv y is
      // up, so a downward drag moves the center UP the complex plane.
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

  // splitF64: lossless double → (hi, lo) f32 pair (hi = fround(x), lo = the
  // f32-rounded remainder) — the same packing shader-dsl's splitF64 export does.
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

  // Draw-on-demand: skip the draw entirely when nothing changed since the last
  // frame. Every live input (clock, sliders, toggles, pointer, camera, canvas
  // size) flows through the uniform buffer, so "the packed bytes are
  // identical" IS "the frame would be identical" — and a frame that is not
  // re-drawn cannot flicker, whatever the driver does with the shader between
  // draws (some drivers hot-swap re-optimized shader variants; an fp64 EFT
  // that survives one variant and not another otherwise alternates at rest).
  // Static examples also stop burning GPU while idle.
  const prevU = f32 ? new Float32Array(f32.length) : null
  let hasDrawn = false
  let forceDraw = true
  // One extra draw shortly after the inputs settle: on drivers that hot-swap
  // re-optimized shader variants mid-interaction, the LAST interactive frame
  // can land on a bad variant and would otherwise freeze on screen — the
  // settle draw gives the final frame a second chance on the settled pipeline.
  let settleAt = 0

  /** Pack the uniforms; upload and report true only when the bytes changed. */
  const packUniforms = (): boolean => {
    if (!block || !f32 || !prevU) return false
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
        // DF64Vec2 std140 planes: [hi.x, hi.y, lo.x, lo.y]
        const cam = cameras[field.name]
        const [hx, lx] = df64(cam[0])
        const [hy, ly] = df64(cam[1])
        v = [hx, hy, lx, ly]
      } else v = c.value
      for (let i = 0; i < v.length; i++) f32[field.offset / 4 + i] = v[i]
    }
    let changed = false
    for (let i = 0; i < f32.length; i++) {
      if (f32[i] !== prevU[i]) {
        changed = true
        break
      }
    }
    if (!changed) return false
    prevU.set(f32)
    gl.bindBuffer(gl.UNIFORM_BUFFER, ubo)
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, f32)
    return true
  }

  const frame = (): void => {
    raf = requestAnimationFrame(frame)
    const now = performance.now()
    if (playing) timeSec += ((now - lastNow) / 1000) * speed
    lastNow = now
    if (!visible) return
    const resized = resize()
    const changed = packUniforms()
    const settle = settleAt !== 0 && now >= settleAt
    if (hasDrawn && !changed && !resized && !forceDraw && !settle) return
    settleAt = changed || resized ? now + 300 : 0
    forceDraw = false
    hasDrawn = true
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  // Pause the loop while the canvas is scrolled out of view (battery / mobile).
  // Regaining visibility (or the tab) forces one draw — the compositor's
  // retained copy of a non-preserved drawing buffer can be dropped while
  // hidden, and a skipped-draw canvas would otherwise stay blank.
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

  const onLost = (e: Event): void => {
    e.preventDefault()
    cancelAnimationFrame(raf)
  }
  canvas.addEventListener('webglcontextlost', onLost, false)

  raf = requestAnimationFrame(frame)

  return {
    destroy(): void {
      cancelAnimationFrame(raf)
      io.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      canvas.removeEventListener('webglcontextlost', onLost)
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
      gl.getExtension('WEBGL_lose_context')?.loseContext()
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
}
