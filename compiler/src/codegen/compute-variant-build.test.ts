// ═══════════════════════════════════════════════════════════════════
// compute-variant-build.ts — per-show merged variant helper tests
// ═══════════════════════════════════════════════════════════════════

import { describe, expect, it } from 'vitest'
import { buildPerShowMergedVariant } from './compute-variant-build'
import { emitMatchComputeKernel } from './compute-gen'
import type { ShaderVariant } from './shader-gen'
import type { ComputePlanEntry } from './compute-plan'

function makeLegacyVariant(overrides: Partial<ShaderVariant> = {}): ShaderVariant {
  return {
    key: 'legacy',
    preamble: '',
    fillExpr: 'u.fill_color',
    strokeExpr: 'u.stroke_color',
    needsFeatureBuffer: false,
    featureFields: [],
    uniformFields: ['mvp', 'proj_params', 'fill_color', 'stroke_color'],
    categoryOrder: {},
    paletteColorGradients: [],
    fillUsesPalette: false,
    strokeUsesPalette: false,
    ...overrides,
  }
}

function makeMatchEntry(field: string, renderNodeIndex: number, paintAxis: 'fill' | 'stroke-color' = 'fill'): ComputePlanEntry {
  const kernel = emitMatchComputeKernel({
    fieldName: field,
    arms: [{ pattern: 'a', colorHex: '#ff0000' }],
    defaultColorHex: '#000000',
  })
  return {
    renderNodeIndex, paintAxis, kernel,
    fieldOrder: kernel.fieldOrder,
    categoryOrder: kernel.categoryOrder ?? {},
  }
}

describe('buildPerShowMergedVariant', () => {
  it('plan undefined → returns variant by reference (identity)', () => {
    const v = makeLegacyVariant()
    const out = buildPerShowMergedVariant(v, undefined, 0, 0, 1)
    expect(out).toBe(v)
  })

  it('plan empty array → returns variant by reference', () => {
    const v = makeLegacyVariant()
    const out = buildPerShowMergedVariant(v, [], 0, 0, 1)
    expect(out).toBe(v)
  })

  it('plan has entries but none target this renderNodeIndex → identity', () => {
    const v = makeLegacyVariant()
    const plan = [makeMatchEntry('class', 1)]
    const out = buildPerShowMergedVariant(v, plan, 5, 0, 1)
    expect(out).toBe(v)
  })

  it('matching entry → merged variant with compute fillExpr', () => {
    const v = makeLegacyVariant()
    const plan = [makeMatchEntry('class', 7)]
    const out = buildPerShowMergedVariant(v, plan, 7, 0, 1)
    expect(out).not.toBe(v)
    expect(out.fillExpr).toContain('unpack4x8unorm(compute_out_fill')
  })

  it('filters out other shows; only entries for renderNodeIndex contribute', () => {
    const v = makeLegacyVariant()
    const plan = [
      makeMatchEntry('a', 0, 'fill'),         // other show, ignored
      makeMatchEntry('b', 1, 'fill'),         // this show
      makeMatchEntry('c', 2, 'stroke-color'), // other show, ignored
    ]
    const out = buildPerShowMergedVariant(v, plan, 1, 0, 1)
    expect(out.fillExpr).toContain('unpack4x8unorm')
    // Only one binding allocated (for 'b'), the stroke entry for
    // index 2 didn't filter in.
    expect(out.strokeExpr).toBe('u.stroke_color')
  })

  it('multiple entries for same show → both bindings in preamble', () => {
    const v = makeLegacyVariant()
    const plan = [
      makeMatchEntry('a', 3, 'fill'),
      makeMatchEntry('b', 3, 'stroke-color'),
    ]
    const out = buildPerShowMergedVariant(v, plan, 3, 0, 5)
    expect(out.fillExpr).toContain('compute_out_fill')
    expect(out.strokeExpr).toContain('compute_out_stroke')
    expect(out.preamble).toContain('@binding(5)')
    expect(out.preamble).toContain('@binding(6)')
  })

  it('passes through bindGroup + baseBinding to the addendum', () => {
    const v = makeLegacyVariant()
    const plan = [makeMatchEntry('class', 0)]
    const out = buildPerShowMergedVariant(v, plan, 0, 2, 9)
    expect(out.preamble).toContain('@group(2) @binding(9)')
  })

  it('cache key is extended for merged variant; identity case preserves key', () => {
    const v = makeLegacyVariant({ key: 'legacy-A' })
    const plan1 = [makeMatchEntry('class', 0)]
    const merged = buildPerShowMergedVariant(v, plan1, 0, 0, 1)
    expect(merged.key).not.toBe('legacy-A')
    expect(merged.key).toContain('legacy-A')

    // Identity path: key unchanged.
    const same = buildPerShowMergedVariant(v, [], 0, 0, 1)
    expect(same.key).toBe('legacy-A')
  })

  it('does not mutate the input variant', () => {
    const v = makeLegacyVariant({ uniformFields: ['mvp', 'fill_color'] })
    const plan = [makeMatchEntry('class', 0)]
    buildPerShowMergedVariant(v, plan, 0, 0, 1)
    expect(v.uniformFields).toEqual(['mvp', 'fill_color'])
    expect(v.fillExpr).toBe('u.fill_color')
  })
})
