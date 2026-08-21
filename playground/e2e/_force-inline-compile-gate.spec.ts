// ═══ forceInline compile gate: the flattened df64 output is real, compilable WGSL ═══
//
// `forceInline({ strength: 'all' })` unlocks `FuncDecl.opaque` so the df64 library is
// inlined and tree-shaken away. That trades a 9-15 function call graph for ONE flat
// entry body and, measured on this corpus, 5.1x to 27.2x the bytes — fp64-sine-sweep
// goes 6,266 B to 170,419 B. A unit test can assert the df64_* declarations are gone; it
// cannot say whether what replaced them is something a shader compiler will accept.
//
// So this compiles every fp64 example, under BOTH strengths, on the real Tint the other
// e2e use (SwiftShader WebGPU under XGIS_SOFTWARE_GPU=1) and requires zero
// error-severity messages. Two arms, because they fail differently: 'size-win' is a
// small edit to a working shader, 'all' is a 170 KB single function — exactly the shape
// that finds a compiler's expression-depth or function-size limit.
//
// WHAT THIS DOES NOT PROVE. Tint on SwiftShader is not FXC on ANGLE-D3D11, and
// `shader-dsl/src/core/fp64/flavor-select.ts` already records that FXC's compile COST on
// fully-inlined df64 bodies can TDR. A green run here says the WGSL is well-formed and
// that one real compiler accepts it at this size; it says nothing about that risk, which
// has no reproduction in this environment.

import { test, expect } from '@playwright/test'
// Relative deep imports (charter): Playwright transpiles specs in raw Node, so the
// @xgis/* workspace alias does not resolve here — see _wgsl-compile-gate.spec.ts.
import { examples } from '../../shader-dsl/examples/index'
import { emitModule, emitGlslModule, reflect } from '../../shader-dsl/src/index'
import { forceInline } from '../../shader-dsl/src/emit-prod'

interface Variant {
  name: string
  wgsl: string
  df64Left: number
}

function fp64Variants(): Variant[] {
  const out: Variant[] = []
  for (const ex of examples.filter((e) => e.id.startsWith('fp64-'))) {
    for (const strength of ['size-win', 'all'] as const) {
      const wgsl = emitModule(ex.module, { plugins: [forceInline({ strength })] })
      out.push({
        name: `${ex.id} [${strength}]`,
        wgsl,
        df64Left: [...wgsl.matchAll(/^fn (df64_\w+)/gm)].length,
      })
    }
  }
  return out
}

// ── and it must DRAW the same frame, not merely compile ──
//
// Compiling proves the WGSL is well-formed; it says nothing about whether flattening the
// df64 call graph preserved the arithmetic. This arm renders each fp64 example twice on real
// WebGL2 — plugin-free and fully flattened — and requires the readback to be byte-identical.
// That is rung 3 of the render-gate ladder (hash equality, not a tolerance), which is
// reachable here because the harness is deterministic: fixed 256x256 viewport, fixed control
// values, software rasteriser.
//
// WHY THE df64-COUNT ASSERTION LEADS. A zero-pixel diff is exactly what a NO-OP produces
// too, so on its own it would pass whether or not forceInline did anything — §12's
// "assertion that failed either way". The emit-side check that every df64_ declaration is
// gone is what makes the pixel equality mean something.
const RENDER_N = 256

test.describe('forceInline render parity (the flattened shader draws the same frame)', () => {
  test('every fp64 example renders byte-identically with the df64 call graph flattened', async ({
    page,
  }) => {
    test.setTimeout(300_000)
    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

    const fp64 = examples.filter((e) => e.renderable && e.id.startsWith('fp64-'))
    expect(fp64.length, 'no renderable fp64 examples enumerated').toBeGreaterThanOrEqual(10)

    const drifted: string[] = []
    const vacuous: string[] = []
    for (const ex of fp64) {
      // The mechanism must actually fire, or the pixel equality below is vacuous.
      const flatWgsl = emitModule(ex.module, { plugins: [forceInline({ strength: 'all' })] })
      if (/^fn df64_/m.test(flatWgsl)) vacuous.push(ex.id)

      const src = (plugins: unknown[]) => ({
        vertex: emitGlslModule(ex.module, 'vertex', { plugins: plugins as never }),
        fragment: emitGlslModule(ex.module, 'fragment', { plugins: plugins as never }),
      })
      const shot = (s: { vertex: string; fragment: string }) =>
        page.evaluate(drawExample, {
          ...s,
          reflection: reflect(ex.module) as unknown,
          controls: (ex.controls ?? {}) as unknown,
          N: RENDER_N,
        })

      const base = await shot(src([]))
      for (const strength of ['size-win', 'all'] as const) {
        const got = await shot(src([forceInline({ strength })]))
        if (base.err || got.err) {
          drifted.push(`${ex.id} [${strength}]: ${base.err ?? got.err}`)
          continue
        }
        let n = 0
        for (let i = 0; i < base.px!.length; i++) if (base.px![i] !== got.px![i]) n++
        if (n > 0) drifted.push(`${ex.id} [${strength}]: ${Math.ceil(n / 4)} px differ`)
      }
    }
    expect(
      vacuous,
      `forceInline('all') left df64_* standing — the pixel arm would be vacuous`,
    ).toEqual([])
    expect(drifted, `flattening moved pixels:\n${drifted.join('\n')}`).toEqual([])
  })
})

