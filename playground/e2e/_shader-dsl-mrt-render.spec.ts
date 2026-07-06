// ═══ shader-dsl MRT render gate: two draw buffers on real WebGL2 (#847) ═══
//
// The emit gate (shader-dsl/examples/mrt.test.ts) pins the multi-@location
// SOURCE; this proves the path on a real GPU: compile + link the module's two
// GLSL stages, draw the fullscreen triangle into TWO colour attachments via
// drawBuffers, and read each attachment back. The module's outputs are
// deterministic gradients (color0 = uv.x in red, color1 = uv.y in green), so a
// swapped, dropped, or blended attachment fails numerically.
//
// Relative imports (charter): Playwright transpiles specs in raw Node — the
// @xgis/* workspace alias does not resolve here (see _glsl-compile-gate.spec.ts).
import { test, expect } from '@playwright/test'
import { mrtGateModule } from '../../shader-dsl/examples/_mrt-gate'
import { emitGlslModule } from '../../shader-dsl/src/index'

test('MRT module draws two verifiable attachments on real WebGL2', async ({ page }) => {
  const vertex = emitGlslModule(mrtGateModule, 'vertex')
  const fragment = emitGlslModule(mrtGateModule, 'fragment')

  await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

  const r = await page.evaluate(
    ({ vertex, fragment }) => {
      const S = 64
      const canvas = document.createElement('canvas')
      canvas.width = S
      canvas.height = S
      const gl = canvas.getContext('webgl2')
      if (!gl) return { fatal: 'no webgl2 context' as const }

      const compile = (type: number, src: string) => {
        const sh = gl.createShader(type)!
        gl.shaderSource(sh, src)
        gl.compileShader(sh)
        return {
          sh,
          ok: gl.getShaderParameter(sh, gl.COMPILE_STATUS) as boolean,
          log: gl.getShaderInfoLog(sh) ?? '',
        }
      }
      const vs = compile(gl.VERTEX_SHADER, vertex)
      const fs = compile(gl.FRAGMENT_SHADER, fragment)
      const res = {
        vsOk: vs.ok,
        fsOk: fs.ok,
        vsLog: vs.log,
        fsLog: fs.log,
        linkOk: false,
        linkLog: '',
        glError: 0,
        fbComplete: false,
        att0: [0, 0, 0, 0] as number[],
        att1: [0, 0, 0, 0] as number[],
        att0RedLeft: 0,
        att0RedRight: 0,
        att1GreenBottom: 0,
        att1GreenTop: 0,
      }
      if (!vs.ok || !fs.ok) return res

      const prog = gl.createProgram()!
      gl.attachShader(prog, vs.sh)
      gl.attachShader(prog, fs.sh)
      gl.linkProgram(prog)
      res.linkOk = gl.getProgramParameter(prog, gl.LINK_STATUS) as boolean
      res.linkLog = gl.getProgramInfoLog(prog) ?? ''
      if (!res.linkOk) return res
      gl.useProgram(prog)

      // two RGBA8 colour attachments + drawBuffers
      const fbo = gl.createFramebuffer()
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      const mkTex = (attachment: number) => {
        const t = gl.createTexture()
        gl.bindTexture(gl.TEXTURE_2D, t)
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, S, S)
        gl.framebufferTexture2D(gl.FRAMEBUFFER, attachment, gl.TEXTURE_2D, t, 0)
        return t
      }
      mkTex(gl.COLOR_ATTACHMENT0)
      mkTex(gl.COLOR_ATTACHMENT1)
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1])
      res.fbComplete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
      if (!res.fbComplete) return res

      gl.bindVertexArray(gl.createVertexArray())
      gl.viewport(0, 0, S, S)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.drawArrays(gl.TRIANGLES, 0, 3)

      const read = (attachment: number, x: number, y: number) => {
        gl.readBuffer(attachment)
        const px = new Uint8Array(4)
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
        return [...px]
      }
      const mid = S / 2
      res.att0 = read(gl.COLOR_ATTACHMENT0, mid, mid)
      res.att1 = read(gl.COLOR_ATTACHMENT1, mid, mid)
      // gradient direction probes (uv origin is bottom-left in GL readback)
      res.att0RedLeft = read(gl.COLOR_ATTACHMENT0, 4, mid)[0]
      res.att0RedRight = read(gl.COLOR_ATTACHMENT0, S - 4, mid)[0]
      res.att1GreenBottom = read(gl.COLOR_ATTACHMENT1, mid, 4)[1]
      res.att1GreenTop = read(gl.COLOR_ATTACHMENT1, mid, S - 4)[1]
      const err = gl.getError()
      res.glError = err === 0 ? 0 : err
      return res
    },
    { vertex, fragment },
  )

  expect(r, 'WebGL2 unavailable in the test browser').not.toHaveProperty('fatal')
  if ('fatal' in r) return
  expect(r.vsOk, `vertex shader failed:\n${r.vsLog}\n--- GLSL ---\n${vertex}`).toBe(true)
  expect(r.fsOk, `fragment shader failed:\n${r.fsLog}\n--- GLSL ---\n${fragment}`).toBe(true)
  expect(r.linkOk, `link failed:\n${r.linkLog}`).toBe(true)
  expect(r.fbComplete, 'two-attachment framebuffer incomplete').toBe(true)
  expect(r.glError, 'a GL error was raised during draw/readback').toBe(0)

  const near = (got: number, want: number) => Math.abs(got - want) <= 8
  // attachment 0: (uv.x, 0.25, 0, 1) — centre ≈ (128, 64, 0, 255)
  expect(near(r.att0[0], 128), `att0 centre red = ${r.att0[0]}`).toBe(true)
  expect(near(r.att0[1], 64), `att0 centre green = ${r.att0[1]}`).toBe(true)
  expect(near(r.att0[2], 0), `att0 centre blue = ${r.att0[2]}`).toBe(true)
  // attachment 1: (0, uv.y, 0.75, 1) — centre ≈ (0, 128, 191, 255)
  expect(near(r.att1[0], 0), `att1 centre red = ${r.att1[0]}`).toBe(true)
  expect(near(r.att1[1], 128), `att1 centre green = ${r.att1[1]}`).toBe(true)
  expect(near(r.att1[2], 191), `att1 centre blue = ${r.att1[2]}`).toBe(true)
  // gradients run the right way (rules out swapped/mirrored attachments)
  expect(r.att0RedRight, 'att0 red must increase with x').toBeGreaterThan(r.att0RedLeft + 100)
  expect(r.att1GreenTop, 'att1 green must increase with y').toBeGreaterThan(r.att1GreenBottom + 100)
})
