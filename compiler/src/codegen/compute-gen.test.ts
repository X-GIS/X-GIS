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
  emitInterpolateComputeKernel,
  emitMatchComputeKernel,
  emitTernaryComputeKernel,
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

  it('sets entryPoint to "eval_match" in returned metadata', () => {
    const k = emitMatchComputeKernel({
      fieldName: 'class',
      arms: [{ pattern: 'a', colorHex: '#fff' }],
      defaultColorHex: '#000',
    })
    expect(k.entryPoint).toBe('eval_match')
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

  it('match kernel exposes categoryOrder with alphabetised patterns', () => {
    // Lock in cross-path category-ID assignment: the runtime packer
    // converts strings → IDs by indexOf into the sorted pattern
    // list. The kernel's if-else chain compares against the same
    // IDs. Both halves must agree on the alphabetical sort.
    const k = emitMatchComputeKernel({
      fieldName: 'class',
      arms: [
        { pattern: 'school',   colorHex: '#aaa' },
        { pattern: 'cemetery', colorHex: '#bbb' },
        { pattern: 'hospital', colorHex: '#ccc' },
      ],
      defaultColorHex: '#000',
    })
    expect(k.categoryOrder).toBeDefined()
    expect(k.categoryOrder!['class']).toEqual(['cemetery', 'hospital', 'school'])
  })

  it('emitted entryPoint matches a fn declared in the WGSL', () => {
    // Cross-check: the runtime will pass `kernel.entryPoint` to
    // createComputePipeline; if the field disagrees with the actual
    // emitted fn name the pipeline create will fail at runtime. This
    // test catches drift between the constant string in the emitter
    // and the metadata field.
    const k = emitMatchComputeKernel({
      fieldName: 'class',
      arms: [{ pattern: 'a', colorHex: '#fff' }],
      defaultColorHex: '#000',
    })
    expect(k.wgsl).toContain(`fn ${k.entryPoint}(`)
  })
})

