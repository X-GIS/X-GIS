// ═══ UniformBlock unit gates (#733 P0) — content-blind, synthetic structs only ═══
//
// Anchors, in order of load-bearing-ness:
//   1. LAYOUT PARITY — of(U) (the handle-only wgslLayout path) produces byte-for-
//      byte the SAME offsets/size as reflect(module) (the path shipping renderers
//      derive their slots from). This is what makes a later packer migration
//      byte-identical by construction (DC=0 anchor).
//   2. VIEW ROUTING — u32 fields store raw words through the Uint32Array view
//      (0xFFFFFFFF survives; an f32-routed store would coerce and corrupt).
//   3. std140 SHAPE — vec3 pad lane stays zero; a following f32 legally packs
//      into the vec3 tail (92, not 96).
//   4. write() ≡ set.* — both surfaces emit identical bytes.
//   5. FAIL-LOUD — mat3 / array / nested-struct fields throw at construction.
//
// Compile-time guarantees (missing field, typo'd field, wrong setter arity) are
// gated as @ts-expect-error lines — `tsc --build engine` fails if they compile.

import { describe, it, expect } from 'vitest'
import {
  uniformStruct,
  arrayT,
  structDecl,
  module,
  reflect,
  f32T,
  u32T,
  vec2fT,
  vec3fT,
  vec4fT,
  vec4uT,
  mat4x4fT,
  type ShaderType,
} from '@xgis/shader-dsl'
import { uniformBlock, UniformBlock } from './uniform-block'

// Mixed-kind struct exercising every supported field shape. Hand-computed std140:
// m @0(64) · v4 @64(16) · v3 @80(12) · s @92(4, packs into the vec3 tail) ·
// v2 @96(8) · u @104(4) · uv4 @112(16) → size 128.
const MIXED = uniformStruct(
  'Mixed',
  { group: 0, binding: 0, as: 'u' },
  {
    m: mat4x4fT,
    v4: vec4fT,
    v3: vec3fT,
    s: f32T,
    v2: vec2fT,
    u: u32T,
    uv4: vec4uT,
  },
)

const mixedValues = {
  m: Float32Array.from({ length: 16 }, (_, i) => i + 1),
  v4: [101, 102, 103, 104] as const,
  v3: [7, 8, 9] as const,
  s: 42.5,
  u: 0xffffffff,
  v2: [-1, -2] as const,
  uv4: [1, 2, 3, 0xdeadbeef] as const,
}

describe('UniformBlock layout (std140, handle-only wgslLayout path)', () => {
  it('resolves the hand-computed std140 offsets and total size', () => {
    const b = uniformBlock(MIXED)
    expect(b.fieldOffset('m')).toBe(0)
    expect(b.fieldOffset('v4')).toBe(64)
    expect(b.fieldOffset('v3')).toBe(80)
    expect(b.fieldOffset('s')).toBe(92) // f32 packs into the vec3 tail
    expect(b.fieldOffset('v2')).toBe(96)
    expect(b.fieldOffset('u')).toBe(104)
    expect(b.fieldOffset('uv4')).toBe(112)
    expect(b.byteLength).toBe(128)
  })

  it('matches reflect(module) — the layout source shipping renderers use', () => {
    const m = module({ structs: [MIXED.struct], bindings: [MIXED.binding] })
    const reflected = reflect(m).uniforms.find((u) => u.name === 'Mixed')!
    const b = uniformBlock(MIXED)
    expect(reflected).toBeDefined()
    expect(b.byteLength).toBe(reflected.size)
    for (const f of reflected.fields) expect(b.fieldOffset(f.name as never)).toBe(f.offset)
  })

  it('std140Stride rounds byteLength up to the bind alignment', () => {
    expect(uniformBlock(MIXED).std140Stride()).toBe(256) // 128 → 256
    const FIVE_MATS = uniformStruct(
      'FiveMats',
      { group: 0, binding: 0, as: 'u' },
      {
        m0: mat4x4fT,
        m1: mat4x4fT,
        m2: mat4x4fT,
        m3: mat4x4fT,
        m4: mat4x4fT,
      },
    )
    expect(uniformBlock(FIVE_MATS).std140Stride()).toBe(512) // 320 → 512
  })
})

