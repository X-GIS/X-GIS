import { describe, expect, it } from 'vitest'
import { emitMatchComputeKernel, type MatchEmitSpec } from '@xgis/compiler'
import { emitModule } from '@xgis/shader-dsl/core/backends/wgsl'
import { compileModule } from '@xgis/shader-dsl/core/backends/cpu'
import { matchComputeKernel, type MatchKernelSpec } from '@xgis/shader-dsl/shaders/compute-match'

// US-P0-6 (PoC-C): the parameterized thesis. The data-driven compute path
// emits a per-scene kernel whose branch ladder length == the scene's arm
// count. This proves the IR carries that arm count as an emission parameter:
// the DSL-emitted kernel is structurally + numerically equivalent to the
// current compute-gen output for two distinct arm counts.

const COLORS = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff']
const PATTERNS = ['a', 'b', 'c', 'd', 'e'] // already sorted → id i == arms[i]
const DEFAULT = '#00000000'

function specFor(n: number): MatchKernelSpec & MatchEmitSpec {
  return {
    fieldName: 'class',
    arms: Array.from({ length: n }, (_, i) => ({ pattern: PATTERNS[i]!, colorHex: COLORS[i]! })),
    defaultColorHex: DEFAULT,
  }
}

const extractVec4s = (wgsl: string): number[][] =>
  [...wgsl.matchAll(/vec4<f32>\(([^)]*)\)/g)].map((m) =>
    m[1]!.split(',').map((s) => parseFloat(s.trim())))
const extractCmpIds = (wgsl: string): number[] =>
  [...wgsl.matchAll(/v_class == (\d+)\.0/g)].map((m) => parseInt(m[1]!, 10))

const pack = (r: number, g: number, b: number, a: number): number => {
  const q = (x: number): number => Math.round(Math.max(0, Math.min(1, x)) * 255) & 0xff
  return (q(r) | (q(g) << 8) | (q(b) << 16) | (q(a) << 24)) >>> 0
}

describe('PoC-C: parameterized match kernel ↔ compute-gen (2 distinct arm counts)', () => {
  for (const n of [2, 5]) {
    it(`arm-count ${n}: color sequence + comparison ids + binding header match compute-gen`, () => {
      const ref = emitMatchComputeKernel(specFor(n)).wgsl
      const dsl = emitModule(matchComputeKernel(specFor(n)))

      // (a) comparison ids: both ladders compare v_class == 0,1,…,n-1
      expect(extractCmpIds(dsl)).toEqual(extractCmpIds(ref))
      expect(extractCmpIds(dsl)).toEqual(Array.from({ length: n }, (_, i) => i))

      // (b) per-arm + default colour tuples, in source order, agree
      const refV = extractVec4s(ref), dslV = extractVec4s(dsl)
      expect(dslV.length).toBe(n + 1) // n arms + default
      expect(dslV.length).toBe(refV.length)
      for (let i = 0; i < refV.length; i++) {
        for (let c = 0; c < 4; c++) expect(dslV[i]![c]!).toBeCloseTo(refV[i]![c]!, 6)
      }

      // (c) the compute contract — these lines are byte-identical in BOTH
      // the compute-gen output and the DSL emission (the binding header,
      // entry signature, workgroup size, pack output).
      for (const line of [
        '@group(0) @binding(0) var<storage, read> feat_data: array<f32>;',
        '@group(0) @binding(1) var<storage, read_write> out_color: array<u32>;',
        '@group(0) @binding(2) var<uniform> u_count: vec4<u32>;',
        '@compute @workgroup_size(64)',
        'fn eval_match(@builtin(global_invocation_id) gid: vec3<u32>)',
        'pack4x8unorm(color)',
      ]) {
        expect(dsl, `dsl missing ${line}`).toContain(line)
        expect(ref, `ref missing ${line}`).toContain(line)
      }
    })
  }
})

describe('PoC-C: cpu interpreter runs the parameterized kernel (numeric proof)', () => {
  for (const n of [2, 5]) {
    it(`arm-count ${n}: each feature id selects the right arm colour; out-of-range → default`, () => {
      const spec = specFor(n)
      const M = compileModule(matchComputeKernel(spec))
      // feature ids 0..n-1 (each arm) + n (unknown → default)
      const featData = Array.from({ length: n + 1 }, (_, i) => i)
      const outColor: number[] = new Array(n + 1).fill(0)
      M.setBinding('feat_data', featData as unknown as never)
      M.setBinding('out_color', outColor as unknown as never)
      M.setBinding('u_count', [n + 1, 0, 0, 0] as unknown as never)

      for (let fid = 0; fid <= n; fid++) M.fns.eval_match([fid, 0, 0])

      const expectedColor = (id: number): [number, number, number, number] => {
        const hex = id < n ? COLORS[id]! : DEFAULT
        if (hex === '#00000000') return [0, 0, 0, 0]
        return [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255, 1]
      }
      for (let fid = 0; fid <= n; fid++) {
        const [r, g, b, a] = expectedColor(fid)
        expect(outColor[fid]).toBe(pack(r, g, b, a))
      }
    })
  }

  it('respects u_count guard: ids >= u_count.x are not written', () => {
    const spec = specFor(3)
    const M = compileModule(matchComputeKernel(spec))
    const featData = [0, 1, 2, 0]
    const outColor = [111, 111, 111, 111] // sentinel
    M.setBinding('feat_data', featData as unknown as never)
    M.setBinding('out_color', outColor as unknown as never)
    M.setBinding('u_count', [2, 0, 0, 0] as unknown as never) // only 2 valid features
    for (let fid = 0; fid < 4; fid++) M.fns.eval_match([fid, 0, 0])
    expect(outColor[0]).not.toBe(111) // written
    expect(outColor[1]).not.toBe(111) // written
    expect(outColor[2]).toBe(111) // fid 2 >= u_count.x=2 → early return, untouched
    expect(outColor[3]).toBe(111)
  })
})
