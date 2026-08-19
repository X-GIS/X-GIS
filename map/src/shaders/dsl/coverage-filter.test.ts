// ═══ One predicate, two backends — and the reasons it refuses (#1437) ═══
//
// The point of compiling `filter:` to shader-dsl IR rather than to WGSL directly is that the
// CPU evaluator is then not a SECOND implementation: `compileModuleJs` walks the same IR the
// WGSL/GLSL writers do. This file proves the three things that claim rests on:
//
//   1. the emitted GPU source really contains the predicate (WGSL *and* the GLSL twin);
//   2. the CPU backend agrees with the predicate's meaning, swept over values that straddle
//      every threshold — the differential gate, compared on the SAME SCALAR (never on the same
//      location: soundings sample nearest-cell and the ramp samples bilinear, so a
//      location-keyed comparison would be measuring the sampler, not the predicate);
//   3. everything outside the compilable subset is refused WITH A REASON — the whole defect
//      class here is a filter that compiles and silently does nothing.

import { describe, it, expect } from 'vitest'
import { Lexer, Parser, lower } from '@xgis/compiler'
import type * as AST from '@xgis/compiler'
import { emitModule, emitGlslModule, compileModuleJs, compileModule } from '@xgis/shader-dsl'
import { compileCoverageFilter, coverageFilterModule, COVERAGE_FILTER_FN } from './coverage-filter'
import { buildCoverageModule } from './coverage-ramp'

/** Lower a real `filter:` clause and hand back the AST the runtime reads — the same helper
 *  shape `coverage-sounding-filter.test.ts` uses, for the same reason: a filter the language
 *  accepts but this compiler mishandles is exactly the bug being gated, and a hand-built AST
 *  would test the compiler against my idea of the parser rather than against the parser. */
function filterAst(src: string): AST.Expr {
  const scene = lower(
    new Parser(
      new Lexer(
        `xgis 1\nsource s { type: geojson }\nlayer l { source: s, filter: ${src} | fill-red-500 }\n`,
      ).tokenize(),
    ).parse(),
  )
  const node = scene.renderNodes.find((n) => n.name === 'l')
  if (!node?.filter) throw new Error(`filter did not lower for: ${src}`)
  return node.filter.ast as AST.Expr
}

/** Compile, asserting success — most tests are about a predicate that DOES compile. */
function ok(src: string) {
  const r = compileCoverageFilter(filterAst(src))
  if (!r.ok) throw new Error(`expected \`${src}\` to compile, refused: ${r.reason}`)
  return r
}

/** Evaluate the compiled predicate on the CPU, through the DSL's own backend. */
function cpu(src: string): (v: number, zoom?: number) => boolean {
  const m = compileModuleJs(coverageFilterModule(ok(src)))
  return (v, zoom = 0) => m.fns[COVERAGE_FILTER_FN]!(v, zoom) as boolean
}

describe('coverage filter — the predicate reaches the GPU', () => {
  it('emits a bool-returning cov_filter into BOTH backends', () => {
    const mod = coverageFilterModule(ok('.depth > 20.0'))
    const wgsl = emitModule(mod)
    const glsl = emitGlslModule(mod, 'fragment')
    // Non-vacuity for every render assertion downstream: an emitted module that does not
    // actually contain the function would leave a pixel gate trivially green.
    expect(wgsl).toContain(COVERAGE_FILTER_FN)
    expect(wgsl).toMatch(/fn cov_filter\([^)]*\)\s*->\s*bool/)
    expect(glsl).toContain(COVERAGE_FILTER_FN)
    expect(glsl).toMatch(/bool cov_filter\(/)
  })

  it('takes the band value and zoom as parameters, in RAW units', () => {
    // No literal rewriting into normalized [0,1] space: 20 stays 20 in the emitted source, so
    // the GPU tests the same quantity the CPU does. A normalized rewrite would be the second
    // authority this whole design exists to avoid.
    const wgsl = emitModule(coverageFilterModule(ok('.depth > 20.0')))
    expect(wgsl).toMatch(/20\.0*\b/)
  })

  it('keys on the predicate, so two layers cannot share the wrong pipeline', () => {
    expect(ok('.depth > 20.0').key).toBe(ok('.depth > 20.0').key)
    expect(ok('.depth > 20.0').key).not.toBe(ok('.depth > 30.0').key)
    expect(ok('.depth > 20.0').key).not.toBe(ok('.depth >= 20.0').key)
    // Structure, not source text: whitespace is not part of the key.
    expect(ok('.depth>20.0').key).toBe(ok('.depth > 20.0').key)
  })

  it('reports the band it reads, which is what the drape must be draping', () => {
    expect(ok('.depth > 20.0').band).toBe('depth')
    expect(ok('.speed * 2.0 < 10.0').band).toBe('speed')
  })
})