describe('UniformBlock.write()', () => {
  it('packs every field at its reflected lane, routing u32 fields through the u32 view', () => {
    const b = uniformBlock(MIXED).write(mixedValues)
    const f32 = new Float32Array(b.buffer)
    const u32 = new Uint32Array(b.buffer)
    expect([...f32.slice(0, 16)]).toEqual([...mixedValues.m])
    expect([...f32.slice(16, 20)]).toEqual([101, 102, 103, 104])
    expect([...f32.slice(20, 23)]).toEqual([7, 8, 9])
    expect(f32[23]).toBe(42.5) // s occupies the vec3 tail lane
    expect([...f32.slice(24, 26)]).toEqual([-1, -2])
    // Raw-word survival: an f32-routed store would coerce 0xFFFFFFFF to a float
    // and the word would read back as 0x4F800000.
    expect(u32[26]).toBe(0xffffffff)
    expect([...u32.slice(28, 32)]).toEqual([1, 2, 3, 0xdeadbeef])
  })

  it('throws in DEV when a field is missing (untyped caller escape hatch)', () => {
    const b = uniformBlock(MIXED) as UniformBlock
    expect(() => b.write({} as never)).toThrow(/missing/)
  })
})

describe('UniformBlock.set.* (hot-loop surface)', () => {
  it('emits bytes identical to write()', () => {
    const viaWrite = uniformBlock(MIXED).write(mixedValues)
    const viaSet = uniformBlock(MIXED)
    viaSet.set.m(mixedValues.m)
    viaSet.set.v4(101, 102, 103, 104)
    viaSet.set.v3(7, 8, 9)
    viaSet.set.s(42.5)
    viaSet.set.v2(-1, -2)
    viaSet.set.u(0xffffffff)
    viaSet.set.uv4(1, 2, 3, 0xdeadbeef)
    expect([...new Uint8Array(viaSet.buffer)]).toEqual([...new Uint8Array(viaWrite.buffer)])
  })

  it('never touches the vec3 std140 pad lane', () => {
    const PADDED = uniformStruct(
      'Padded',
      { group: 0, binding: 0, as: 'u' },
      {
        v3: vec3fT, // @0..11, pad @12..15
        v4: vec4fT, // @16..31
      },
    )
    const b = uniformBlock(PADDED)
    b.set.v3(1, 2, 3)
    b.set.v4(4, 5, 6, 7)
    const f32 = new Float32Array(b.buffer)
    expect([...f32.slice(0, 3)]).toEqual([1, 2, 3])
    expect(f32[3]).toBe(0) // the pad lane — zero-init, never written
    expect([...f32.slice(4, 8)]).toEqual([4, 5, 6, 7])
  })
})

describe('UniformBlock fail-loud construction (the LineLayer carve-out boundary)', () => {
  it('rejects mat3 fields (per-column std140 padding)', () => {
    const mat3x3fT = { kind: 'mat', n: 3, elem: 'f32' } as const satisfies ShaderType
    const U = uniformStruct('M3', { group: 0, binding: 0, as: 'u' }, { m: mat3x3fT })
    expect(() => uniformBlock(U)).toThrow(/column\/stride-aware/)
  })

  it('rejects array fields', () => {
    const U = uniformStruct('Arr', { group: 0, binding: 0, as: 'u' }, { a: arrayT(vec4fT, 2) })
    expect(() => uniformBlock(U)).toThrow(/column\/stride-aware/)
  })

  it('rejects nested struct fields (handle carries no structs map)', () => {
    const Inner = structDecl('Inner', { x: f32T, _p0: f32T, _p1: f32T, _p2: f32T })
    const U = uniformStruct('Nested', { group: 0, binding: 0, as: 'u' }, { inner: Inner.type })
    expect(() => uniformBlock(U)).toThrow() // wgslLayout: struct 'Inner' not found
  })
})

// ── Compile-time gates (fail `tsc --build engine` if these ever compile) ──
// Never called (calling would fire the dev asserts) — exported so TS6133 doesn't
// flag it; the @ts-expect-error lines are the actual gate.
export function _compileTimeGates(): void {
  const b = uniformBlock(MIXED)
  // @ts-expect-error — write() with a missing field (completeness is compile-time)
  b.write({ m: mixedValues.m, v4: [1, 2, 3, 4], v3: [1, 2, 3], s: 1, v2: [1, 2], u: 1 })
  // @ts-expect-error — typo'd field name on the setter surface
  b.set.viewprot(1, 2, 3, 4)
  // @ts-expect-error — wrong arity: vec4 setter with 3 lanes
  b.set.v4(1, 2, 3)
  // @ts-expect-error — mat4 setter takes an ArrayLike, not lanes
  b.set.m(1, 2, 3, 4)
}
