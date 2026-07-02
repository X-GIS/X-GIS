// ═══ WGSL compile gate: every emitted shader variant compiles on a GPU ═══
//
// The unit suite emits WGSL strings and byte-diffs them (polygon-variant-diff,
// line-dsl, raster-dsl) but NEVER compiles them on a real device, and
// _shader-math-parity only executes project()/inv_merc_lat_rad. So a variant
// that emits a string the WGSL compiler REJECTS — an undeclared identifier, a
// type mismatch, a bad binding, a struct-size error — ships CI-green and only
// blows up on a user's GPU as "nothing renders for layer/projection X".
//
// This gate enumerates EVERY surface's emitted WGSL (polygon fixtures, line
// ±pick, line-composite, point, raster ±pick, icon, overdraw compose/fs, text)
// and createShaderModule()s each in the same SwiftShader-capable Chromium the
// other e2e use, asserting getCompilationInfo() reports zero error-severity
// messages. Compilation needs no raster pipeline, so — like _shader-math-parity
// — it runs in CI under XGIS_SOFTWARE_GPU=1 (software WebGPU).
//
// Polygon variants come from the existing FIXTURES enumeration whose emit is
// pinned byte-equal to the production composer by polygon-variant-diff.test.ts,
// so compiling the fixtures validates the production-equivalent WGSL.

import { test, expect } from '@playwright/test'
// Relative deep import (charter): Playwright transpiles specs in raw Node — the @xgis/* workspace alias does not resolve here, so specs import package SOURCES relatively (see _glsl-compile-gate.spec.ts).
import { FIXTURES, emitForFixture } from '../../map/src/shaders/dsl/_polygon-fixtures'
// NOT the `@xgis/map` BARREL (see _shader-math-parity.spec.ts — #765 loader death).
import { emitLineWgsl, emitCompositeWgsl } from '../../map/src/shaders/dsl/line'
import { emitPointWgsl } from '../../map/src/shaders/dsl/point'
import { emitRasterWgsl } from '../../map/src/shaders/dsl/raster'
import { emitIconWgsl } from '../../map/src/shaders/dsl/icon'
import { emitOverdrawComposeWgsl } from '../../engine/src/shaders/dsl/overdraw-compose'
import { emitOverdrawFsWgsl } from '../../map/src/shaders/dsl/overdraw-fs'
import { emitTextWgsl } from '../../map/src/shaders/dsl/text'
import { emitHeatmapAccumWgsl } from '../../map/src/shaders/dsl/heatmap-accum'
import { emitHeatmapBlurWgsl } from '../../map/src/shaders/dsl/heatmap-blur'
import { emitHeatmapComposeWgsl } from '../../map/src/shaders/dsl/heatmap-compose'
import { configureProjections } from '../../map/src/shaders/dsl/projections'
import { PROJECTIONS } from '../../engine/src/projection/projections-table'

// This spec EMITS projection-dependent shaders (polygon/point/line/raster via the DSL), so it
// must inject the projection graph itself — do not rely on another render-gate spec having
// configured the process-shared singleton (Playwright may shard specs across worker realms).
configureProjections(PROJECTIONS)

/** Every WGSL string the DSL can hand to createShaderModule, labelled. */
function allVariants(): Array<{ name: string; wgsl: string }> {
  const out: Array<{ name: string; wgsl: string }> = []
  // Polygon: only the variant-less (base) fixtures are stand-alone
  // compile-complete. The match-chain VARIANT fixtures are fragment-splice
  // stand-ins for byte-diffing the fill region (polygon-variant-diff.test.ts)
  // — they reference vertex-stage field varyings (`field0_id`) that the real
  // composer declares but the splice deliberately omits, so they are NOT a
  // compilable module. Variant compile-coverage comes from the live render
  // e2e (demos that draw match-chain layers compile the real composer output).
  FIXTURES.filter((fx) => !fx.variant).forEach((fx, i) =>
    out.push({ name: `polygon-base[${i}] ${fx.note ?? ''}`.trim(), wgsl: emitForFixture(fx) }),
  )
  out.push({ name: 'line(pick=false)', wgsl: emitLineWgsl(false) })
  out.push({ name: 'line(pick=true)', wgsl: emitLineWgsl(true) })
  out.push({ name: 'line-composite', wgsl: emitCompositeWgsl() })
  out.push({ name: 'point', wgsl: emitPointWgsl() })
  out.push({ name: 'raster(pick=false)', wgsl: emitRasterWgsl(false) })
  out.push({ name: 'raster(pick=true)', wgsl: emitRasterWgsl(true) })
  out.push({ name: 'icon', wgsl: emitIconWgsl() })
  out.push({ name: 'overdraw-compose', wgsl: emitOverdrawComposeWgsl() })
  out.push({ name: 'overdraw-fs', wgsl: emitOverdrawFsWgsl() })
  out.push({ name: 'text', wgsl: emitTextWgsl() })
  out.push({ name: 'heatmap-accum', wgsl: emitHeatmapAccumWgsl() })
  out.push({ name: 'heatmap-blur', wgsl: emitHeatmapBlurWgsl() })
  out.push({ name: 'heatmap-compose', wgsl: emitHeatmapComposeWgsl() })
  return out
}

test.describe('WGSL compile gate (every emitted variant compiles on a GPU)', () => {
  test('all emitted shader variants compile with zero errors', async ({ page }) => {
    test.setTimeout(120_000)
    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })

    const variants = allVariants()
    // Sanity: the enumeration must actually produce non-trivial WGSL, else a
    // silently-empty emit would pass the gate vacuously.
    expect(variants.length, 'no variants enumerated').toBeGreaterThan(10)
    for (const v of variants) {
      // Catch a silently-empty emit (a few real shaders — e.g. overdraw-fs —
      // are legitimately tiny, so the floor only rules out near-empty output).
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

    // A missing adapter is a failure in CI (SwiftShader MUST enumerate one);
    // mirror _shader-math-parity's no-property-then-return contract.
    expect(result, `GPU unavailable: ${'fatal' in result ? result.fatal : ''}`).not.toHaveProperty('fatal')
    if ('fatal' in result) return
    expect(
      result.failures,
      `emitted WGSL variants failed to compile on the GPU:\n${result.failures.join('\n')}`,
    ).toEqual([])
  })
})
