// ═══════════════════════════════════════════════════════════════════
// compute-variant-merge.ts — merge function tests
// ═══════════════════════════════════════════════════════════════════

import { describe, expect, it } from 'vitest'
import { mergeComputeAddendumIntoVariant } from './compute-variant-merge'
import { buildComputeVariantAddendum } from './compute-variant'
import { emitMatchComputeKernel } from './compute-gen'
import type { ShaderVariant } from './shader-gen'
import type { ComputePlanEntry } from './compute-plan'
import type { ComputeVariantAddendum } from './compute-variant'
import { nodeToWgslString } from './node-to-wgsl'

// Phase 2.5 US-004 — fillExpr / strokeExpr migrated to NodeLike|null.
function fillStr(v: ShaderVariant): string {
  return v.fillExpr ? nodeToWgslString(v.fillExpr) : 'u.fill_color'
}
function strokeStr(v: ShaderVariant): string {
  return v.strokeExpr ? nodeToWgslString(v.strokeExpr) : 'u.stroke_color'
}

function makeLegacyVariant(overrides: Partial<ShaderVariant> = {}): ShaderVariant {
  return {
    key: 'legacy-key',
    preamble: {},
    // Phase 2.5 US-004 — Node-typed fields; `null` paired with
    // fillIsDefault: true is the default-uniform placeholder.
    fillExpr: null,
    strokeExpr: null,
    needsFeatureBuffer: false,
    featureFields: [],
    uniformFields: ['mvp', 'proj_params', 'fill_color', 'stroke_color'],
    categoryOrder: {},
    paletteColorGradients: [],
    paletteScalarGradients: [],
    fillUsesPalette: false,
    strokeUsesPalette: false,
    opacityUsesPalette: false,
    // Phase 2.5 US-002 — default-fill/stroke sentinel flags. Set to true
    // here to mirror the legacy `fillExpr: 'u.fill_color'` placeholder.
    // Tests that override fillExpr to a non-default value should also
    // flip these to false via the `overrides` spread.
    fillIsDefault: true,
    strokeIsDefault: true,
    ...overrides,
  }
}

function makeFillEntry(): ComputePlanEntry {
  const kernel = emitMatchComputeKernel({
    fieldName: 'class',
    arms: [{ pattern: 'a', colorHex: '#ff0000' }],
    defaultColorHex: '#000000',
  })
  return {
    renderNodeIndex: 0,
    paintAxis: 'fill',
    kernel,
    fieldOrder: kernel.fieldOrder,
    categoryOrder: kernel.categoryOrder ?? {},
  }
}

function makeStrokeEntry(): ComputePlanEntry {
  const kernel = emitMatchComputeKernel({
    fieldName: 'rank',
    arms: [{ pattern: 'a', colorHex: '#00ff00' }],
    defaultColorHex: '#000000',
  })
  return {
    renderNodeIndex: 0,
    paintAxis: 'stroke-color',
    kernel,
    fieldOrder: kernel.fieldOrder,
    categoryOrder: kernel.categoryOrder ?? {},
  }
}

describe('mergeComputeAddendumIntoVariant — empty addendum (no-op)', () => {
  it('empty entries → returns variant unchanged (identity preserved)', () => {
    const v = makeLegacyVariant()
    const addendum = buildComputeVariantAddendum([], 0, 0)
    const merged = mergeComputeAddendumIntoVariant(v, addendum)
    expect(merged).toBe(v) // exact identity, no allocation
  })
})

