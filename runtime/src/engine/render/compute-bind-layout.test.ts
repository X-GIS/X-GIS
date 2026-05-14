// ═══════════════════════════════════════════════════════════════════
// compute-bind-layout.ts — extension + entry-build tests
// ═══════════════════════════════════════════════════════════════════

import { describe, expect, it } from 'vitest'
import {
  extendBindGroupLayoutEntriesForCompute,
  buildComputeBindGroupEntries,
} from './compute-bind-layout'
import type { ShaderVariant } from '@xgis/compiler'

function legacyVariant(): ShaderVariant {
  return {
    key: 'L', preamble: '',
    fillExpr: 'u.fill_color', strokeExpr: 'u.stroke_color',
    needsFeatureBuffer: false,
    featureFields: [], uniformFields: [],
    categoryOrder: {},
    paletteColorGradients: [],
    fillUsesPalette: false, strokeUsesPalette: false,
  }
}

function withComputeBindings(bindings: { paintAxis: 'fill' | 'stroke-color'; bindGroup: number; binding: number }[]): ShaderVariant {
  return { ...legacyVariant(), computeBindings: bindings }
}

const FRAGMENT_BIT = 2  // GPUShaderStage.FRAGMENT

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
    const v = withComputeBindings([
      { paintAxis: 'fill', bindGroup: 0, binding: 16 },
    ])
    const out = extendBindGroupLayoutEntriesForCompute(v, LEGACY_ENTRIES, FRAGMENT_BIT)
    expect(out.length).toBe(3)
    expect(out[2]).toEqual({
      binding: 16,
      visibility: FRAGMENT_BIT,
      buffer: { type: 'read-only-storage' },
    })
  })

  it('preserves legacy entries verbatim', () => {
    const v = withComputeBindings([
      { paintAxis: 'fill', bindGroup: 0, binding: 16 },
    ])
    const out = extendBindGroupLayoutEntriesForCompute(v, LEGACY_ENTRIES, FRAGMENT_BIT)
    expect(out[0]).toEqual(LEGACY_ENTRIES[0])
    expect(out[1]).toEqual(LEGACY_ENTRIES[1])
  })

  it('does not mutate the legacy entries array', () => {
    const legacy = [...LEGACY_ENTRIES]
    const before = JSON.stringify(legacy)
    const v = withComputeBindings([
      { paintAxis: 'fill', bindGroup: 0, binding: 16 },
    ])
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
    const v = withComputeBindings([
      { paintAxis: 'fill', bindGroup: 0, binding: 16 },
    ])
    const out = extendBindGroupLayoutEntriesForCompute(v, LEGACY_ENTRIES, 999)
    expect(out[2]!.visibility).toBe(999)
  })
})

describe('buildComputeBindGroupEntries', () => {
  const FAKE_BUFFER_A = { _id: 'A' } as unknown as GPUBuffer
  const FAKE_BUFFER_B = { _id: 'B' } as unknown as GPUBuffer

  function makeLookup(map: Record<string, GPUBuffer>) {
    return (idx: number, axis: 'fill' | 'stroke-color') => map[`${idx}:${axis}`] ?? null
  }

  it('legacy variant → empty entries (no work, caller still binds the legacy entries)', () => {
    const out = buildComputeBindGroupEntries(legacyVariant(), 0, () => null)
    expect(out).toEqual([])
  })

  it('one fill binding → one bind-group entry with the buffer at the right slot', () => {
    const v = withComputeBindings([
      { paintAxis: 'fill', bindGroup: 0, binding: 16 },
    ])
    const out = buildComputeBindGroupEntries(v, 0, makeLookup({ '0:fill': FAKE_BUFFER_A }))
    expect(out).toEqual([
      { binding: 16, resource: { buffer: FAKE_BUFFER_A } },
    ])
  })

  it('fill + stroke → two entries at distinct slots', () => {
    const v = withComputeBindings([
      { paintAxis: 'fill', bindGroup: 0, binding: 16 },
      { paintAxis: 'stroke-color', bindGroup: 0, binding: 17 },
    ])
    const out = buildComputeBindGroupEntries(v, 5, makeLookup({
      '5:fill': FAKE_BUFFER_A,
      '5:stroke-color': FAKE_BUFFER_B,
    }))
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
    const out = buildComputeBindGroupEntries(v, 0, makeLookup({
      // only fill present, stroke missing
      '0:fill': FAKE_BUFFER_A,
    }))
    expect(out).toBeNull()
  })

  it('renderNodeIndex is plumbed into the lookup', () => {
    const v = withComputeBindings([
      { paintAxis: 'fill', bindGroup: 0, binding: 16 },
    ])
    // Lookup keyed by index; verifying index 7 reaches the lookup.
    const out = buildComputeBindGroupEntries(v, 7, (idx, axis) => {
      if (idx === 7 && axis === 'fill') return FAKE_BUFFER_A
      return null
    })
    expect(out).toEqual([{ binding: 16, resource: { buffer: FAKE_BUFFER_A } }])
  })
})
