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
import { emitModule } from '../../shader-dsl/src/index'
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
