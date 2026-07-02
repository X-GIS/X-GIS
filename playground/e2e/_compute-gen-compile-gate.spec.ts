// ═══ compute-gen WGSL compile gate: the compiler's compute kernels compile on a GPU ═══
//
// compiler/src/codegen/compute-gen.ts emits per-feature compute kernels (match / case /
// interpolate → packed RGBA). Its unit suite byte-diffs + snapshots the WGSL but NEVER
// compiled it on a real device — so a kernel the WGSL compiler REJECTS shipped CI-green.
// This gate createShaderModule()s each kernel on the SwiftShader-capable Chromium (like
// _wgsl-compile-gate) and asserts zero error-severity messages.
//
// Standalone (NOT folded into _wgsl-compile-gate): the compute kernels have NO projection
// dependency, so this gate never touches configureProjections() — it compiles the kernels
// in isolation. #625: interpolate is now shader-dsl-IR-emitted (CSE'd colours); match/case
// are still string-built (follow-up). All three must compile.

// Relative deep import (charter): Playwright transpiles specs in raw Node — the @xgis/* workspace alias does not resolve here, so specs import package SOURCES relatively (see _glsl-compile-gate.spec.ts).
import { test, expect } from '@playwright/test'
import {
  emitInterpolateComputeKernel, emitMatchComputeKernel, emitTernaryComputeKernel,
} from '../../compiler/src/codegen/compute-gen'

function computeVariants(): Array<{ name: string; wgsl: string }> {
  return [
    {
      name: 'interpolate-3stop (IR-emitted #625)',
      wgsl: emitInterpolateComputeKernel({
        fieldName: 'rank',
        stops: [{ input: 0, colorHex: '#ffffff' }, { input: 5, colorHex: '#888888' }, { input: 10, colorHex: '#000000' }],
      }).wgsl,
    },
    {
      name: 'interpolate-2stop',
      wgsl: emitInterpolateComputeKernel({
        fieldName: 'mag',
        stops: [{ input: 1, colorHex: '#ffff00' }, { input: 8, colorHex: '#ff0000' }],
      }).wgsl,
    },
    {
      name: 'match-3arm',
      wgsl: emitMatchComputeKernel({
        fieldName: 'class',
        arms: [{ pattern: 'school', colorHex: '#f0e8f8' }, { pattern: 'park', colorHex: '#88cc88' }, { pattern: 'hospital', colorHex: '#f5deb3' }],
        defaultColorHex: '#00000000',
      }).wgsl,
    },
    {
      name: 'match-20arm (LUT branch)',
      wgsl: emitMatchComputeKernel({
        fieldName: 'iso',
        arms: Array.from({ length: 20 }, (_, i) => ({ pattern: `p${i}`, colorHex: '#112233' })),
        defaultColorHex: '#00000000',
      }).wgsl,
    },
    {
      name: 'case-3pred',
      wgsl: emitTernaryComputeKernel({
        fields: ['cls'],
        branches: [
          { pred: { kind: 'cmp', field: 'cls', op: '==', value: 0 }, colorHex: '#ff0000' },
          { pred: { kind: 'cmp', field: 'cls', op: '==', value: 1 }, colorHex: '#00ff00' },
          { pred: { kind: 'cmp', field: 'cls', op: '==', value: 2 }, colorHex: '#0000ff' },
        ],
        defaultColorHex: '#888888',
      }).wgsl,
    },
  ]
}

test.describe('compute-gen WGSL compile gate', () => {
  test('every compute kernel compiles with zero errors on a GPU', async ({ page }) => {
    test.setTimeout(120_000)
    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

    const variants = computeVariants()
    for (const v of variants) {
      expect(v.wgsl.length, `${v.name} emitted empty WGSL`).toBeGreaterThan(20)
    }

    const result = await page.evaluate(async (variants: Array<{ name: string; wgsl: string }>) => {
      const nav = navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }
      if (!nav.gpu) return { fatal: 'no navigator.gpu' as const }
      const adapter = await (nav.gpu.requestAdapter() as Promise<GPUAdapter | null>)
      if (!adapter) return { fatal: 'no adapter' as const }
      const device = await adapter.requestDevice()
      const failures: string[] = []
      for (const v of variants) {
        try {
          const module = device.createShaderModule({ code: v.wgsl })
          const info = await module.getCompilationInfo()
          const errs = info.messages.filter((m) => m.type === 'error')
          if (errs.length > 0) {
            failures.push(`${v.name}: ${errs.map((e) => `L${e.lineNum}: ${e.message}`).join(' | ')}`)
          }
        } catch (e) {
          failures.push(`${v.name}: threw ${(e as Error).message}`)
        }
      }
      return { failures, count: variants.length }
    }, variants)

    expect(result, `GPU unavailable: ${'fatal' in result ? result.fatal : ''}`).not.toHaveProperty('fatal')
    if ('fatal' in result) return
    expect(
      result.failures,
      `compute kernels failed to compile on the GPU:\n${result.failures.join('\n')}`,
    ).toEqual([])
  })
})
