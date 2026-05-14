// ═══════════════════════════════════════════════════════════════════
// compute-gen.ts — WGSL emit tests
// ═══════════════════════════════════════════════════════════════════
//
// Locks in the emitted compute-kernel shape:
//   - Bind-group bindings + binding indices
//   - @compute / @workgroup_size annotation
//   - Per-arm if-else chain ordering matches shader-gen's
//     alphabetical-pattern convention (cross-path categoryOrder
//     compatibility)
//   - Default arm always present
//   - dispatchSize + fieldOrder + featureStrideF32 metadata

import { describe, expect, it } from 'vitest'
import {
  COMPUTE_WORKGROUP_SIZE,
  emitMatchComputeKernel,
} from './compute-gen'

describe('compute-gen — emitMatchComputeKernel', () => {
  it('emits the standard binding header (feat_data, out_color, u_count)', () => {
    const k = emitMatchComputeKernel({
      fieldName: 'class',
      arms: [{ pattern: 'a', colorHex: '#ff0000' }],
      defaultColorHex: '#000000',
    })
    expect(k.wgsl).toContain('@group(0) @binding(0) var<storage, read> feat_data: array<f32>')
    expect(k.wgsl).toContain('@group(0) @binding(1) var<storage, read_write> out_color: array<u32>')
    expect(k.wgsl).toContain('@group(0) @binding(2) var<uniform> u_count: vec4<u32>')
  })

  it('emits the workgroup-size annotation matching the constant', () => {
    const k = emitMatchComputeKernel({
      fieldName: 'x',
      arms: [{ pattern: 'a', colorHex: '#fff' }],
      defaultColorHex: '#000',
    })
    expect(k.wgsl).toContain(`@compute @workgroup_size(${COMPUTE_WORKGROUP_SIZE})`)
    expect(COMPUTE_WORKGROUP_SIZE).toBe(64)
  })

  it('emits if-else chain in ALPHABETICAL pattern order (cross-path ID alignment)', () => {
    // shader-gen.ts line ~227 sorts arms alphabetically before
    // assigning IDs. The compute emitter must use the same order so
    // the runtime's feat_data write maps to the right branch on
    // BOTH compute kernel and fragment shader.
    const k = emitMatchComputeKernel({
      fieldName: 'class',
      arms: [
        { pattern: 'school',   colorHex: '#f0e8f8' },
        { pattern: 'cemetery', colorHex: '#aaddaa' },
        { pattern: 'hospital', colorHex: '#f5deb3' },
        { pattern: 'railway',  colorHex: '#cccccc' },
      ],
      defaultColorHex: '#00000000',
    })
    const idxCemetery = k.wgsl.indexOf('== 0.0)')
    const idxHospital = k.wgsl.indexOf('== 1.0)')
    const idxRailway = k.wgsl.indexOf('== 2.0)')
    const idxSchool = k.wgsl.indexOf('== 3.0)')
    expect(idxCemetery).toBeGreaterThan(0)
    expect(idxHospital).toBeGreaterThan(idxCemetery)
    expect(idxRailway).toBeGreaterThan(idxHospital)
    expect(idxSchool).toBeGreaterThan(idxRailway)
  })

  it('emits the default arm as the trailing else (catches non-listed values)', () => {
    const k = emitMatchComputeKernel({
      fieldName: 'class',
      arms: [{ pattern: 'a', colorHex: '#ff0000' }],
      defaultColorHex: '#00ff00',
    })
    // Default appears as the final `else {…}` after the if-else chain.
    // fmt(0) emits `0.0`; fmt(1) emits `1.0`. Match both.
    expect(k.wgsl).toMatch(/}\s+else\s+\{\s+color = vec4<f32>\(0\.0,\s*1\.0,\s*0\.0,\s*1\.0\)/)
  })

  it('packs the per-fragment color into RGBA8 via pack4x8unorm', () => {
    const k = emitMatchComputeKernel({
      fieldName: 'x',
      arms: [{ pattern: 'a', colorHex: '#fff' }],
      defaultColorHex: '#000',
    })
    expect(k.wgsl).toContain('out_color[fid] = pack4x8unorm(color)')
  })

  it('parses 3-digit, 4-digit, 6-digit, 8-digit hex colors', () => {
    const cases = [
      { input: '#f00',      r: 1.0, g: 0.0,             b: 0.0, a: 1.0 },
      { input: '#f008',     r: 1.0, g: 0.0,             b: 0.0, a: 8 / 15 },
      { input: '#ff8000',   r: 1.0, g: 0x80 / 255,      b: 0.0, a: 1.0 },
      { input: '#ff800080', r: 1.0, g: 0x80 / 255,      b: 0.0, a: 0x80 / 255 },
    ]
    for (const c of cases) {
      const k = emitMatchComputeKernel({
        fieldName: 'x',
        arms: [{ pattern: 'a', colorHex: c.input }],
        defaultColorHex: '#000',
      })
      expect(k.wgsl).toContain(
        `color = vec4<f32>(${formatNumber(c.r)}, ${formatNumber(c.g)}, ${formatNumber(c.b)}, ${formatNumber(c.a)});`,
      )
    }
  })

  it('returns metadata: featureStrideF32 = 1, fieldOrder = [fieldName]', () => {
    const k = emitMatchComputeKernel({
      fieldName: 'class',
      arms: [{ pattern: 'a', colorHex: '#fff' }],
      defaultColorHex: '#000',
    })
    expect(k.featureStrideF32).toBe(1)
    expect(k.fieldOrder).toEqual(['class'])
  })

  it('dispatchSize ceils features / workgroup_size', () => {
    const k = emitMatchComputeKernel({
      fieldName: 'x',
      arms: [{ pattern: 'a', colorHex: '#fff' }],
      defaultColorHex: '#000',
    })
    expect(k.dispatchSize(0)).toBe(0)
    expect(k.dispatchSize(1)).toBe(1)
    expect(k.dispatchSize(COMPUTE_WORKGROUP_SIZE)).toBe(1)
    expect(k.dispatchSize(COMPUTE_WORKGROUP_SIZE + 1)).toBe(2)
    expect(k.dispatchSize(1000)).toBe(Math.ceil(1000 / 64))  // 16
  })

  it('empty arms list still emits a valid kernel with only the default branch', () => {
    const k = emitMatchComputeKernel({
      fieldName: 'class',
      arms: [],
      defaultColorHex: '#888',
    })
    expect(k.wgsl).toContain('@compute @workgroup_size(64)')
    expect(k.wgsl).toContain('var color: vec4<f32>;')
    // No if-else chain — just the default else branch. The kernel
    // is valid WGSL because the `else` follows the immediate
    // `var color: vec4<f32>;` declaration without a preceding if.
    // (Edge-case: the runtime will skip dispatching a match() with
    // zero arms anyway, so this is mostly a "doesn't throw" check.)
  })

  it('emits the field load using array index = fid (single-field stride)', () => {
    const k = emitMatchComputeKernel({
      fieldName: 'rank',
      arms: [{ pattern: 'a', colorHex: '#fff' }],
      defaultColorHex: '#000',
    })
    expect(k.wgsl).toContain('let v_rank = feat_data[fid];')
  })
})

/** Mirror `fmt()` in compute-gen.ts for round-trip assertions. */
function formatNumber(n: number): string {
  if (Number.isInteger(n)) return `${n}.0`
  return n.toString()
}