describe('mergeComputeAddendumIntoVariant — fill override', () => {
  it('replaces fillExpr with compute read; legacy strokeExpr untouched', () => {
    const v = makeLegacyVariant()
    const addendum = buildComputeVariantAddendum([makeFillEntry()], 0, 1)
    const merged = mergeComputeAddendumIntoVariant(v, addendum)
    expect(fillStr(merged)).toContain('unpack4x8unorm(compute_out_fill')
    expect(strokeStr(merged)).toBe('u.stroke_color')
  })

  it('prunes fill_color from uniformFields (runtime skips per-frame write)', () => {
    const v = makeLegacyVariant({
      uniformFields: ['mvp', 'proj_params', 'fill_color', 'stroke_color', 'opacity'],
    })
    const addendum = buildComputeVariantAddendum([makeFillEntry()], 0, 1)
    const merged = mergeComputeAddendumIntoVariant(v, addendum)
    expect(merged.uniformFields).toEqual(['mvp', 'proj_params', 'stroke_color', 'opacity'])
  })

  it('appends addendum bindings after the legacy preamble consts', () => {
    const fillColor = {
      name: 'X',
      type: { kind: 'scalar', scalar: 'f32' },
      wgslValue: 1,
      cpuValue: 1,
    } as const
    const v = makeLegacyVariant({
      preamble: { consts: [fillColor] },
    })
    const addendum = buildComputeVariantAddendum([makeFillEntry()], 2, 5)
    const merged = mergeComputeAddendumIntoVariant(v, addendum)
    expect(merged.preamble.consts).toEqual([fillColor])
    expect(merged.preamble.bindings).toHaveLength(1)
    expect(merged.preamble.bindings![0]).toMatchObject({
      group: 2,
      binding: 5,
      name: 'compute_out_fill',
    })
  })

  it('empty legacy preamble → addendum bindings become the only bindings', () => {
    const v = makeLegacyVariant({ preamble: {} })
    const addendum = buildComputeVariantAddendum([makeFillEntry()], 0, 1)
    const merged = mergeComputeAddendumIntoVariant(v, addendum)
    expect(merged.preamble.bindings).toHaveLength(1)
    expect(merged.preamble.bindings![0]).toMatchObject({ group: 0, binding: 1 })
  })
})

describe('mergeComputeAddendumIntoVariant — stroke override', () => {
  it('replaces strokeExpr; legacy fillExpr untouched', () => {
    const v = makeLegacyVariant()
    const addendum = buildComputeVariantAddendum([makeStrokeEntry()], 0, 1)
    const merged = mergeComputeAddendumIntoVariant(v, addendum)
    expect(strokeStr(merged)).toContain('unpack4x8unorm(compute_out_stroke')
    expect(fillStr(merged)).toBe('u.fill_color')
  })

  it('prunes stroke_color from uniformFields', () => {
    const v = makeLegacyVariant()
    const addendum = buildComputeVariantAddendum([makeStrokeEntry()], 0, 1)
    const merged = mergeComputeAddendumIntoVariant(v, addendum)
    expect(merged.uniformFields).not.toContain('stroke_color')
    expect(merged.uniformFields).toContain('fill_color')
  })
})

describe('mergeComputeAddendumIntoVariant — both axes', () => {
  it('overrides both fillExpr and strokeExpr', () => {
    const v = makeLegacyVariant()
    const addendum = buildComputeVariantAddendum([makeFillEntry(), makeStrokeEntry()], 0, 1)
    const merged = mergeComputeAddendumIntoVariant(v, addendum)
    expect(fillStr(merged)).toContain('compute_out_fill')
    expect(strokeStr(merged)).toContain('compute_out_stroke')
  })

  it('prunes both uniformFields', () => {
    const v = makeLegacyVariant()
    const addendum = buildComputeVariantAddendum([makeFillEntry(), makeStrokeEntry()], 0, 1)
    const merged = mergeComputeAddendumIntoVariant(v, addendum)
    expect(merged.uniformFields).not.toContain('fill_color')
    expect(merged.uniformFields).not.toContain('stroke_color')
  })
})

describe('mergeComputeAddendumIntoVariant — cache key', () => {
  it('extends the key with the compute binding fingerprint', () => {
    const v = makeLegacyVariant({ key: 'legacy-A' })
    const addendum = buildComputeVariantAddendum([makeFillEntry()], 2, 3)
    const merged = mergeComputeAddendumIntoVariant(v, addendum)
    // Fingerprint = "f2.3" (paintAxis first letter + group.binding)
    expect(merged.key).toBe('legacy-A|c:f2.3')
  })

  it('fingerprint sorts (group, binding) so order-independent merges hash the same', () => {
    const v = makeLegacyVariant({ key: 'L' })
    // Same set of bindings, different insertion order.
    const a1: ComputeVariantAddendum = {
      bindingDecls: [],
      fillExpr: 'F',
      strokeExpr: 'S',
      bindGroupEntries: [],
      bindings: [
        { paintAxis: 'stroke-color', bindGroup: 0, binding: 2 },
        { paintAxis: 'fill', bindGroup: 0, binding: 1 },
      ],
    }
    const a2: ComputeVariantAddendum = {
      bindingDecls: [],
      fillExpr: 'F',
      strokeExpr: 'S',
      bindGroupEntries: [],
      bindings: [
        { paintAxis: 'fill', bindGroup: 0, binding: 1 },
        { paintAxis: 'stroke-color', bindGroup: 0, binding: 2 },
      ],
    }
    const k1 = mergeComputeAddendumIntoVariant(v, a1).key
    const k2 = mergeComputeAddendumIntoVariant(v, a2).key
    expect(k1).toBe(k2)
  })

  it('empty addendum → key unchanged (identity path)', () => {
    const v = makeLegacyVariant({ key: 'unchanged' })
    const merged = mergeComputeAddendumIntoVariant(v, buildComputeVariantAddendum([], 0, 0))
    expect(merged.key).toBe('unchanged')
  })
})

