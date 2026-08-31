// #2137 — UniformBlock admits `array<vec4<T>, N>` and STILL rejects every other
// array shape.
//
// The constructor guard used to throw on `startsWith('array')` wholesale, with the
// stated reason "array strides". That reason is real but narrower than the guard:
// std140 pads each array element up to a 16-byte stride, so an `array<f32, N>`
// occupies 16N bytes rather than 4N and the flat `lanes = size / 4` path would
// mis-pack it. A vec4 element is ALREADY 16 B, so stride == element size, the
// elements are contiguous, and the existing vector path is correct unchanged.
//
// Both halves are asserted here on purpose. Admitting the safe shape without
// pinning that the hazardous ones still fail loud would turn a narrowed guard
// into a defeated one, and nothing downstream would notice until a shader read
// silent garbage — the corruption class UniformBlock exists to retire.

import { describe, it, expect } from 'vitest'
import { uniformStruct, arrayOf, vec4fT, vec2fT, f32T } from '@xgis/shader-dsl'
import { uniformBlock } from './uniform-block'

describe('#2137 UniformBlock vec4-array support', () => {
  it('packs an array<vec4<f32>, N> contiguously at the reflected offsets', () => {
    const U = uniformStruct(
      'TrigProbe',
      { group: 0, binding: 0, as: 'u' },
      { head: vec4fT, rows: arrayOf(vec4fT, 3), tail: vec4fT },
    )
    const block = uniformBlock(U)

    // 3 vec4s = 48 B contiguous, so the field after them starts at 16 + 48 = 64.
    expect(block.fieldOffset('head')).toBe(0)
    expect(block.fieldOffset('rows')).toBe(16)
    expect(block.fieldOffset('tail')).toBe(64)
    expect(block.byteLength).toBe(80)

    block.write({
      head: [1, 2, 3, 4],
      // 12 flat lanes — element j occupies [4j, 4j+4).
      rows: [10, 11, 12, 13, 20, 21, 22, 23, 30, 31, 32, 33],
      tail: [9, 9, 9, 9],
    })

    const f = new Float32Array(block.buffer)
    // The array lanes must land back-to-back with NO per-element padding: a
    // 16-byte stride assumption would scatter these across 4-lane gaps.
    expect(Array.from(f.subarray(4, 16))).toEqual([10, 11, 12, 13, 20, 21, 22, 23, 30, 31, 32, 33])
    // And the neighbours must be undisturbed — an over-long write would clobber them.
    expect(Array.from(f.subarray(0, 4))).toEqual([1, 2, 3, 4])
    expect(Array.from(f.subarray(16, 20))).toEqual([9, 9, 9, 9])
  })

  it('indexes element j at lane 4j — the contract the shader side relies on', () => {
    const U = uniformStruct(
      'RowProbe',
      { group: 0, binding: 0, as: 'u' },
      { rows: arrayOf(vec4fT, 9) },
    )
    const block = uniformBlock(U)
    expect(block.byteLength).toBe(144) // 9 × 16, no padding

    const lanes: number[] = []
    for (let j = 0; j < 9; j++) lanes.push(j * 100, j * 100 + 1, j * 100 + 2, j * 100 + 3)
    block.write({ rows: lanes })

    const f = new Float32Array(block.buffer)
    for (let j = 0; j < 9; j++) {
      // `Tile.field.row_trig.at(gy)` reads element gy — it must be at lane 4·gy.
      expect(f[j * 4]).toBe(j * 100)
      expect(f[j * 4 + 3]).toBe(j * 100 + 3)
    }
  })

  // ── the guard must still hold for every hazardous shape ──

  it('still rejects array<f32, N> — std140 pads it to a 16-byte stride', () => {
    const U = uniformStruct(
      'ScalarArray',
      { group: 0, binding: 0, as: 'u' },
      { xs: arrayOf(f32T, 4) },
    )
    expect(() => uniformBlock(U)).toThrow(/needs column\/stride-aware packing/)
  })

  it('still rejects array<vec2<f32>, N> — 8 B element, padded to 16 B stride', () => {
    const U = uniformStruct(
      'Vec2Array',
      { group: 0, binding: 0, as: 'u' },
      { xs: arrayOf(vec2fT, 4) },
    )
    expect(() => uniformBlock(U)).toThrow(/needs column\/stride-aware packing/)
  })

  // (mat3 is not covered here: the DSL exports no f32 mat3 type for a uniform
  // struct, only `mat3f64T`, whose rejection would come from a DIFFERENT branch
  // and would make this a vacuous pass. That branch is untouched by #2137.)
})
