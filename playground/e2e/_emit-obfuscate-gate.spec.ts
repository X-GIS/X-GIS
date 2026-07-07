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

  test('pixel identity: plain vs { minify, mangle } draw BYTE-IDENTICAL frames', async ({
    page,
  }) => {
    // Compile+link proves the text is valid; only a draw proves the transforms
    // preserved SEMANTICS. Three representative modules (plain gradient, a
    // helper-heavy fragment, and the df64 + `_fp64`-guard path) render with the
    // same synthetic inputs through both emits — frames must match byte-for-byte,
    // and must not be a single flat colour (a blank frame would pass vacuously).
    const ids = ['gradient', 'kaleidoscope', 'fp64-deep-zoom']
    const cases = ids.map((id) => {
      const ex = renderable.find((e) => e.id === id)
      if (!ex) throw new Error(`example '${id}' missing from the renderable set`)
      const emit = (stage: 'vertex' | 'fragment', obf: boolean) =>
        emitGlslModule(ex.module, stage, obf ? { minify: true, mangle: true } : undefined)
      return {
        name: id,
        plainVs: emit('vertex', false),
        plainFs: emit('fragment', false),
        obfVs: emit('vertex', true),
        obfFs: emit('fragment', true),
      }
    })

    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
    const result = await page.evaluate(
      (cs: Array<{ name: string; plainVs: string; plainFs: string; obfVs: string; obfFs: string }>) => {
        const canvas = document.createElement('canvas')
        canvas.width = 64
        canvas.height = 64
        const gl = canvas.getContext('webgl2')
        if (!gl) return { fatal: 'no webgl2 context' as const }

        // One shared input state, identical for every program: a VARIED (but
        // deterministic) float pattern in every UBO slot — an all-1.0 fill made
        // gradient's top == bottom, a legitimately flat frame the non-vacuous
        // check below cannot accept — and a white 1×1 texel for every sampler
        // (the `_fp64` guard's required value). Blocks/samplers are enumerated
        // by INDEX, not name, so the harness is rename-agnostic by construction.
        const uboData = new Float32Array(128)
        for (let i = 0; i < uboData.length; i++) uboData[i] = 0.1 + (i % 7) * 0.25
        const ubo = gl.createBuffer()!
        gl.bindBuffer(gl.UNIFORM_BUFFER, ubo)
        gl.bufferData(gl.UNIFORM_BUFFER, uboData, gl.STATIC_DRAW)
        gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, ubo)
        const tex = gl.createTexture()!
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.texImage2D(
          gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
          new Uint8Array([255, 255, 255, 255]),
        )

        const draw = (vsSrc: string, fsSrc: string): Uint8Array | string => {
          const compile = (type: number, src: string): WebGLShader | string => {
            const sh = gl.createShader(type)!
            gl.shaderSource(sh, src)
            gl.compileShader(sh)
            return gl.getShaderParameter(sh, gl.COMPILE_STATUS)
              ? sh
              : (gl.getShaderInfoLog(sh) ?? 'compile failed')
          }
          const vsh = compile(gl.VERTEX_SHADER, vsSrc)
          if (typeof vsh === 'string') return `vs: ${vsh}`
          const fsh = compile(gl.FRAGMENT_SHADER, fsSrc)
          if (typeof fsh === 'string') return `fs: ${fsh}`
          const prog = gl.createProgram()!
          gl.attachShader(prog, vsh)
          gl.attachShader(prog, fsh)
          gl.linkProgram(prog)
          if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
            return `link: ${gl.getProgramInfoLog(prog) ?? ''}`
          gl.useProgram(prog)
          const nBlocks = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORM_BLOCKS) as number
          for (let i = 0; i < nBlocks; i++) gl.uniformBlockBinding(prog, i, 0)
          const nUniforms = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) as number
          for (let i = 0; i < nUniforms; i++) {
            const info = gl.getActiveUniform(prog, i)
            if (info && info.type === gl.SAMPLER_2D)
              gl.uniform1i(gl.getUniformLocation(prog, info.name), 0)
          }
          gl.viewport(0, 0, 64, 64)
          gl.clearColor(0, 0, 0, 1)
          gl.clear(gl.COLOR_BUFFER_BIT)
          gl.drawArrays(gl.TRIANGLES, 0, 3)
          const px = new Uint8Array(64 * 64 * 4)
          gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, px)
          return px
        }

        const failures: string[] = []
        for (const c of cs) {
          const plain = draw(c.plainVs, c.plainFs)
          if (typeof plain === 'string') {
            failures.push(`${c.name} [plain] ${plain}`)
            continue
          }
          const obf = draw(c.obfVs, c.obfFs)
          if (typeof obf === 'string') {
            failures.push(`${c.name} [obf] ${obf}`)
            continue
          }
          let diff = 0
          for (let i = 0; i < plain.length; i++) if (plain[i] !== obf[i]) diff++
          if (diff > 0) failures.push(`${c.name}: ${diff} bytes differ between plain and obfuscated`)
          // non-vacuous: the frame must not be one flat colour
          let flat = true
          for (let i = 4; i < plain.length; i += 4)
            if (plain[i] !== plain[0] || plain[i + 1] !== plain[1] || plain[i + 2] !== plain[2]) {
              flat = false
              break
            }
          if (flat) failures.push(`${c.name}: frame is a single flat colour (vacuous comparison)`)
        }
        return { failures }
      },
      cases,
    )

    expect(result, `WebGL2 unavailable: ${'fatal' in result ? result.fatal : ''}`).not.toHaveProperty(
      'fatal',
    )
    if ('fatal' in result) return
    expect(result.failures, result.failures.join('\n')).toEqual([])
  })
})