describe('mergeComputeAddendumIntoVariant — computeBindings surface', () => {
  it('absent on identity (empty addendum) merge', () => {
    const v = makeLegacyVariant()
    const merged = mergeComputeAddendumIntoVariant(v, buildComputeVariantAddendum([], 0, 0))
    // Identity path returns the input verbatim; legacy variants
    // never carry computeBindings.
    expect(merged.computeBindings).toBeUndefined()
  })

  it('populated on fill merge (one binding, axis=fill)', () => {
    const v = makeLegacyVariant()
    const addendum = buildComputeVariantAddendum([makeFillEntry()], 2, 5)
    const merged = mergeComputeAddendumIntoVariant(v, addendum)
    expect(merged.computeBindings).toBeDefined()
    expect(merged.computeBindings!.length).toBe(1)
    expect(merged.computeBindings![0]!.paintAxis).toBe('fill')
    expect(merged.computeBindings![0]!.bindGroup).toBe(2)
    expect(merged.computeBindings![0]!.binding).toBe(5)
  })

  it('populated on fill + stroke merge with sequential bindings', () => {
    const v = makeLegacyVariant()
    const addendum = buildComputeVariantAddendum([makeFillEntry(), makeStrokeEntry()], 0, 3)
    const merged = mergeComputeAddendumIntoVariant(v, addendum)
    expect(merged.computeBindings!.map((b) => b.binding)).toEqual([3, 4])
    expect(merged.computeBindings!.map((b) => b.paintAxis)).toEqual(['fill', 'stroke-color'])
  })

  it('runtime "compute layout needed?" check is a single property test', () => {
    // The intended runtime usage — variant.computeBindings is the
    // signal to switch to the compute-aware bind-group layout.
    const legacy = makeLegacyVariant()
    expect(legacy.computeBindings).toBeUndefined()

    const merged = mergeComputeAddendumIntoVariant(
      legacy,
      buildComputeVariantAddendum([makeFillEntry()], 0, 1),
    )
    expect(merged.computeBindings).toBeDefined()
    expect(Boolean(merged.computeBindings)).toBe(true)
  })

  it('addendum bindings are copied (defensive — caller can mutate the addendum)', () => {
    const v = makeLegacyVariant()
    const addendum = buildComputeVariantAddendum([makeFillEntry()], 0, 1)
    const merged = mergeComputeAddendumIntoVariant(v, addendum)
    // Mutating the addendum's bindings array after merge must NOT
    // affect the merged variant.
    ;(addendum.bindings as { binding: number }[])[0]!.binding = 99
    expect(merged.computeBindings![0]!.binding).toBe(1)
  })
})

describe('mergeComputeAddendumIntoVariant — invariant preservation', () => {
  it('does not mutate the original variant', () => {
    const v = makeLegacyVariant({
      uniformFields: ['mvp', 'fill_color'],
    })
    const addendum = buildComputeVariantAddendum([makeFillEntry()], 0, 1)
    mergeComputeAddendumIntoVariant(v, addendum)
    expect(v.uniformFields).toEqual(['mvp', 'fill_color']) // untouched
    expect(fillStr(v)).toBe('u.fill_color') // untouched
  })

  it('preserves needsFeatureBuffer / featureFields / palette fields', () => {
    const v = makeLegacyVariant({
      needsFeatureBuffer: true,
      featureFields: ['some_other_field'],
      paletteColorGradients: [3],
      fillUsesPalette: true,
    })
    const addendum = buildComputeVariantAddendum([makeFillEntry()], 0, 1)
    const merged = mergeComputeAddendumIntoVariant(v, addendum)
    expect(merged.needsFeatureBuffer).toBe(true)
    expect(merged.featureFields).toEqual(['some_other_field'])
    expect(merged.paletteColorGradients).toEqual([3])
    expect(merged.fillUsesPalette).toBe(true)
  })
})
