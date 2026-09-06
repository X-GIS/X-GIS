// ═══ #2572 — split-bind eligibility is decided from the IR, per ENTRY PAIR ═══
//
// The mechanism this pins was INERT before #2572: both probes (PipelineFactory.
// perStyleSplitTwin, LineDraper.splitEligible) regexed `@group(0) @binding(N)` out
// of the EMITTED module and required the result ⊆ {7,10,11}. One module carries
// every entry point, so that text is their UNION — and `fs_fill_pattern` /
// `fs_line_pattern` sample the sprite atlas, putting bindings 5 and 6 in the text
// of every polygon and line module, the base ones included. The condition was
// therefore unsatisfiable for any variant, and no styled fill or stroke ever took
// the split path. Nothing on screen could show it: the legacy bind is correct.
//
// `fitsSplitLayout` asks the question a driver actually answers — which bindings do
// THESE entry points statically reach — so the rows below are the discrimination
// the check exists for: the fill/stroke pairs fit, the pattern pairs do not.
// A check that said "eligible" to everything would be the same bug mirrored.
//
// Pure IR (no emit, no GPU); rides the `test (map)` leg.

import { describe, it, expect } from 'vitest'
import { Node, reachFrom, vec4fT } from '@xgis/shader-dsl'
import type { PolygonVariantSpec } from './polygon'
import type { LineVariantSpec } from './line'
import { buildPolygonSplitModule, emitPolygonSplitWgsl, fitsSplitLayout } from './polygon-split'
import { buildLineSplitModule } from './line-split'

/** A style-derived fill/stroke colour — the shape the compiler hands the composer. */
const constantColorExpr = (name: string): Node<'vec4<f32>'> =>
  new Node<'vec4<f32>'>({ op: 'varref', type: vec4fT, name })

const polygonVariant = (needsFeatureBuffer: boolean): PolygonVariantSpec => ({
  preamble: null,
  fillExpr: constantColorExpr('fill_color_const'),
  strokeExpr: null,
  fillPreamble: null,
  strokePreamble: null,
  needsFeatureBuffer,
})

const lineVariant = (): LineVariantSpec => ({
  preamble: null,
  strokeExpr: constantColorExpr('stroke_color_const'),
  strokePreamble: null,
  needsFeatureBuffer: false,
})

// The entry pairs the split Materials are actually built with — see
// polygon-fill-material.ts (`FILL_ENTRY_POINTS`) and line-material.ts
// (`LINE_SPLIT_ENTRY_POINTS`). Restated here as literals ON PURPOSE: a test that
// imported them could not notice a pair silently changing under it.
const FILL_PAIR = ['vs_main_ecef', 'fs_fill']
const FILL_PATTERN_PAIR = ['vs_main_ecef', 'fs_fill_pattern']
const LINE_PAIR = ['vs_line', 'fs_line']
const LINE_PATTERN_PAIR = ['vs_line', 'fs_line_pattern']

describe('#2572 — the split twin is reachable: eligibility comes from the IR', () => {
  it('polygon: every fill variant fits on the fill pair — the rows that were all false', () => {
    for (const pick of [false, true]) {
      for (const [label, variant] of [
        ['base', null],
        ['constant fill', polygonVariant(false)],
        ['feature-buffer fill', polygonVariant(true)],
      ] as const) {
        const m = buildPolygonSplitModule(variant, pick)
        expect(fitsSplitLayout(m, FILL_PAIR), `${label} / pick=${pick}`).toBe(true)
      }
    }
  })

  it('the walk actually REACHES the three blocks — a zero here would fit any layout', () => {
    // `fitsSplitLayout` is a NEGATIVE test (nothing outside the blocks), so a walk
    // that found nothing would answer `true` for every pipeline. Assert the positive
    // half once, on the pair the split Materials use, so the instrument is checked
    // against a known result rather than trusted.
    const m = buildPolygonSplitModule(null, false)
    const entries = FILL_PAIR.map((n) => m.funcs.find((f) => f.name === n)!)
    const reached = reachFrom(m, entries).bindings
    for (const u of ['frame', 'show', 'tile']) expect([...reached]).toContain(u)
  })

  it('polygon: the PATTERN pair does not fit — the check discriminates', () => {
    // The sprite atlas (5/6) is declared in every polygon module and reached only
    // here. This row is why "always eligible" is the wrong fix.
    for (const variant of [null, polygonVariant(false), polygonVariant(true)]) {
      const m = buildPolygonSplitModule(variant, false)
      expect(fitsSplitLayout(m, FILL_PATTERN_PAIR)).toBe(false)
    }
  })

  it('line: base AND variant strokes fit on the stroke pair; the pattern pair does not', () => {
    for (const pick of [false, true]) {
      for (const [label, variant] of [
        ['base', null],
        ['variant stroke', lineVariant()],
      ] as const) {
        const m = buildLineSplitModule(variant, pick)
        expect(fitsSplitLayout(m, LINE_PAIR), `${label} / pick=${pick}`).toBe(true)
        expect(fitsSplitLayout(m, LINE_PATTERN_PAIR), `${label} / pick=${pick}`).toBe(false)
      }
    }
  })

  it('an entry name the module does not have THROWS — it must never read as eligible', () => {
    // The one way this check could pass a pipeline it never looked at: an unknown
    // entry reaches nothing, and the empty set fits every layout. Both call sites
    // wrap the build in a `try` (a needsFeatureBuffer LINE variant throws from
    // buildLineModule, #1605 Phase 1b), so a throw degrades to INELIGIBLE — the
    // safe direction — while silence would degrade to eligible.
    const m = buildPolygonSplitModule(null, false)
    expect(() => fitsSplitLayout(m, ['vs_main_ecef', 'fs_fil'])).toThrow(/no entry point 'fs_fil'/)
    expect(() => fitsSplitLayout(m, ['vs_typo', 'fs_fill'])).toThrow(/no entry point 'vs_typo'/)
  })

  it('the old TEXT-based test says false for every one of those rows — the fail-before', () => {
    // Reproduce the retired probe verbatim over the emitted module and show it
    // disagreeing with the driver on the exact pipelines this issue is about. Kept
    // as a witness so a future "simplify" back to the regex reds here rather than
    // silently re-parking the split path.
    const textFits = (wgsl: string): boolean =>
      [...wgsl.matchAll(/@group\(0\)\s*@binding\((\d+)\)/g)]
        .map((mm) => Number(mm[1]))
        .every((b) => b === 7 || b === 10 || b === 11)
    for (const variant of [null, polygonVariant(false)]) {
      expect(textFits(emitPolygonSplitWgsl(variant, false))).toBe(false)
      expect(fitsSplitLayout(buildPolygonSplitModule(variant, false), FILL_PAIR)).toBe(true)
    }
  })
})