describe('compute-gen — emitTernaryComputeKernel', () => {
  it('emits the same binding header as match() (cross-kernel layout)', () => {
    const k = emitTernaryComputeKernel({
      fields: ['rank'],
      branches: [{ pred: 'v_rank == 0.0', colorHex: '#fff' }],
      defaultColorHex: '#000',
    })
    expect(k.wgsl).toContain('@group(0) @binding(0) var<storage, read> feat_data: array<f32>')
    expect(k.wgsl).toContain('@group(0) @binding(1) var<storage, read_write> out_color: array<u32>')
    expect(k.wgsl).toContain('@group(0) @binding(2) var<uniform> u_count: vec4<u32>')
  })

  it('emits the workgroup-size annotation', () => {
    const k = emitTernaryComputeKernel({
      fields: ['x'],
      branches: [{ pred: 'v_x > 0.0', colorHex: '#fff' }],
      defaultColorHex: '#000',
    })
    expect(k.wgsl).toContain(`@compute @workgroup_size(${COMPUTE_WORKGROUP_SIZE})`)
  })

  it('emits branches in INPUT order (case() semantics — first match wins)', () => {
    // case() differs from match(): order is significant. The first
    // matching predicate wins, so the emitter must preserve insertion
    // order rather than sorting alphabetically.
    const k = emitTernaryComputeKernel({
      fields: ['cls'],
      branches: [
        { pred: 'v_cls == 0.0', colorHex: '#ff0000' },
        { pred: 'v_cls == 1.0', colorHex: '#00ff00' },
        { pred: 'v_cls == 2.0', colorHex: '#0000ff' },
      ],
      defaultColorHex: '#888',
    })
    const idx0 = k.wgsl.indexOf('v_cls == 0.0')
    const idx1 = k.wgsl.indexOf('v_cls == 1.0')
    const idx2 = k.wgsl.indexOf('v_cls == 2.0')
    expect(idx0).toBeGreaterThan(0)
    expect(idx1).toBeGreaterThan(idx0)
    expect(idx2).toBeGreaterThan(idx1)
  })

  it('emits the default arm as the trailing else', () => {
    const k = emitTernaryComputeKernel({
      fields: ['x'],
      branches: [{ pred: 'v_x > 0.0', colorHex: '#fff' }],
      defaultColorHex: '#00ff00',
    })
    expect(k.wgsl).toMatch(/}\s+else\s+\{\s+color = vec4<f32>\(0\.0,\s*1\.0,\s*0\.0,\s*1\.0\)/)
  })

  it('loads a single field at offset 0 with no stride multiplier', () => {
    const k = emitTernaryComputeKernel({
      fields: ['rank'],
      branches: [{ pred: 'v_rank > 0.0', colorHex: '#fff' }],
      defaultColorHex: '#000',
    })
    expect(k.wgsl).toContain('let v_rank = feat_data[fid];')
  })

  it('loads multiple fields with stride + offset (multi-field case)', () => {
    const k = emitTernaryComputeKernel({
      fields: ['cls', 'rank'],
      branches: [{ pred: 'v_cls == 0.0 && v_rank > 5.0', colorHex: '#fff' }],
      defaultColorHex: '#000',
    })
    expect(k.wgsl).toContain('let v_cls = feat_data[fid * 2u + 0u];')
    expect(k.wgsl).toContain('let v_rank = feat_data[fid * 2u + 1u];')
    expect(k.featureStrideF32).toBe(2)
    expect(k.fieldOrder).toEqual(['cls', 'rank'])
  })

  it('passes through compound predicates verbatim (caller emits valid WGSL)', () => {
    // The emitter trusts caller-supplied predicate strings. Composite
    // predicates with &&, ||, parens come through unchanged.
    const k = emitTernaryComputeKernel({
      fields: ['a', 'b'],
      branches: [
        { pred: '(v_a > 0.0) && (v_b < 10.0)', colorHex: '#fff' },
      ],
      defaultColorHex: '#000',
    })
    expect(k.wgsl).toContain('if ((v_a > 0.0) && (v_b < 10.0))')
  })

  it('sets entryPoint to "eval_case" in returned metadata', () => {
    const k = emitTernaryComputeKernel({
      fields: ['x'],
      branches: [{ pred: 'v_x > 0.0', colorHex: '#fff' }],
      defaultColorHex: '#000',
    })
    expect(k.entryPoint).toBe('eval_case')
  })

  it('ternary kernel has no categoryOrder (predicates are pure numeric)', () => {
    const k = emitTernaryComputeKernel({
      fields: ['x'],
      branches: [{ pred: 'v_x > 0.0', colorHex: '#fff' }],
      defaultColorHex: '#000',
    })
    // Absence is the contract — packer skips fields without an
    // entry. Match kernel populates this; ternary doesn't because
    // its predicates compare numeric values directly.
    expect(k.categoryOrder).toBeUndefined()
  })

  it('packs color via pack4x8unorm (same write path as match kernel)', () => {
    const k = emitTernaryComputeKernel({
      fields: ['x'],
      branches: [{ pred: 'v_x > 0.0', colorHex: '#fff' }],
      defaultColorHex: '#000',
    })
    expect(k.wgsl).toContain('out_color[fid] = pack4x8unorm(color);')
  })

  it('empty branches list emits just the default branch', () => {
    const k = emitTernaryComputeKernel({
      fields: [],
      branches: [],
      defaultColorHex: '#888',
    })
    expect(k.wgsl).toContain('@compute @workgroup_size(64)')
    expect(k.wgsl).toContain('var color: vec4<f32>;')
    expect(k.wgsl).toMatch(/else \{ color = vec4<f32>/)
    // No fields → no v_* loads.
    expect(k.wgsl).not.toMatch(/let v_/)
  })

  it('dispatchSize ceils features / workgroup_size', () => {
    const k = emitTernaryComputeKernel({
      fields: ['x'],
      branches: [{ pred: 'v_x > 0.0', colorHex: '#fff' }],
      defaultColorHex: '#000',
    })
    expect(k.dispatchSize(0)).toBe(0)
    expect(k.dispatchSize(64)).toBe(1)
    expect(k.dispatchSize(65)).toBe(2)
    expect(k.dispatchSize(1000)).toBe(16)
  })
})

describe('compute-gen — emitInterpolateComputeKernel', () => {
  it('emits the standard binding header (parity with match/case kernels)', () => {
    const k = emitInterpolateComputeKernel({
      fieldName: 'rank',
      stops: [{ input: 0, colorHex: '#fff' }, { input: 10, colorHex: '#000' }],
    })
    expect(k.wgsl).toContain('@group(0) @binding(0) var<storage, read> feat_data: array<f32>')
    expect(k.wgsl).toContain('@group(0) @binding(1) var<storage, read_write> out_color: array<u32>')
    expect(k.wgsl).toContain('@group(0) @binding(2) var<uniform> u_count: vec4<u32>')
  })

  it('clamps left below the first stop (v <= s0 → c0)', () => {
    const k = emitInterpolateComputeKernel({
      fieldName: 'rank',
      stops: [
        { input: 0,  colorHex: '#ff0000' },
        { input: 10, colorHex: '#00ff00' },
      ],
    })
    expect(k.wgsl).toContain('if (v_rank <= 0.0)')
    expect(k.wgsl).toMatch(/color = vec4<f32>\(1\.0, 0\.0, 0\.0, 1\.0\);/)
  })

  it('emits piecewise mix() between adjacent stops', () => {
    const k = emitInterpolateComputeKernel({
      fieldName: 'rank',
      stops: [
        { input: 0,  colorHex: '#ff0000' },
        { input: 10, colorHex: '#00ff00' },
      ],
    })
    expect(k.wgsl).toContain('let t = (v_rank - 0.0) / 10.0;')
    expect(k.wgsl).toContain('color = mix(')
  })

  it('clamps right above the last stop (v > sN → cN)', () => {
    const k = emitInterpolateComputeKernel({
      fieldName: 'rank',
      stops: [
        { input: 0,  colorHex: '#ff0000' },
        { input: 10, colorHex: '#00ff00' },
      ],
    })
    // The trailing else uses the LAST stop's colour. Match against
    // (0,1,0,1) which is #00ff00.
    expect(k.wgsl).toMatch(/else \{ color = vec4<f32>\(0\.0, 1\.0, 0\.0, 1\.0\);/)
  })

  it('emits middle ranges in ascending stop order (3-stop ramp)', () => {
    const k = emitInterpolateComputeKernel({
      fieldName: 'pop',
      stops: [
        { input: 0,    colorHex: '#000000' },
        { input: 1000, colorHex: '#ff0000' },
        { input: 5000, colorHex: '#ffffff' },
      ],
    })
    const idx1 = k.wgsl.indexOf('<= 1000.0')
    const idx2 = k.wgsl.indexOf('<= 5000.0')
    expect(idx1).toBeGreaterThan(0)
    expect(idx2).toBeGreaterThan(idx1)
  })

  it('single-stop spec emits a constant colour (no mix())', () => {
    const k = emitInterpolateComputeKernel({
      fieldName: 'x',
      stops: [{ input: 5, colorHex: '#ff0000' }],
    })
    expect(k.wgsl).not.toContain('mix(')
    expect(k.wgsl).toContain('color = vec4<f32>(1.0, 0.0, 0.0, 1.0);')
  })

  it('empty stops emits transparent fallback (degenerate but valid)', () => {
    const k = emitInterpolateComputeKernel({ fieldName: 'x', stops: [] })
    expect(k.wgsl).toContain('color = vec4<f32>(0.0, 0.0, 0.0, 0.0);')
    expect(k.wgsl).toContain('@compute @workgroup_size(64)')
  })

  it('returns single-field metadata (stride 1, fieldOrder = [name])', () => {
    const k = emitInterpolateComputeKernel({
      fieldName: 'rank',
      stops: [{ input: 0, colorHex: '#fff' }, { input: 1, colorHex: '#000' }],
    })
    expect(k.featureStrideF32).toBe(1)
    expect(k.fieldOrder).toEqual(['rank'])
  })

  it('packs colour via pack4x8unorm (output parity with other kernels)', () => {
    const k = emitInterpolateComputeKernel({
      fieldName: 'x',
      stops: [{ input: 0, colorHex: '#fff' }, { input: 1, colorHex: '#000' }],
    })
    expect(k.wgsl).toContain('out_color[fid] = pack4x8unorm(color);')
  })

  it('sets entryPoint to "eval_interpolate" in returned metadata', () => {
    const k = emitInterpolateComputeKernel({
      fieldName: 'x',
      stops: [{ input: 0, colorHex: '#fff' }, { input: 1, colorHex: '#000' }],
    })
    expect(k.entryPoint).toBe('eval_interpolate')
  })

  it('emits compute shader function name "eval_interpolate" (distinct from match/case)', () => {
    // Pipeline dispatch keys off the entry-point name. The three
    // kernels must have distinct names so the runtime can build
    // separate ComputePipeline objects without collision.
    const k = emitInterpolateComputeKernel({
      fieldName: 'x',
      stops: [{ input: 0, colorHex: '#fff' }, { input: 1, colorHex: '#000' }],
    })
    expect(k.wgsl).toContain('fn eval_interpolate(')
  })
})

describe('emitMatchComputeKernel — LUT branch (P5 large-match)', () => {
  /** Build a match spec with N distinct arms (auto-generated patterns). */
  function bigMatch(n: number) {
    const arms: { pattern: string; colorHex: string }[] = []
    for (let i = 0; i < n; i++) {
      const r = (i * 17) % 256
      const g = (i * 31) % 256
      const b = (i * 53) % 256
      const hex = '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('')
      arms.push({ pattern: `k${String(i).padStart(3, '0')}`, colorHex: hex })
    }
    return { fieldName: 'cls', arms, defaultColorHex: '#888888' }
  }

  it('below threshold (15 arms) → if-else chain, no LUT', () => {
    const k = emitMatchComputeKernel(bigMatch(15))
    expect(k.wgsl).not.toContain('const LUT:')
    const compareCount = (k.wgsl.match(/v_cls == /g) ?? []).length
    expect(compareCount).toBe(15)
  })

  it('at threshold (16 arms) → emits LUT, no if-else comparisons', () => {
    const k = emitMatchComputeKernel(bigMatch(16))
    expect(k.wgsl).toContain('const LUT: array<vec4<f32>, 16>')
    const compareCount = (k.wgsl.match(/v_cls == /g) ?? []).length
    expect(compareCount).toBe(0)
  })

  it('large-arm (50 arms) → LUT length matches arm count', () => {
    const k = emitMatchComputeKernel(bigMatch(50))
    expect(k.wgsl).toContain('const LUT: array<vec4<f32>, 50>')
    // 50 LUT entries + 1 default-branch vec4 = 51 total.
    const vec4Count = (k.wgsl.match(/vec4<f32>\(/g) ?? []).length
    expect(vec4Count).toBe(51)
  })

  it('LUT id-bounds branch: < N hits LUT, ≥ N hits default', () => {
    const k = emitMatchComputeKernel(bigMatch(20))
    expect(k.wgsl).toMatch(/if \(id < 20u\)\s*\{\s*color = LUT\[id\];/)
    expect(k.wgsl).toMatch(/\} else \{\s*color = vec4<f32>\(/)
  })

  it('LUT entries appear in alphabetical pattern order (matches packer IDs)', () => {
    // Generate arms with intentionally non-alphabetical input order;
    // sorted order must STILL drive LUT[i] so packer IDs align.
    const arms: { pattern: string; colorHex: string }[] = []
    for (let i = 0; i < 20; i++) {
      // i=0 generates k099, i=19 generates k080.
      arms.push({ pattern: `k${String(99 - i).padStart(3, '0')}`, colorHex: `#${i.toString(16).padStart(2, '0')}0000` })
    }
    const k = emitMatchComputeKernel({ fieldName: 'x', arms, defaultColorHex: '#ffffff' })
    expect(k.categoryOrder?.x?.[0]).toBe('k080')
    expect(k.wgsl).toContain('const LUT: array<vec4<f32>, 20>')
  })

  it('LUT kernel preserves entryPoint + dispatchSize contract', () => {
    const small = emitMatchComputeKernel(bigMatch(10))
    const large = emitMatchComputeKernel(bigMatch(20))
    expect(small.entryPoint).toBe('eval_match')
    expect(large.entryPoint).toBe('eval_match')
    expect(small.dispatchSize(1000)).toBe(Math.ceil(1000 / 64))
    expect(large.dispatchSize(1000)).toBe(Math.ceil(1000 / 64))
  })

  it('out_color write path is identical between LUT + if-else paths', () => {
    const small = emitMatchComputeKernel(bigMatch(10))
    const large = emitMatchComputeKernel(bigMatch(20))
    expect(small.wgsl).toContain('out_color[fid] = pack4x8unorm(color);')
    expect(large.wgsl).toContain('out_color[fid] = pack4x8unorm(color);')
  })

  it('demotiles-scale (214 arms) emits valid LUT WGSL', () => {
    const k = emitMatchComputeKernel(bigMatch(214))
    expect(k.wgsl).toContain('const LUT: array<vec4<f32>, 214>')
    expect(k.wgsl).toContain('if (id < 214u)')
    expect(k.wgsl).toContain('@compute @workgroup_size(64)')
    // No O(N) comparisons in the kernel body for the LUT path.
    expect((k.wgsl.match(/v_cls == /g) ?? []).length).toBe(0)
  })

  it('WGSL length scales linearly with arm count for LUT (no quadratic blowup)', () => {
    const k20 = emitMatchComputeKernel(bigMatch(20))
    const k200 = emitMatchComputeKernel(bigMatch(200))
    // Linear scaling check: 200/20 = 10× arms → expect ~10× length
    // The preamble + kernel body have a fixed overhead, so the
    // ratio is less than 10× — checking that it's clearly more than
    // 5× (proves linear, not constant) AND clearly less than 11×
    // (proves no quadratic blowup).
    const ratio = k200.wgsl.length / k20.wgsl.length
    expect(ratio).toBeGreaterThan(5)
    expect(ratio).toBeLessThan(11)
  })
})

/** Mirror `fmt()` in compute-gen.ts for round-trip assertions. */
function formatNumber(n: number): string {
  if (Number.isInteger(n)) return `${n}.0`
  return n.toString()
}
