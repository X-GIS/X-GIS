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
  | { kind: 'const'; value: number[] }
  | { kind: 'slider'; label: string; min: number; max: number; step: number; value: number }

export interface ReflField { name: string; offset: number }
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

export interface Mounted { destroy(): void }

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
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog)
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
    if (idx !== 0xFFFFFFFF) {
      gl.uniformBlockBinding(prog, idx, 0)
      gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, ubo)
    }
  }

  const vao = gl.createVertexArray()
  gl.bindVertexArray(vao)

  const start = performance.now()
  let raf = 0
  let visible = true
  // Respect prefers-reduced-motion: freeze the `time` uniform so nothing animates,
  // while sliders + resolution stay live. (Re-evaluated each frame so an OS toggle applies.)
  const reduceMotion = (): boolean =>
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

  const resize = (): void => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr))
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr))
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h }
  }

  const packUniforms = (): void => {
    if (!block || !f32) return
    const tSec = reduceMotion() ? 3 : (performance.now() - start) / 1000
    for (const field of block.fields) {
      const c = spec.controls[field.name]
      let v: number[]
      if (!c) v = [0]
      else if (c.kind === 'time') v = [tSec]
      else if (c.kind === 'resolution') v = [canvas.width, canvas.height]
      else if (c.kind === 'slider') v = [sliders[field.name] ?? c.value]
      else v = c.value
      for (let i = 0; i < v.length; i++) f32[field.offset / 4 + i] = v[i]
    }
    gl.bindBuffer(gl.UNIFORM_BUFFER, ubo)
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, f32)
  }

  const frame = (): void => {
    raf = requestAnimationFrame(frame)
    if (!visible) return
    resize()
    packUniforms()
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  // Pause the loop while the canvas is scrolled out of view (battery / mobile).
  const io = new IntersectionObserver((entries) => { visible = entries[0]?.isIntersecting ?? true }, { threshold: 0 })
  io.observe(canvas)

  const onLost = (e: Event): void => { e.preventDefault(); cancelAnimationFrame(raf) }
  canvas.addEventListener('webglcontextlost', onLost, false)

  raf = requestAnimationFrame(frame)

  return {
    destroy(): void {
      cancelAnimationFrame(raf)
      io.disconnect()
      canvas.removeEventListener('webglcontextlost', onLost)
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    },
  }
}
