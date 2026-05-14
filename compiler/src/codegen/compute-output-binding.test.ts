// ═══════════════════════════════════════════════════════════════════
// compute-output-binding.ts — emit + layout tests
// ═══════════════════════════════════════════════════════════════════

import { describe, expect, it } from 'vitest'
import {
  emitComputeOutputBindingDecl,
  emitComputeOutputReadExpr,
  makeComputeOutputBindGroupEntry,
  type ComputeOutputBindingSpec,
} from './compute-output-binding'

describe('emitComputeOutputBindingDecl', () => {
  it('emits the fill binding with the right group/binding indices', () => {
    const decl = emitComputeOutputBindingDecl({
      paintAxis: 'fill', bindGroup: 3, binding: 5,
    })
    expect(decl).toBe(
      '@group(3) @binding(5) var<storage, read> compute_out_fill: array<u32>;',
    )
  })

  it('emits the stroke binding with distinct variable name', () => {
    const decl = emitComputeOutputBindingDecl({
      paintAxis: 'stroke-color', bindGroup: 3, binding: 6,
    })
    expect(decl).toBe(
      '@group(3) @binding(6) var<storage, read> compute_out_stroke: array<u32>;',
    )
  })

  it('fill and stroke variable names differ (so both can coexist)', () => {
    const fill = emitComputeOutputBindingDecl({
      paintAxis: 'fill', bindGroup: 0, binding: 0,
    })
    const stroke = emitComputeOutputBindingDecl({
      paintAxis: 'stroke-color', bindGroup: 0, binding: 1,
    })
    expect(fill).toContain('compute_out_fill')
    expect(stroke).toContain('compute_out_stroke')
    expect(fill).not.toBe(stroke)
  })
})

describe('emitComputeOutputReadExpr', () => {
  it('emits unpack4x8unorm wrapped array index for fill', () => {
    const expr = emitComputeOutputReadExpr(
      { paintAxis: 'fill', bindGroup: 0, binding: 0 },
      'input.feat_id',
    )
    expect(expr).toBe('unpack4x8unorm(compute_out_fill[input.feat_id])')
  })

  it('emits a vec4<f32>-typed expression (output replaces u.fill_color)', () => {
    // The contract is: the returned expression is a vec4<f32> drop-in
    // for the legacy `u.fill_color` reference. `unpack4x8unorm` is
    // WGSL-defined to return vec4<f32>, so this test is documentation
    // — confirming the caller can assign `out.color = expr;` without
    // type coercion.
    const expr = emitComputeOutputReadExpr(
      { paintAxis: 'fill', bindGroup: 0, binding: 0 },
      'fid',
    )
    expect(expr.startsWith('unpack4x8unorm(')).toBe(true)
    expect(expr.endsWith(')')).toBe(true)
  })

  it('accepts arbitrary WGSL fidExpr (not just input.feat_id)', () => {
    const expr = emitComputeOutputReadExpr(
      { paintAxis: 'fill', bindGroup: 0, binding: 0 },
      'u32(some_arithmetic_expression)',
    )
    expect(expr).toBe('unpack4x8unorm(compute_out_fill[u32(some_arithmetic_expression)])')
  })

  it('stroke axis uses the stroke variable name', () => {
    const expr = emitComputeOutputReadExpr(
      { paintAxis: 'stroke-color', bindGroup: 0, binding: 0 },
      'input.feat_id',
    )
    expect(expr).toBe('unpack4x8unorm(compute_out_stroke[input.feat_id])')
  })
})

describe('makeComputeOutputBindGroupEntry', () => {
  it('returns binding + read-only-storage + FRAGMENT visibility', () => {
    const spec: ComputeOutputBindingSpec = {
      paintAxis: 'fill', bindGroup: 3, binding: 5,
    }
    const entry = makeComputeOutputBindGroupEntry(spec)
    expect(entry.binding).toBe(5)
    expect(entry.buffer.type).toBe('read-only-storage')
    expect(entry.visibility).toBe(2)  // GPUShaderStage.FRAGMENT bit
  })

  it('accepts caller-provided visibility bit for typed environments', () => {
    const spec: ComputeOutputBindingSpec = {
      paintAxis: 'stroke-color', bindGroup: 0, binding: 0,
    }
    // Real GPUShaderStage.FRAGMENT is 2; some test mocks pass 999.
    const entry = makeComputeOutputBindGroupEntry(spec, 999)
    expect(entry.visibility).toBe(999)
  })

  it('does NOT carry the bindGroup (layout describes a single group, group is the layout itself)', () => {
    const spec: ComputeOutputBindingSpec = {
      paintAxis: 'fill', bindGroup: 3, binding: 5,
    }
    const entry = makeComputeOutputBindGroupEntry(spec)
    expect(entry).not.toHaveProperty('bindGroup')
    // `bindGroup` is the index into the pipeline layout — it
    // identifies the layout instance, not a per-entry field.
  })
})

describe('cross-helper consistency (WGSL decl ↔ read expr ↔ runtime entry)', () => {
  it('binding number in the WGSL decl matches the runtime entry', () => {
    const spec: ComputeOutputBindingSpec = {
      paintAxis: 'fill', bindGroup: 2, binding: 7,
    }
    const decl = emitComputeOutputBindingDecl(spec)
    const entry = makeComputeOutputBindGroupEntry(spec)
    // Decl writes "@binding(7)", entry exposes binding=7.
    expect(decl).toContain('@binding(7)')
    expect(entry.binding).toBe(7)
  })

  it('var name in the decl matches the var name in the read expr', () => {
    const spec: ComputeOutputBindingSpec = {
      paintAxis: 'fill', bindGroup: 0, binding: 0,
    }
    const decl = emitComputeOutputBindingDecl(spec)
    const expr = emitComputeOutputReadExpr(spec, 'fid')
    // Both reference "compute_out_fill" — drifting one without the
    // other produces an unresolved WGSL identifier.
    expect(decl).toContain('compute_out_fill')
    expect(expr).toContain('compute_out_fill')
  })

  it('stroke spec uses compute_out_stroke in both decl and expr', () => {
    const spec: ComputeOutputBindingSpec = {
      paintAxis: 'stroke-color', bindGroup: 0, binding: 0,
    }
    expect(emitComputeOutputBindingDecl(spec)).toContain('compute_out_stroke')
    expect(emitComputeOutputReadExpr(spec, 'fid')).toContain('compute_out_stroke')
  })
})
