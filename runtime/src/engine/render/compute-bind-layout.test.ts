// ═══════════════════════════════════════════════════════════════════
// compute-bind-layout.ts — extension + entry-build tests
// ═══════════════════════════════════════════════════════════════════

import { describe, expect, it } from 'vitest'
import {
  extendBindGroupLayoutEntriesForCompute,
  buildComputeBindGroupEntries,
} from '@xgis/rhi-webgpu'
import type { ShaderVariant } from '@xgis/compiler'
import { varRefVec4 } from '@xgis/compiler'

function legacyVariant(): ShaderVariant {
  return {
    key: 'L',
    preamble: {},
    fillExpr: varRefVec4('u.fill_color'),
    strokeExpr: varRefVec4('u.stroke_color'),
    needsFeatureBuffer: false,
    featureFields: [],
    uniformFields: [],
    categoryOrder: {},
    paletteColorGradients: [],
    paletteScalarGradients: [],
    fillUsesPalette: false,
    strokeUsesPalette: false,
    opacityUsesPalette: false,
    // Phase 2.5 US-002 — default-fill/stroke sentinel flag (replaces the
    // runtime's legacy `fillExpr === 'u.fill_color'` string compare).
    fillIsDefault: true,
    strokeIsDefault: true,
  }
}

function withComputeBindings(
  bindings: { paintAxis: 'fill' | 'stroke-color'; bindGroup: number; binding: number }[],
): ShaderVariant {
  return { ...legacyVariant(), computeBindings: bindings }
}

const FRAGMENT_BIT = 2 // GPUShaderStage.FRAGMENT

const LEGACY_ENTRIES: GPUBindGroupLayoutEntry[] = [
  { binding: 0, visibility: 3, buffer: { type: 'uniform' } },
  { binding: 1, visibility: 2, buffer: { type: 'read-only-storage' } },
]

describe('extendBindGroupLayoutEntriesForCompute', () => {
  it('legacy variant (no computeBindings) → returns input by reference', () => {
    const v = legacyVariant()
    const out = extendBindGroupLayoutEntriesForCompute(v, LEGACY_ENTRIES, FRAGMENT_BIT)
    expect(out).toBe(LEGACY_ENTRIES)
  })

  it('empty computeBindings array → returns input by reference', () => {
    const v = withComputeBindings([])
    const out = extendBindGroupLayoutEntriesForCompute(v, LEGACY_ENTRIES, FRAGMENT_BIT)
    expect(out).toBe(LEGACY_ENTRIES)
  })

  it('one fill binding → legacy + 1 read-only-storage entry at right slot', () => {
    const v = withComputeBindings([{ paintAxis: 'fill', bindGroup: 0, binding: 16 }])
    const out = extendBindGroupLayoutEntriesForCompute(v, LEGACY_ENTRIES, FRAGMENT_BIT)
    expect(out.length).toBe(3)
    expect(out[2]).toEqual({
      binding: 16,
      visibility: FRAGMENT_BIT,
      buffer: { type: 'read-only-storage' },
    })
  })

  it('preserves legacy entries verbatim', () => {
    const v = withComputeBindings([{ paintAxis: 'fill', bindGroup: 0, binding: 16 }])
    const out = extendBindGroupLayoutEntriesForCompute(v, LEGACY_ENTRIES, FRAGMENT_BIT)
    expect(out[0]).toEqual(LEGACY_ENTRIES[0])
    expect(out[1]).toEqual(LEGACY_ENTRIES[1])
  })

  it('does not mutate the legacy entries array', () => {
    const legacy = [...LEGACY_ENTRIES]
    const before = JSON.stringify(legacy)
    const v = withComputeBindings([{ paintAxis: 'fill', bindGroup: 0, binding: 16 }])
    extendBindGroupLayoutEntriesForCompute(v, legacy, FRAGMENT_BIT)
    expect(JSON.stringify(legacy)).toBe(before)
  })

  it('fill + stroke bindings → both entries in addendum order', () => {
    const v = withComputeBindings([
      { paintAxis: 'fill', bindGroup: 0, binding: 16 },
      { paintAxis: 'stroke-color', bindGroup: 0, binding: 17 },
    ])
    const out = extendBindGroupLayoutEntriesForCompute(v, LEGACY_ENTRIES, FRAGMENT_BIT)
    expect(out.length).toBe(4)
    expect(out[2]!.binding).toBe(16)
    expect(out[3]!.binding).toBe(17)
  })

  it('honours caller-supplied visibility bit (so tests can mock GPUShaderStage)', () => {
    const v = withComputeBindings([{ paintAxis: 'fill', bindGroup: 0, binding: 16 }])
    const out = extendBindGroupLayoutEntriesForCompute(v, LEGACY_ENTRIES, 999)
    expect(out[2]!.visibility).toBe(999)
  })
})