test.describe('forceInline compile gate (flattened df64 compiles on a GPU)', () => {
  test('every fp64 example compiles under both strengths, with zero errors', async ({ page }) => {
    test.setTimeout(180_000)
    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

    const variants = fp64Variants()
    // Non-vacuity, per §12: a gate over an empty (or unchanged) enumeration passes while
    // proving nothing. Assert the corpus is there AND that 'all' actually removed the
    // library — otherwise this would just be re-compiling the shipped shaders.
    expect(variants.length, 'no fp64 variants enumerated').toBeGreaterThanOrEqual(20)
    for (const v of variants.filter((x) => x.name.endsWith('[all]'))) {
      expect(v.df64Left, `${v.name} still declares df64_* — forceInline did not fire`).toBe(0)
      expect(v.wgsl.length, `${v.name} emitted trivial WGSL`).toBeGreaterThan(1000)
    }

    const result = await page.evaluate(
      async (vs: Array<{ name: string; wgsl: string }>) => {
        const nav = navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }
        if (!nav.gpu) return { fatal: 'no navigator.gpu' as const }
        const adapter = await (nav.gpu.requestAdapter() as Promise<GPUAdapter | null>)
        if (!adapter) return { fatal: 'no adapter' as const }
        const device = await adapter.requestDevice()
        const failures: string[] = []
        for (const v of vs) {
          try {
            const info = await device.createShaderModule({ code: v.wgsl }).getCompilationInfo()
            const errs = info.messages.filter((m) => m.type === 'error')
            if (errs.length > 0) {
              failures.push(
                `${v.name}: ${errs.map((e) => `L${e.lineNum}: ${e.message}`).join(' | ')}`,
              )
            }
          } catch (e) {
            failures.push(`${v.name}: threw ${(e as Error).message}`)
          }
        }
        return { failures, count: vs.length }
      },
      variants.map((v) => ({ name: v.name, wgsl: v.wgsl })),
    )

    expect(result, `GPU unavailable: ${'fatal' in result ? result.fatal : ''}`).not.toHaveProperty(
      'fatal',
    )
    if ('fatal' in result) return
    expect(
      result.failures,
      `force-inlined WGSL failed to compile on the GPU:\n${result.failures.join('\n')}`,
    ).toEqual([])
  })
})

/** Compile + link + draw one example into an N x N WebGL2 canvas and read it back. Mirrors
 *  _shader-dsl-examples-render.spec.ts's harness, including the `_fp64` guard texture the
 *  lowering injects (absent from the authored reflection, so the program is probed for it). */
function drawExample(a: {
  vertex: string
  fragment: string
  reflection: unknown
  controls: unknown
  N: number
}): { px?: number[]; err?: string } {
  const { vertex, fragment, reflection, controls, N } = a
  const c = document.createElement('canvas')
  c.width = N
  c.height = N
  const gl = c.getContext('webgl2')
  if (!gl) return { err: 'no webgl2 context' }
  const mk = (t: number, s: string): WebGLShader => {
    const sh = gl.createShader(t)!
    gl.shaderSource(sh, s)
    gl.compileShader(sh)
    return sh
  }
  const vs = mk(gl.VERTEX_SHADER, vertex)
  const fs = mk(gl.FRAGMENT_SHADER, fragment)
  const p = gl.createProgram()!
  gl.attachShader(p, vs)
  gl.attachShader(p, fs)
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    return {
      err: (gl.getShaderInfoLog(fs) || gl.getProgramInfoLog(p) || 'link failed').slice(0, 200),
    }
  }
  gl.useProgram(p)
  const u = (
    reflection as {
      uniforms: Array<{
        name: string
        size: number
        fields: Array<{ name: string; offset: number }>
      }>
    }
  ).uniforms[0]
  if (u) {
    const buf = new ArrayBuffer(Math.ceil(u.size / 16) * 16)
    const f32 = new Float32Array(buf)
    for (const f of u.fields) {
      const ct = (
        controls as Record<string, { kind: string; value?: number | number[] | boolean }>
      )[f.name]
      let v: number[] = [0]
      if (ct?.kind === 'time') v = [1.0]
      else if (ct?.kind === 'resolution') v = [N, N]
      else if (ct?.kind === 'slider') v = [ct.value as number]
      else if (ct?.kind === 'toggle') v = [ct.value ? 1 : 0]
      else if (ct?.kind === 'pan2d') {
        const fr = Math.fround
        const [x, y] = ct.value as number[]
        v = [fr(x!), fr(y!), fr(x! - fr(x!)), fr(y! - fr(y!))]
      } else if (ct?.kind === 'const') v = ct.value as number[]
      for (let i = 0; i < v.length; i++) f32[f.offset / 4 + i] = v[i]!
    }
    const ubo = gl.createBuffer()
    gl.bindBuffer(gl.UNIFORM_BUFFER, ubo)
    gl.bufferData(gl.UNIFORM_BUFFER, buf, gl.STATIC_DRAW)
    const bi = gl.getUniformBlockIndex(p, u.name)
    if (bi !== 0xffffffff) {
      gl.uniformBlockBinding(p, bi, 0)
      gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, ubo)
    }
  }
  const gLoc = gl.getUniformLocation(p, '_fp64')
  if (gLoc) {
    const t = gl.createTexture()
    gl.activeTexture(gl.TEXTURE7)
    gl.bindTexture(gl.TEXTURE_2D, t)
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
    gl.uniform1i(gLoc, 7)
    gl.activeTexture(gl.TEXTURE0)
  }
  gl.bindVertexArray(gl.createVertexArray())
  gl.viewport(0, 0, N, N)
  gl.clearColor(0, 0, 0, 1)
  gl.clear(gl.COLOR_BUFFER_BIT)
  gl.drawArrays(gl.TRIANGLES, 0, 3)
  const px = new Uint8Array(N * N * 4)
  gl.readPixels(0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, px)
  return { px: Array.from(px) }
}
