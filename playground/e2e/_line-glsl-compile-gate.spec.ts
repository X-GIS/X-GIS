// ═══ Line GLSL twin compile gate (#834 M5 slice 1) ═══
//
// Compiles + links the REAL solid-line twin (`emitLineGlsl(false, stage)` —
// the exact module the WebGL2 line Material will consume) on a real WebGL2
// context. Beyond the polygon gate this exercises: three array<Struct>
// storage buffers lowered to R32F data textures (segments / shapes /
// shape_segments), a UBO with NESTED struct + array fields (LineLayer's
// array<PatternSlot, 3> / array<vec4f, 2> — the emitGlslUbo struct-map fix),
// the fused sprite-atlas combined sampler, and the instanced
// gl_VertexID/gl_InstanceID segment-quad glue. Prerequisite for wiring the
// line Material on the webgl2 backend.

import { test, expect } from '@playwright/test'
// Relative imports (NOT workspace aliases): Playwright transpiles specs in raw
// Node — same convention as _polygon-glsl-compile-gate.spec.ts.
import { configureProjections } from '../../map/src/shaders/dsl/projections'
import { emitLineGlsl } from '../../map/src/shaders/dsl/line-glsl'
import { PROJECTIONS } from '../../engine/src/index'

test.describe('line GLSL twin compiles on real WebGL2 (#834 M5)', () => {
  test('vs_line + fs_line (no pick) compile + link cleanly', async ({ page }) => {
    configureProjections(PROJECTIONS)
    const vertex = emitLineGlsl(false, 'vertex')
    const fragment = emitLineGlsl(false, 'fragment')
    expect(vertex.length).toBeGreaterThan(500)
    expect(fragment.length).toBeGreaterThan(200)
    expect(vertex.startsWith('#version 300 es')).toBe(true)
    // Segment vertex pulling: instanced quad from the segments data texture.
    expect(vertex).toMatch(/gl_VertexID/)
    expect(vertex).toMatch(/gl_InstanceID/)
    expect(vertex).toContain('texelFetch')
    // The nested-struct UBO must emit its member struct + array fields.
    expect(vertex).toContain('uniform LineLayer')

    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

    const result = await page.evaluate(
      ({ vertex, fragment }) => {
        const canvas = document.createElement('canvas')
        const gl = canvas.getContext('webgl2')
        if (!gl) return { fatal: 'no webgl2 context' as const }
        const compile = (type: number, src: string): { ok: boolean; log: string } => {
          const sh = gl.createShader(type)!
          gl.shaderSource(sh, src)
          gl.compileShader(sh)
          return {
            ok: gl.getShaderParameter(sh, gl.COMPILE_STATUS) as boolean,
            log: gl.getShaderInfoLog(sh) ?? '',
          }
        }
        const vs = compile(gl.VERTEX_SHADER, vertex)
        const fs = compile(gl.FRAGMENT_SHADER, fragment)
        let linkOk = false
        let linkLog = ''
        if (vs.ok && fs.ok) {
          const prog = gl.createProgram()!
          const vsh = gl.createShader(gl.VERTEX_SHADER)!
          gl.shaderSource(vsh, vertex)
          gl.compileShader(vsh)
          const fsh = gl.createShader(gl.FRAGMENT_SHADER)!
          gl.shaderSource(fsh, fragment)
          gl.compileShader(fsh)
          gl.attachShader(prog, vsh)
          gl.attachShader(prog, fsh)
          gl.linkProgram(prog)
          linkOk = gl.getProgramParameter(prog, gl.LINK_STATUS) as boolean
          linkLog = gl.getProgramInfoLog(prog) ?? ''
        }
        return { vs, fs, linkOk, linkLog }
      },
      { vertex, fragment },
    )

    expect(result, `WebGL2 unavailable`).not.toHaveProperty('fatal')
    if ('fatal' in result) return
    expect(
      result.vs.ok,
      `line vertex GLSL failed to compile:\n${result.vs.log}\n--- GLSL ---\n${vertex}`,
    ).toBe(true)
    expect(
      result.fs.ok,
      `line fragment GLSL failed to compile:\n${result.fs.log}\n--- GLSL ---\n${fragment}`,
    ).toBe(true)
    expect(result.linkOk, `line program failed to link:\n${result.linkLog}`).toBe(true)
  })

  test('vs_line + fs_line_pattern compile + link cleanly', async ({ page }) => {
    // #834 M5 slice 5 — the Mapbox line-pattern fragment twin (sprite-atlas
    // sample; the pattern pipeline variant's own fsCode).
    configureProjections(PROJECTIONS)
    const vertex = emitLineGlsl(false, 'vertex')
    const fragment = emitLineGlsl(false, 'fragment-pattern')
    expect(fragment.length).toBeGreaterThan(200)
    // The pattern fragment samples the sprite atlas through the fused
    // combined sampler named after the texture binding.
    expect(fragment).toContain('sprite_atlas')

    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

    const result = await page.evaluate(
      ({ vertex, fragment }) => {
        const canvas = document.createElement('canvas')
        const gl = canvas.getContext('webgl2')
        if (!gl) return { fatal: 'no webgl2 context' as const }
        const compile = (type: number, src: string): { ok: boolean; log: string } => {
          const sh = gl.createShader(type)!
          gl.shaderSource(sh, src)
          gl.compileShader(sh)
          return {
            ok: gl.getShaderParameter(sh, gl.COMPILE_STATUS) as boolean,
            log: gl.getShaderInfoLog(sh) ?? '',
          }
        }
        const vs = compile(gl.VERTEX_SHADER, vertex)
        const fs = compile(gl.FRAGMENT_SHADER, fragment)
        let linkOk = false
        let linkLog = ''
        if (vs.ok && fs.ok) {
          const prog = gl.createProgram()!
          const vsh = gl.createShader(gl.VERTEX_SHADER)!
          gl.shaderSource(vsh, vertex)
          gl.compileShader(vsh)
          const fsh = gl.createShader(gl.FRAGMENT_SHADER)!
          gl.shaderSource(fsh, fragment)
          gl.compileShader(fsh)
          gl.attachShader(prog, vsh)
          gl.attachShader(prog, fsh)
          gl.linkProgram(prog)
          linkOk = gl.getProgramParameter(prog, gl.LINK_STATUS) as boolean
          linkLog = gl.getProgramInfoLog(prog) ?? ''
        }
        return { vs, fs, linkOk, linkLog }
      },
      { vertex, fragment },
    )

    expect(result, `WebGL2 unavailable`).not.toHaveProperty('fatal')
    if ('fatal' in result) return
    expect(
      result.fs.ok,
      `line pattern fragment GLSL failed to compile:\n${result.fs.log}\n--- GLSL ---\n${fragment}`,
    ).toBe(true)
    expect(result.linkOk, `line pattern program failed to link:\n${result.linkLog}`).toBe(true)
  })
})