describe('buildComputeBindGroupEntries', () => {
  const FAKE_BUFFER_A = { _id: 'A' } as unknown as GPUBuffer
  const FAKE_BUFFER_B = { _id: 'B' } as unknown as GPUBuffer

  // The backend hands the lookup an OPAQUE output-slot index (the binding's
  // position in variant.computeBindings) — never a paint axis. Slot 0 is the
  // first binding, slot 1 the second, etc. The style-aware caller is what maps
  // a slot back to a paint axis (see compute-layer-handle.ts).
  function makeLookup(map: Record<string, GPUBuffer>) {
    return (idx: number, outSlot: number) => map[`${idx}:${outSlot}`] ?? null
  }

  it('legacy variant → empty entries (no work, caller still binds the legacy entries)', () => {
    const out = buildComputeBindGroupEntries(legacyVariant(), 0, () => null)
    expect(out).toEqual([])
  })

  it('one fill binding → one bind-group entry with the buffer at the right slot', () => {
    const v = withComputeBindings([{ paintAxis: 'fill', bindGroup: 0, binding: 16 }])
    const out = buildComputeBindGroupEntries(v, 0, makeLookup({ '0:0': FAKE_BUFFER_A }))
    expect(out).toEqual([{ binding: 16, resource: { buffer: FAKE_BUFFER_A } }])
  })

  it('fill + stroke → two entries at distinct slots', () => {
    const v = withComputeBindings([
      { paintAxis: 'fill', bindGroup: 0, binding: 16 },
      { paintAxis: 'stroke-color', bindGroup: 0, binding: 17 },
    ])
    const out = buildComputeBindGroupEntries(
      v,
      5,
      makeLookup({
        '5:0': FAKE_BUFFER_A, // slot 0 = first binding (fill)
        '5:1': FAKE_BUFFER_B, // slot 1 = second binding (stroke)
      }),
    )
    expect(out).toEqual([
      { binding: 16, resource: { buffer: FAKE_BUFFER_A } },
      { binding: 17, resource: { buffer: FAKE_BUFFER_B } },
    ])
  })

  it('missing buffer → null (caller falls back, no partial bind)', () => {
    const v = withComputeBindings([
      { paintAxis: 'fill', bindGroup: 0, binding: 16 },
      { paintAxis: 'stroke-color', bindGroup: 0, binding: 17 },
    ])
    const out = buildComputeBindGroupEntries(
      v,
      0,
      makeLookup({
        // only slot 0 (fill) present, slot 1 (stroke) missing
        '0:0': FAKE_BUFFER_A,
      }),
    )
    expect(out).toBeNull()
  })

  it('renderNodeIndex is plumbed into the lookup', () => {
    const v = withComputeBindings([{ paintAxis: 'fill', bindGroup: 0, binding: 16 }])
    // Lookup keyed by (index, slot); verifying index 7 reaches the lookup.
    const out = buildComputeBindGroupEntries(v, 7, (idx, outSlot) => {
      if (idx === 7 && outSlot === 0) return FAKE_BUFFER_A
      return null
    })
    expect(out).toEqual([{ binding: 16, resource: { buffer: FAKE_BUFFER_A } }])
  })
})
