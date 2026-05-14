// ═══════════════════════════════════════════════════════════════════
// compute-feature-packer.ts — tests
// ═══════════════════════════════════════════════════════════════════

import { describe, expect, it } from 'vitest'
import { packFeatureData, type FeaturePropertyBag } from './compute-feature-packer'

function bagsFromArray(bags: (FeaturePropertyBag | null)[]) {
  return (fid: number) => bags[fid] ?? null
}

describe('packFeatureData', () => {
  it('empty field list → 0-length array', () => {
    const out = packFeatureData({
      getProps: () => ({}),
      fieldOrder: [],
      categoryOrder: {},
      featureCount: 100,
    })
    expect(out.length).toBe(0)
  })

  it('zero featureCount → 0-length array', () => {
    const out = packFeatureData({
      getProps: () => ({ x: 1 }),
      fieldOrder: ['x'],
      categoryOrder: {},
      featureCount: 0,
    })
    expect(out.length).toBe(0)
  })

  it('numeric field copies value directly', () => {
    const out = packFeatureData({
      getProps: bagsFromArray([{ rank: 5 }, { rank: 12 }, { rank: -3 }]),
      fieldOrder: ['rank'],
      categoryOrder: {},
      featureCount: 3,
    })
    expect(Array.from(out)).toEqual([5, 12, -3])
  })

  it('multiple numeric fields written in fieldOrder + stride', () => {
    const out = packFeatureData({
      getProps: bagsFromArray([
        { a: 1, b: 2 },
        { a: 3, b: 4 },
      ]),
      fieldOrder: ['a', 'b'],
      categoryOrder: {},
      featureCount: 2,
    })
    expect(Array.from(out)).toEqual([1, 2, 3, 4])
  })

  it('boolean → 0 / 1 (for conditional kernel `v_field != 0.0` predicate)', () => {
    const out = packFeatureData({
      getProps: bagsFromArray([
        { school: true },
        { school: false },
        {},  // missing → 0
      ]),
      fieldOrder: ['school'],
      categoryOrder: {},
      featureCount: 3,
    })
    expect(Array.from(out)).toEqual([1, 0, 0])
  })

  it('string-on-numeric-field → 0 (not -1, since no category to miss against)', () => {
    const out = packFeatureData({
      getProps: bagsFromArray([{ x: 'unexpected' }]),
      fieldOrder: ['x'],
      categoryOrder: {},
      featureCount: 1,
    })
    expect(out[0]).toBe(0)
  })

  it('null / undefined → 0', () => {
    const out = packFeatureData({
      getProps: bagsFromArray([{ x: null }, { x: undefined }, { /* missing */ }]),
      fieldOrder: ['x'],
      categoryOrder: {},
      featureCount: 3,
    })
    expect(Array.from(out)).toEqual([0, 0, 0])
  })

  it('NaN / Infinity → 0 (Number.isFinite guard)', () => {
    const out = packFeatureData({
      getProps: bagsFromArray([{ x: NaN }, { x: Infinity }, { x: -Infinity }]),
      fieldOrder: ['x'],
      categoryOrder: {},
      featureCount: 3,
    })
    expect(Array.from(out)).toEqual([0, 0, 0])
  })

  it('categoryOrder field: string maps to alphabetical index', () => {
    const out = packFeatureData({
      getProps: bagsFromArray([
        { class: 'cemetery' },
        { class: 'hospital' },
        { class: 'school' },
      ]),
      fieldOrder: ['class'],
      categoryOrder: {
        class: ['cemetery', 'hospital', 'school'],
      },
      featureCount: 3,
    })
    expect(Array.from(out)).toEqual([0, 1, 2])
  })

  it('categoryOrder field: unmatched string → -1 (kernel else-branch fires)', () => {
    const out = packFeatureData({
      getProps: bagsFromArray([
        { class: 'park' },  // not in list
      ]),
      fieldOrder: ['class'],
      categoryOrder: {
        class: ['cemetery', 'hospital', 'school'],
      },
      featureCount: 1,
    })
    expect(out[0]).toBe(-1)
  })

  it('categoryOrder field: non-string value → -1', () => {
    const out = packFeatureData({
      getProps: bagsFromArray([
        { class: 42 },
        { class: true },
        { class: null },
      ]),
      fieldOrder: ['class'],
      categoryOrder: { class: ['a', 'b'] },
      featureCount: 3,
    })
    expect(Array.from(out)).toEqual([-1, -1, -1])
  })

  it('missing bag (getProps returns null) → row stays zero', () => {
    const out = packFeatureData({
      getProps: bagsFromArray([null, { a: 7 }, null]),
      fieldOrder: ['a'],
      categoryOrder: {},
      featureCount: 3,
    })
    expect(Array.from(out)).toEqual([0, 7, 0])
  })

  it('mixed field types in one entry: stride preserved, each col uses its own rule', () => {
    const out = packFeatureData({
      getProps: bagsFromArray([
        { class: 'school',   rank: 5,  school: true },
        { class: 'hospital', rank: 12, school: false },
        { class: 'unknown',  rank: -3, school: null },
      ]),
      fieldOrder: ['class', 'rank', 'school'],
      categoryOrder: {
        class: ['hospital', 'school'],
      },
      featureCount: 3,
    })
    expect(Array.from(out)).toEqual([
      1, 5, 1,    // school → 1, rank 5, school true → 1
      0, 12, 0,   // hospital → 0, rank 12, school false → 0
      -1, -3, 0,  // unknown → -1, rank -3, school null → 0
    ])
  })

  it('large category list dispatches via Map (correctness, not perf)', () => {
    const patterns = Array.from({ length: 50 }, (_, i) => `pat_${i.toString().padStart(2, '0')}`)
    const out = packFeatureData({
      getProps: bagsFromArray([
        { class: 'pat_00' },
        { class: 'pat_25' },
        { class: 'pat_49' },
        { class: 'pat_99' },  // not in list
      ]),
      fieldOrder: ['class'],
      categoryOrder: { class: patterns },
      featureCount: 4,
    })
    expect(Array.from(out)).toEqual([0, 25, 49, -1])
  })

  it('feature count exceeding available bags zero-fills the trailing rows', () => {
    const out = packFeatureData({
      getProps: bagsFromArray([{ a: 7 }]),
      fieldOrder: ['a'],
      categoryOrder: {},
      featureCount: 5,
    })
    expect(Array.from(out)).toEqual([7, 0, 0, 0, 0])
  })

  it('return type is Float32Array (not plain array)', () => {
    const out = packFeatureData({
      getProps: () => ({ a: 1 }),
      fieldOrder: ['a'],
      categoryOrder: {},
      featureCount: 1,
    })
    expect(out).toBeInstanceOf(Float32Array)
  })
})
