// ═══ shader-dsl mouse-control gate: pointer input visibly changes the frame ═══
//
// Examples declaring a `{ kind: 'mouse' }` control promise two things:
//   1. untouched (mouse = [0,0,0,0], used = 0) they render their canonical
//      autopilot view — what thumbnails, the examples render gate, and
//      reduced-motion users see;
//   2. an active pointer (used = 1) produces a VISIBLY different frame.
// This gate renders each mouse example twice on real WebGL2 — identical except
// for the mouse uniform — and asserts the frames differ. A control that packs
// nothing (typo'd field, dead m.w multiply) fails here, not in a user's hand.
//
// Relative imports (charter): Playwright transpiles specs in raw Node — the
// @xgis/* workspace alias does not resolve here (see _glsl-compile-gate.spec.ts).
import { test, expect } from '@playwright/test'
import { examples } from '../../shader-dsl/examples/index'
import { emitGlslModule, reflect } from '../../shader-dsl/src/index'

const mouseExamples = examples.filter(
  (e) => e.renderable && Object.values(e.controls ?? {}).some((c) => c.kind === 'mouse'),
)

test.describe('shader-dsl mouse controls change the frame', () => {
  test('at least the four interactive examples declare a mouse control', () => {
    expect(mouseExamples.length).toBeGreaterThanOrEqual(4)
  })

  for (const ex of mouseExamples) {
    test(`${ex.id}: active pointer produces a different frame`, async ({ page }) => {
      const vertex = emitGlslModule(ex.module, 'vertex')
      const fragment = emitGlslModule(ex.module, 'fragment')
      const reflection = reflect(ex.module)
      const controls = ex.controls ?? {}

      await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

      const r = await page.evaluate(
        ({ vertex, fragment, reflection, controls }) => {
          const S = 128
          const canvas = document.createElement('canvas')
          canvas.width = S
          canvas.height = S
          const gl = canvas.getContext('webgl2')
          if (!gl) return { fatal: 'no webgl2 context' as const }
          const compile = (type: number, src: string) => {
            const sh = gl.createShader(type)!
            gl.shaderSource(sh, src)
            gl.compileShader(sh)
            if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
              throw new Error(gl.getShaderInfoLog(sh) ?? 'compile failed')
            return sh
          }
          const prog = gl.createProgram()!
          gl.attachShader(prog, compile(gl.VERTEX_SHADER, vertex))
          gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fragment))
          gl.linkProgram(prog)
          if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
            throw new Error(gl.getProgramInfoLog(prog) ?? 'link failed')
          gl.useProgram(prog)

          // fp64 examples: the lowering auto-injects the `_fp64` guard uniform
          // (absent from the authored reflect()) — probe for its block and bind
          // 1.0f, same pattern as the site/thumbnail/render-gate harnesses.
          const gIdx = gl.getUniformBlockIndex(prog, 'Fp64Guard')
          if (gIdx !== 0xffffffff) {
            const gbuf = gl.createBuffer()
            gl.bindBuffer(gl.UNIFORM_BUFFER, gbuf)
            gl.bufferData(gl.UNIFORM_BUFFER, new Float32Array([1, 0, 0, 0]), gl.STATIC_DRAW)
            gl.uniformBlockBinding(prog, gIdx, 1)
            gl.bindBufferBase(gl.UNIFORM_BUFFER, 1, gbuf)
          }

          const u = (
            reflection as {
              uniforms: Array<{
                name: string
                size: number
                fields: Array<{ name: string; offset: number }>
              }>
            }
          ).uniforms[0]
          const buf = new ArrayBuffer(Math.ceil(u.size / 16) * 16)
          const f32 = new Float32Array(buf)
          const ubo = gl.createBuffer()
          const blockIdx = gl.getUniformBlockIndex(prog, u.name)
          gl.uniformBlockBinding(prog, blockIdx, 0)
          gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, ubo)
          gl.bindVertexArray(gl.createVertexArray())
          gl.viewport(0, 0, S, S)

          const draw = (mouse: number[]): Uint8Array => {
            for (const field of u.fields) {
              const c = (controls as Record<
                string,
                { kind: string; value?: number | number[] | boolean }
              >)[field.name]
              let v: number[] = [0]
              if (c?.kind === 'time') v = [2.0]
              else if (c?.kind === 'resolution') v = [S, S]
              else if (c?.kind === 'mouse') v = mouse
              else if (c?.kind === 'slider') v = [c.value as number]
              else if (c?.kind === 'toggle') v = [c.value ? 1 : 0]
              else if (c?.kind === 'pan2d') {
                // default center → DF64Vec2 planes [hi.x, hi.y, lo.x, lo.y]
                const fr = Math.fround
                const [x, y] = c.value as number[]
                v = [fr(x), fr(y), fr(x - fr(x)), fr(y - fr(y))]
              } else if (c?.kind === 'const') v = c.value as number[]
              for (let i = 0; i < v.length; i++) f32[field.offset / 4 + i] = v[i]
            }
            gl.bindBuffer(gl.UNIFORM_BUFFER, ubo)
            gl.bufferData(gl.UNIFORM_BUFFER, buf, gl.DYNAMIC_DRAW)
            gl.clearColor(0, 0, 0, 1)
            gl.clear(gl.COLOR_BUFFER_BIT)
            gl.drawArrays(gl.TRIANGLES, 0, 3)
            const px = new Uint8Array(S * S * 4)
            gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, px)
            return px
          }

          const idle = draw([0, 0, 0, 0]) // never touched — canonical view
          const active = draw([S * 0.8, S * 0.3, 1, 1]) // pointer at (0.8, 0.3), held
          let differing = 0
          for (let i = 0; i < idle.length; i += 4) {
            if (
              Math.abs(idle[i] - active[i]) +
                Math.abs(idle[i + 1] - active[i + 1]) +
                Math.abs(idle[i + 2] - active[i + 2]) >
              12
            )
              differing++
          }
          return { differing, total: S * S, glError: gl.getError() }
        },
        { vertex, fragment, reflection, controls },
      )

      expect(r, 'WebGL2 unavailable in the test browser').not.toHaveProperty('fatal')
      if ('fatal' in r) return
      expect(r.glError, 'GL error during draw').toBe(0)
      // "visibly different" = at least 2% of pixels moved by a clear margin
      expect(
        r.differing,
        `only ${r.differing}/${r.total} pixels changed — the mouse control packs nothing?`,
      ).toBeGreaterThan(r.total * 0.02)
    })
  }
})
