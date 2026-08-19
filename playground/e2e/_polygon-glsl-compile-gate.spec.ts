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

import { test, expect, type Page } from '@playwright/test'
// Relative imports (NOT workspace aliases): Playwright transpiles specs in raw
// Node — same convention as _glsl-compile-gate.spec.ts.
import { configureProjections } from '../../map/src/shaders/dsl/projections'
import { emitPolygonGlsl, emitPolygonGlslStages } from '../../map/src/shaders/dsl/polygon'
import { PROJECTIONS } from '../../geo/src/projections-table'
import { Node, arrayT, f32T, u32T, vec4fT } from '../../shader-dsl/src/index'

/** Compile both stages on the page's REAL WebGL2 context and link them. Returns the
 *  `fatal` shape when no WebGL2 context exists, so the caller can prove the gate ran
 *  against a real driver rather than silently skipping. */
async function compileAndLink(page: Page, vertex: string, fragment: string) {
  return await page.evaluate(
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
}

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

    const result = await compileAndLink(page, vertex, fragment)

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

  // #1592 / #1647 — the DATA-DRIVEN twin. `needsFeatureBuffer: true` appends the
  // `feat_data` storage binding, which WebGL2 cannot spell; the backend now lowers it
  // to a data texture BY DEFAULT, so this emit needs no opt-in. A real `feat_data[0]`
  // read in fillExpr makes the lowering LOAD-BEARING: the fragment must carry the
  // sampler2D + texelFetch, and the driver must accept it.
  test('a needsFeatureBuffer variant (feat_data read) compiles + links on real WebGL2', async ({
    page,
  }) => {
    configureProjections(PROJECTIONS)
    // fillExpr = vec4(feat_data[0], 0, 0, 1) — raw IR, the same shape the paint
    // compiler hands the composer (polygon-shader-cache.ts wraps its Expr in a Node).
    const fillExpr = new Node<'vec4<f32>'>({
      op: 'construct',
      type: vec4fT,
      args: [
        {
          op: 'index',
          type: f32T,
          base: { op: 'varref', type: arrayT(f32T), name: 'feat_data' },
          idx: { op: 'lit', type: u32T, value: 0 },
        },
        { op: 'lit', type: f32T, value: 0 },
        { op: 'lit', type: f32T, value: 0 },
        { op: 'lit', type: f32T, value: 1 },
      ],
    })
    const { vertex, fragment } = emitPolygonGlslStages(
      {
        preamble: null,
        fillExpr,
        strokeExpr: null,
        fillPreamble: null,
        strokePreamble: null,
        needsFeatureBuffer: true,
      },
      false,
    )
    expect(vertex.startsWith('#version 300 es')).toBe(true)
    expect(fragment.startsWith('#version 300 es')).toBe(true)
    // The storage binding became a data texture, and the read became a texel fetch —
    // no SSBO spelling survives into the GLSL.
    expect(fragment).toContain('uniform sampler2D feat_data;')
    // Since #1878 the fetch is a CALL to a helper the writer emits, so both halves are
    // asserted — and the compile+link below is what proves a sampler-typed FUNCTION
    // PARAMETER (GLSL ES 3.00 §4.1.7) is accepted by a real driver, not just by the writer.
    expect(fragment).toContain('float _sfetch(sampler2D t, int i) {')
    expect(fragment).toContain('_sfetch(feat_data,')
    expect(fragment).not.toContain('feat_data[')

    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

    const result = await compileAndLink(page, vertex, fragment)

    expect(result, `WebGL2 unavailable`).not.toHaveProperty('fatal')
    if ('fatal' in result) return
    expect(
      result.vs.ok,
      `feat_data vertex GLSL failed to compile:\n${result.vs.log}\n--- GLSL ---\n${vertex}`,
    ).toBe(true)
    expect(
      result.fs.ok,
      `feat_data fragment GLSL failed to compile:\n${result.fs.log}\n--- GLSL ---\n${fragment}`,
    ).toBe(true)
    expect(result.linkOk, `feat_data program failed to link:\n${result.linkLog}`).toBe(true)
  })
})
