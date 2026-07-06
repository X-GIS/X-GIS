// ═══ Polygon fill GLSL twin compile gate (#832 M2) ═══
//
// `emitPolygonGlsl` (#775) existed unwired and UNPROVEN: no test ever fed its
// output through `gl.compileShader`. The generic _glsl-compile-gate proves the
// GLSL backend's representative SHAPE, but the polygon module additionally
// pulls in the projection ladder, log-depth, dequant helpers and INTEGER
// vertex attributes (uvec4/uvec2 quantized-ECEF lanes) that the representative
// module never exercises. This gate compiles + links the REAL default flat-fill
// twin (variant null, pick off — the exact module the WebGL2 fill Material
// consumes) on a real WebGL2 context. Prerequisite for wiring the fill
// Material on the webgl2 backend.

import { test, expect } from '@playwright/test'
// Relative imports (NOT workspace aliases): Playwright transpiles specs in raw
// Node — same convention as _glsl-compile-gate.spec.ts.
import { configureProjections } from '../../map/src/shaders/dsl/projections'
import { emitPolygonGlsl } from '../../map/src/shaders/dsl/polygon'
import { PROJECTIONS } from '../../engine/src/index'

test.describe('polygon fill GLSL twin compiles on real WebGL2 (#832 M2)', () => {
  test('vs_main_ecef + fs_fill (null variant, no pick) compile + link cleanly', async ({
    page,
  }) => {
    configureProjections(PROJECTIONS)
    const vertex = emitPolygonGlsl(null, false, 'vertex')
    const fragment = emitPolygonGlsl(null, false, 'fragment')
    expect(vertex.length).toBeGreaterThan(500)
    expect(fragment.length).toBeGreaterThan(200)
    expect(vertex.startsWith('#version 300 es')).toBe(true)
    // The quantized-ECEF position lanes must arrive as INTEGER attributes.
    expect(vertex).toMatch(/in uvec4 /)
    expect(vertex).toMatch(/in uvec2 /)

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
      `polygon vertex GLSL failed to compile:\n${result.vs.log}\n--- GLSL ---\n${vertex}`,
    ).toBe(true)
    expect(
      result.fs.ok,
      `polygon fragment GLSL failed to compile:\n${result.fs.log}\n--- GLSL ---\n${fragment}`,
    ).toBe(true)
    expect(result.linkOk, `polygon program failed to link:\n${result.linkLog}`).toBe(true)
  })
})
