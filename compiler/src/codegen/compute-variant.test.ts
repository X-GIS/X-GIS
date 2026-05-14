// ═══════════════════════════════════════════════════════════════════
// compute-variant.ts — addendum builder tests
// ═══════════════════════════════════════════════════════════════════

import { describe, expect, it } from 'vitest'
import { buildComputeVariantAddendum, FRAGMENT_FEAT_ID_EXPR } from './compute-variant'
import { emitMatchComputeKernel, emitTernaryComputeKernel } from './compute-gen'
import type { ComputePlanEntry } from './compute-plan'

function makeMatchEntry(field: string, paintAxis: 'fill' | 'stroke-color', renderNodeIndex = 0): ComputePlanEntry {
  const kernel = emitMatchComputeKernel({
    fieldName: field,
    arms: [{ pattern: 'a', colorHex: '#ff0000' }],
    defaultColorHex: '#000000',
  })
  return {
    renderNodeIndex,
    paintAxis,
    kernel,
    fieldOrder: kernel.fieldOrder,
    categoryOrder: kernel.categoryOrder ?? {},
  }
}

function makeTernaryEntry(field: string, paintAxis: 'fill' | 'stroke-color'): ComputePlanEntry {
  const kernel = emitTernaryComputeKernel({
    fields: [field],
    branches: [{ pred: `v_${field} != 0.0`, colorHex: '#ff0000' }],
    defaultColorHex: '#000000',
  })
  return {
    renderNodeIndex: 0,
    paintAxis,
    kernel,
    fieldOrder: kernel.fieldOrder,
    categoryOrder: kernel.categoryOrder ?? {},
  }
}

describe('buildComputeVariantAddendum', () => {
  it('empty entries → empty addendum (no-op merge target)', () => {
    const a = buildComputeVariantAddendum([], 0, 1)
    expect(a.preamble).toBe('')
    expect(a.fillExpr).toBeUndefined()
    expect(a.strokeExpr).toBeUndefined()
    expect(a.bindGroupEntries).toEqual([])
    expect(a.bindings).toEqual([])
  })

  it('one fill entry → fillExpr set, preamble has one decl', () => {
    const a = buildComputeVariantAddendum(
      [makeMatchEntry('class', 'fill')],
      0,
      3,
    )
    expect(a.preamble).toContain('@group(0) @binding(3)')
    expect(a.preamble).toContain('compute_out_fill')
    expect(a.fillExpr).toBe('unpack4x8unorm(compute_out_fill[input.feat_id])')
    expect(a.strokeExpr).toBeUndefined()
    expect(a.bindGroupEntries).toHaveLength(1)
    expect(a.bindGroupEntries[0]!.binding).toBe(3)
  })

  it('one stroke entry → strokeExpr set', () => {
    const a = buildComputeVariantAddendum(
      [makeMatchEntry('class', 'stroke-color')],
      2,
      0,
    )
    expect(a.fillExpr).toBeUndefined()
    expect(a.strokeExpr).toBe('unpack4x8unorm(compute_out_stroke[input.feat_id])')
    expect(a.bindGroupEntries).toHaveLength(1)
  })

  it('fill + stroke entries → both exprs set, two-line preamble, sequential bindings', () => {
    const a = buildComputeVariantAddendum(
      [
        makeMatchEntry('class', 'fill'),
        makeTernaryEntry('border', 'stroke-color'),
      ],
      0,
      5,
    )
    expect(a.fillExpr).toBeDefined()
    expect(a.strokeExpr).toBeDefined()
    expect(a.bindGroupEntries.map(e => e.binding)).toEqual([5, 6])
    // Preamble has two distinct decl lines.
    const lines = a.preamble.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('@binding(5)')
    expect(lines[1]).toContain('@binding(6)')
  })

  it('binding sequence starts at baseBinding and increments by 1', () => {
    const a = buildComputeVariantAddendum(
      [
        makeMatchEntry('a', 'fill'),
        makeTernaryEntry('b', 'stroke-color'),
      ],
      3,
      10,
    )
    expect(a.bindings.map(b => b.binding)).toEqual([10, 11])
    expect(a.bindings.every(b => b.bindGroup === 3)).toBe(true)
  })

  it('paintAxis preserved in bindings array (caller uses to wire output buffers)', () => {
    const a = buildComputeVariantAddendum(
      [
        makeMatchEntry('a', 'fill'),
        makeTernaryEntry('b', 'stroke-color'),
      ],
      0,
      0,
    )
    expect(a.bindings.map(b => b.paintAxis)).toEqual(['fill', 'stroke-color'])
  })

  it('fid expression matches FRAGMENT_FEAT_ID_EXPR constant', () => {
    const a = buildComputeVariantAddendum(
      [makeMatchEntry('class', 'fill')],
      0,
      0,
    )
    expect(FRAGMENT_FEAT_ID_EXPR).toBe('input.feat_id')
    expect(a.fillExpr).toContain(FRAGMENT_FEAT_ID_EXPR)
  })

  it('fragment expressions are valid vec4<f32> drop-ins (unpack4x8unorm wrapper)', () => {
    const a = buildComputeVariantAddendum(
      [
        makeMatchEntry('a', 'fill'),
        makeTernaryEntry('b', 'stroke-color'),
      ],
      0,
      0,
    )
    expect(a.fillExpr!.startsWith('unpack4x8unorm(')).toBe(true)
    expect(a.fillExpr!.endsWith(')')).toBe(true)
    expect(a.strokeExpr!.startsWith('unpack4x8unorm(')).toBe(true)
  })

  it('bindGroupEntries shape: { binding, visibility, buffer: { type } }', () => {
    const a = buildComputeVariantAddendum(
      [makeMatchEntry('class', 'fill')],
      0,
      2,
    )
    const entry = a.bindGroupEntries[0]!
    expect(entry.binding).toBe(2)
    expect(entry.visibility).toBe(2)  // FRAGMENT bit
    expect(entry.buffer.type).toBe('read-only-storage')
  })

  it('two fill entries (multi-show merge by caller) → second wins fillExpr', () => {
    // Within a single variant, two entries with the SAME paintAxis
    // is a misuse — caller should have filtered to one show. The
    // builder doesn't enforce this (returns the second as fillExpr)
    // because making it a hard error would couple the builder to
    // assumptions about the caller's merge model. Test documents
    // the current behaviour so future callers know.
    const a = buildComputeVariantAddendum(
      [
        makeMatchEntry('a', 'fill'),
        makeMatchEntry('b', 'fill'),
      ],
      0,
      0,
    )
    expect(a.bindGroupEntries).toHaveLength(2)
    expect(a.fillExpr).toContain('compute_out_fill[input.feat_id]')
  })
})
