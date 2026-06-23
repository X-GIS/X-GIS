// ═══ shader-dsl examples render gate: every renderable example draws on real WebGL2 ═══
//
// The /shader-dsl site page renders these example modules live, so each must not just emit
// well-formed GLSL but actually COMPILE + LINK + DRAW a non-blank, varying frame on a real
// WebGL2 context — packing the std140 UBO straight from reflect(). This is the real-GPU
// sibling of the unit emit-gate (shader-dsl/examples/examples.test.ts).
//
// Relative imports (NOT the `@xgis/shader-dsl` alias): Playwright transpiles specs in raw
// Node, which doesn't resolve the workspace alias — same as _glsl-compile-gate.spec.ts.
import { test, expect } from '@playwright/test'
import { examples } from '../../shader-dsl/examples/index'
import { emitGlslModule, reflect } from '../../shader-dsl/src/index'

const renderable = examples.filter((e) => e.renderable)

test.describe('shader-dsl examples render on real WebGL2', () => {
  for (const ex of renderable) {
    test(`${ex.id} compiles + links + renders a non-blank, varying frame`, async ({ page }) => {
      const vertex = emitGlslModule(ex.module, 'vertex')
      const fragment = emitGlslModule(ex.module, 'fragment')
      const reflection = reflect(ex.module)
      const controls = ex.controls ?? {}

      await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

      const r = await page.evaluate(({ vertex, fragment, reflection, controls }) => {
        const canvas = document.createElement('canvas')
        canvas.width = 128; canvas.height = 128
        const gl = canvas.getContext('webgl2')
        if (!gl) return { fatal: 'no webgl2 context' as const }

        const compile = (type: number, src: string) => {
          const sh = gl.createShader(type)!
          gl.shaderSource(sh, src); gl.compileShader(sh)
          return { sh, ok: gl.getShaderParameter(sh, gl.COMPILE_STATUS) as boolean, log: gl.getShaderInfoLog(sh) ?? '' }
        }
        const vs = compile(gl.VERTEX_SHADER, vertex)
        const fs = compile(gl.FRAGMENT_SHADER, fragment)
        const res = { vsOk: vs.ok, fsOk: fs.ok, vsLog: vs.log, fsLog: fs.log, linkOk: false, linkLog: '', nonBlank: false, distinct: 0, glError: 0 }
        if (!vs.ok || !fs.ok) return res

        const prog = gl.createProgram()!
        gl.attachShader(prog, vs.sh); gl.attachShader(prog, fs.sh); gl.linkProgram(prog)
        res.linkOk = gl.getProgramParameter(prog, gl.LINK_STATUS) as boolean
        res.linkLog = gl.getProgramInfoLog(prog) ?? ''
        if (!res.linkOk) return res
        gl.useProgram(prog)

        // Pack the std140 UBO from reflection + default control values — the same
        // reflection-driven packing the site uses.
        const u = (reflection as { uniforms: Array<{ name: string; size: number; fields: Array<{ name: string; offset: number }> }> }).uniforms[0]
        if (u) {
          const buf = new ArrayBuffer(Math.ceil(u.size / 16) * 16)
          const f32 = new Float32Array(buf)
          for (const field of u.fields) {
            const c = (controls as Record<string, { kind: string; value?: number | number[] }>)[field.name]
            let v: number[] = [0]
            if (c?.kind === 'time') v = [1.0]
            else if (c?.kind === 'resolution') v = [128, 128]
            else if (c?.kind === 'slider') v = [c.value as number]
            else if (c?.kind === 'const') v = c.value as number[]
            for (let i = 0; i < v.length; i++) f32[field.offset / 4 + i] = v[i]
          }
          const ubo = gl.createBuffer()
          gl.bindBuffer(gl.UNIFORM_BUFFER, ubo)
          gl.bufferData(gl.UNIFORM_BUFFER, buf, gl.STATIC_DRAW)
          const blockIdx = gl.getUniformBlockIndex(prog, u.name)
          if (blockIdx !== 0xFFFFFFFF) {
            gl.uniformBlockBinding(prog, blockIdx, 0)
            gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, ubo)
          }
        }

        gl.bindVertexArray(gl.createVertexArray())
        gl.viewport(0, 0, 128, 128)
        gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT)
        gl.drawArrays(gl.TRIANGLES, 0, 3)

        const px = new Uint8Array(128 * 128 * 4)
        gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, px)
        const seen = new Set<string>()
        let nonBlack = 0
        for (let i = 0; i < px.length; i += 4 * 137) {
          seen.add(`${px[i] >> 3},${px[i + 1] >> 3},${px[i + 2] >> 3}`)
          if (px[i] + px[i + 1] + px[i + 2] > 12) nonBlack++
        }
        res.distinct = seen.size
        res.nonBlank = nonBlack > 0
        const err = gl.getError()
        res.glError = err === 0 ? 0 : err
        return res
      }, { vertex, fragment, reflection, controls })

      expect(r, 'WebGL2 unavailable in the test browser').not.toHaveProperty('fatal')
      if ('fatal' in r) return
      expect(r.vsOk, `vertex shader failed:\n${r.vsLog}\n--- GLSL ---\n${vertex}`).toBe(true)
      expect(r.fsOk, `fragment shader failed:\n${r.fsLog}\n--- GLSL ---\n${fragment}`).toBe(true)
      expect(r.linkOk, `link failed:\n${r.linkLog}`).toBe(true)
      expect(r.glError, 'a GL error was raised during draw').toBe(0)
      expect(r.nonBlank, 'rendered frame is blank').toBe(true)
      expect(r.distinct, 'rendered frame is a flat fill (expected variation)').toBeGreaterThan(1)
    })
  }
})