describe('coverage filter — the drape composes it, and is untouched without one', () => {
  /** The fragment ENTRY's body, helpers above it excluded. WGSL keeps the authored entry
   *  name; GLSL ES has one entry per unit and it IS `main()` — since #1858 the emitter no
   *  longer wraps the body in the `CovFragOut fs_cov_impl(...)` fn this used to anchor on. */
  const fsOf = (src: string): string => {
    const at = src.indexOf('fn fs_cov')
    return at >= 0 ? src.slice(at) : src.slice(src.indexOf('void main()'))
  }

  it('an UNFILTERED drape emits the fragment body it always did', () => {
    // The load-bearing no-op. Every existing coverage renders through this shader, so the
    // filter must be absent — not inert — when no layer declares one. `cov_data` is in the
    // uniform BLOCK unconditionally (one std140 layout beats two), but nothing reads it.
    const wgsl = emitModule(buildCoverageModule())
    const glsl = emitGlslModule(buildCoverageModule(), 'fragment')
    for (const [name, src] of [
      ['WGSL', wgsl],
      ['GLSL', glsl],
    ] as const) {
      expect(fsOf(src), `${name}: no predicate call`).not.toContain(COVERAGE_FILTER_FN)
      expect(fsOf(src), `${name}: nothing reads the filter uniforms`).not.toContain('cov_data')
    }
  })

  it('a FILTERED drape calls the predicate on RAW units and discards on reject', () => {
    const wgsl = emitModule(buildCoverageModule(ok('.depth > 20.0').decl))
    const body = fsOf(wgsl)
    // Denormalized at the call site — `min + s'·span`, not the stored [0,1] fraction. This is
    // the assertion that keeps the GPU testing the same quantity the CPU does.
    expect(body).toMatch(
      new RegExp(
        `${COVERAGE_FILTER_FN}\\(\\(u\\.cov_data\\.x \\+ \\(\\w+ \\* u\\.cov_data\\.y\\)\\), u\\.cov_data\\.z\\)`,
      ),
    )
    // Two discards now: the pre-existing validity test, and the filter. They are deliberately
    // NOT folded — the validity test gates the division that produces the predicate's operand,
    // so a merged condition would evaluate the predicate on the ±Inf/NaN of an invalid texel.
    expect(body.match(/discard/g)?.length).toBe(2)
    // ...and in that order, which is what makes the separation meaningful.
    expect(body.indexOf('discard')).toBeLessThan(body.indexOf(COVERAGE_FILTER_FN))
  })

  it('the GLSL twin carries the same predicate', () => {
    const glsl = emitGlslModule(buildCoverageModule(ok('.depth > 20.0').decl), 'fragment')
    expect(glsl).toMatch(/bool cov_filter\(float v, float zoom\)/)
    expect(fsOf(glsl)).toContain(COVERAGE_FILTER_FN)
  })
})

