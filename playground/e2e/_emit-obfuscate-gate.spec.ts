// ═══ Obfuscated-emit compile gate: { minify, mangle } output runs on real compilers ═══
//
// The unit suite (mangle.test.ts / emit-minify.test.ts) pins the rename scope,
// the ABI boundary, and the minifier's token-safety rules AS STRINGS — but a
// whitespace rule that is subtly wrong (a merged token, a directive swallowed)
// or a rename that desyncs the two GLSL stages produces a string only a real
// shader compiler rejects. This gate emits EVERY renderable shader-dsl example
// twice-transformed ({ minify: true, mangle: true }) and:
//   • WGSL — createShaderModule + getCompilationInfo (Tint), zero errors;
//   • GLSL — compileShader for BOTH stages + linkProgram (ANGLE), zero errors —
//     linking proves the per-call mangle is deterministic across the separate
//     vertex/fragment emits (varyings + shared helpers agree by name).
// Runs on SwiftShader in CI like the other compile gates (no raster needed).

import { test, expect } from '@playwright/test'
// Relative deep imports (charter): Playwright transpiles specs in raw Node — the
// @xgis/* workspace alias does not resolve here (see _glsl-compile-gate.spec.ts).
import { emitModule, emitGlslModule } from '../../shader-dsl/src/index'
import { examples } from '../../shader-dsl/examples/index'

const renderable = examples.filter((ex) => ex.renderable)

test.describe('obfuscated emit ({ minify, mangle }) compiles on real Tint + ANGLE', () => {
  test('WGSL: every renderable example, minified + mangled, compiles with zero errors', async ({
    page,
  }) => {
    const variants = renderable.map((ex) => ({
      name: ex.id,
      wgsl: emitModule(ex.module, { minify: true, mangle: true }),
    }))
    expect(variants.length).toBeGreaterThan(10)
    for (const v of variants) {
      // Minified = exactly one line (WGSL has no directives) — a second line
      // means the minifier failed to join, an empty one means a broken emit.
      expect(v.wgsl.trimEnd().split('\n'), `${v.name} not single-line`).toHaveLength(1)
      expect(v.wgsl.length, `${v.name} emitted empty WGSL`).toBeGreaterThan(20)
    }

    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
    const result = await page.evaluate(async (vs: Array<{ name: string; wgsl: string }>) => {
      const nav = navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }
      if (!nav.gpu) return { fatal: 'no navigator.gpu' as const }
      const adapter = await (nav.gpu.requestAdapter() as Promise<GPUAdapter | null>)
      if (!adapter) return { fatal: 'no adapter' as const }
      const device = await adapter.requestDevice()
      const failures: string[] = []
      for (const v of vs) {
        try {
          const module = device.createShaderModule({ code: v.wgsl })
          const info = await module.getCompilationInfo()
          const errs = info.messages.filter((m) => m.type === 'error')
          if (errs.length > 0)
            failures.push(`${v.name}: ${errs.map((e) => e.message).join(' | ')}`)
        } catch (e) {
          failures.push(`${v.name}: threw ${(e as Error).message}`)
        }
      }
      return { failures }
    }, variants)

    expect(result, `GPU unavailable: ${'fatal' in result ? result.fatal : ''}`).not.toHaveProperty(
      'fatal',
    )
    if ('fatal' in result) return
    expect(
      result.failures,
      `minified+mangled WGSL failed on Tint:\n${result.failures.join('\n')}`,
    ).toEqual([])
  })

  test('GLSL: every renderable example, minified + mangled, compiles AND links', async ({
    page,
  }) => {
    const pairs = renderable.map((ex) => ({
      name: ex.id,
      vertex: emitGlslModule(ex.module, 'vertex', { minify: true, mangle: true }),
      fragment: emitGlslModule(ex.module, 'fragment', { minify: true, mangle: true }),
    }))
    for (const p of pairs)
      expect(p.vertex.startsWith('#version 300 es\n'), `${p.name}: directive lost`).toBe(true)

    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
    const result = await page.evaluate(
      (ps: Array<{ name: string; vertex: string; fragment: string }>) => {
        const canvas = document.createElement('canvas')
        const gl = canvas.getContext('webgl2')
        if (!gl) return { fatal: 'no webgl2 context' as const }
        const failures: string[] = []
        for (const p of ps) {
          const compile = (type: number, src: string): WebGLShader | string => {
            const sh = gl.createShader(type)!
            gl.shaderSource(sh, src)
            gl.compileShader(sh)
            return gl.getShaderParameter(sh, gl.COMPILE_STATUS)
              ? sh
              : (gl.getShaderInfoLog(sh) ?? 'compile failed')
          }
          const vsh = compile(gl.VERTEX_SHADER, p.vertex)
          const fsh = compile(gl.FRAGMENT_SHADER, p.fragment)
          if (typeof vsh === 'string') {
            failures.push(`${p.name} [vs]: ${vsh}`)
            continue
          }
          if (typeof fsh === 'string') {
            failures.push(`${p.name} [fs]: ${fsh}`)
            continue
          }
          const prog = gl.createProgram()!
          gl.attachShader(prog, vsh)
          gl.attachShader(prog, fsh)
          gl.linkProgram(prog)
          if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
            failures.push(`${p.name} [link]: ${gl.getProgramInfoLog(prog) ?? ''}`)
        }
        return { failures }
      },
      pairs,
    )

    expect(result, `WebGL2 unavailable: ${'fatal' in result ? result.fatal : ''}`).not.toHaveProperty(
      'fatal',
    )
    if ('fatal' in result) return
    expect(
      result.failures,
      `minified+mangled GLSL failed on ANGLE:\n${result.failures.join('\n')}`,
    ).toEqual([])
  })
})