describe('coverage filter — CPU and GPU cannot drift, because there is one IR', () => {
  it('the js backend agrees with the interpreter (the DSL bit-identity contract)', () => {
    // If these two ever disagree the differential sweep below is measuring nothing, so assert
    // the contract holds for THIS module before leaning on it.
    const mod = coverageFilterModule(ok('.depth > 20.0 && .depth < 30.0'))
    const js = compileModuleJs(mod)
    const interp = compileModule(mod)
    for (const v of [-1, 0, 19.999, 20, 20.001, 25, 29.999, 30, 30.001, 1e9]) {
      expect(js.fns[COVERAGE_FILTER_FN]!(v, 0)).toBe(interp.fns[COVERAGE_FILTER_FN]!(v, 0))
    }
  })

  it('evaluates comparisons, arithmetic and boolean combination on raw values', () => {
    const gt = cpu('.depth > 0.0')
    expect(gt(0)).toBe(false)
    expect(gt(0.001)).toBe(true)
    expect(gt(-5)).toBe(false)

    const band = cpu('.depth >= 10.0 && .depth <= 20.0')
    expect(band(9.999)).toBe(false)
    expect(band(10)).toBe(true)
    expect(band(20)).toBe(true)
    expect(band(20.001)).toBe(false)

    const either = cpu('.depth < 5.0 || .depth > 50.0')
    expect(either(1)).toBe(true)
    expect(either(25)).toBe(false)
    expect(either(60)).toBe(true)

    const arith = cpu('.depth * 2.0 - 4.0 > 6.0')
    expect(arith(5)).toBe(false) // 2·5−4 = 6, not > 6
    expect(arith(5.001)).toBe(true)

    expect(cpu('- .depth > 0.0')(-3)).toBe(true)
    expect(cpu('!(.depth > 0.0)')(-3)).toBe(true)
    expect(cpu('!(.depth > 0.0)')(3)).toBe(false)
  })

  it('sees the live camera zoom, so the two arms cannot disagree about it', () => {
    // The sounding arm already threads camera zoom into its filter. Dropping zoom from the GPU
    // subset would have reproduced the exact split-brain this change removes.
    const zoomed = cpu('.depth > 0.0 && zoom >= 12.0')
    expect(zoomed(5, 11)).toBe(false)
    expect(zoomed(5, 12)).toBe(true)
    expect(zoomed(-5, 14)).toBe(false)
  })

  it('is exact at the threshold, on both sides of it', () => {
    // The predicate itself introduces no tolerance. The known CPU/GPU disagreements are f16
    // STORAGE and the nearest-vs-bilinear SAMPLER (see the module header) — neither of which
    // is the predicate's doing, and neither of which this gate should be papering over.
    const at = cpu('.depth > 20.0')
    expect(at(19.9999)).toBe(false)
    expect(at(20)).toBe(false)
    expect(at(20.0001)).toBe(true)
  })
})

describe('coverage filter — every refusal names its reason', () => {
  const refuses = (src: string, match: RegExp): void => {
    const r = compileCoverageFilter(filterAst(src))
    expect(r.ok, `expected \`${src}\` to be refused`).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(match)
  }

  it('refuses a second band — the GPU arm binds ONE data texture', () => {
    refuses('.speed > 1.0 && .direction < 180.0', /2 bands \(speed, direction\)/)
  })

  it('refuses a bare value instead of a comparison', () => {
    refuses('.depth', /must be a comparison/)
  })

  it('refuses a predicate that reads no band at all', () => {
    refuses('zoom > 10.0', /reads no band/)
  })

  it('refuses a unit, rather than dropping it and comparing metres to pixels', () => {
    refuses('.depth > 20m', /unit/)
  })

  it('refuses operands and forms a grid cannot express', () => {
    // Both reach the walk's default arm, which names the AST kind rather than saying
    // "unsupported" — the reason is what tells an author whether the limit still holds.
    refuses('.depth == "deep"', /StringLiteral/)
    refuses('round(.depth) > 2.0', /FnCall/)
  })

  it('refuses a type-confused predicate instead of coercing it', () => {
    refuses('.depth > 0.0 && .depth', /wants a boolean/)
    refuses('true > 1.0', /wants a number/)
  })
})
