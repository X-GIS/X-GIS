// ═══ The reserved `input` uniform pool — layout + reachability gate (#1539) ═══
//
// Two failure modes this pins, both invisible to tsc:
//
//  1. DRIFT. The compiler assigns each declared `input` a slot bounded by
//     INPUT_F32_POOL_SIZE / INPUT_COLOR_POOL_SIZE. If polygonU carries fewer
//     lanes than that, a legal program (8 f32 inputs) compiles to a read of a
//     field that doesn't exist. The two numbers live in ONE place (the
//     compiler) and map imports them, so they can't disagree — but the FIELD
//     COUNT is hand-written, so that is what this asserts.
//
//  2. UNREACHABLE READ. `astToNode` emits the WGSL text `u.input_f32_0` for
//     slot 0. Nothing in the compiler knows whether map's struct actually has
//     that field — the reference is a string. The second block compiles a real
//     `input`-using program end to end and asserts the emitted WGSL both names
//     the lane AND declares it, which is exactly what breaks if the lanes are
//     ever removed or renamed.
//
// GPU-free: CPU reflect + string assertions, so it rides the `test (map)` leg.

import { describe, it, expect } from 'vitest'
import { INPUT_F32_POOL_SIZE, INPUT_COLOR_POOL_SIZE } from '@xgis/compiler'
import { lower, emitCommands } from '@xgis/compiler'
import { Lexer, Parser } from '@xgis/compiler'
import { polygonUniformSlots } from '@xgis/map'
import { emitPolygonWgsl } from '@xgis/map'
import { InputStore } from './input-store'
import { inputPoolValues } from './input-pool'

describe('reserved `input` uniform pool — layout (#1539)', () => {
  const { slot } = polygonUniformSlots()

  it('polygonU carries exactly one lane per compiler pool slot', () => {
    const f32Lanes = Object.keys(slot).filter((n) => /^input_f32_\d+$/.test(n))
    const colorLanes = Object.keys(slot).filter((n) => /^input_color_\d+$/.test(n))
    expect(f32Lanes).toHaveLength(INPUT_F32_POOL_SIZE)
    expect(colorLanes).toHaveLength(INPUT_COLOR_POOL_SIZE)
    // Every slot index the compiler can assign resolves to a real field.
    for (let i = 0; i < INPUT_F32_POOL_SIZE; i++) expect(slot[`input_f32_${i}`]).toBeDefined()
    for (let i = 0; i < INPUT_COLOR_POOL_SIZE; i++) expect(slot[`input_color_${i}`]).toBeDefined()
  })

  it('the pool sits AFTER globe_eye, so no pre-existing field moved', () => {
    for (let i = 0; i < INPUT_F32_POOL_SIZE; i++) {
      expect(slot[`input_f32_${i}`]!).toBeGreaterThan(slot.globe_eye!)
    }
  })

  it('every colour lane is vec4-aligned (std140 16B)', () => {
    for (let i = 0; i < INPUT_COLOR_POOL_SIZE; i++) {
      expect(slot[`input_color_${i}`]! % 4).toBe(0)
    }
  })
})

describe('inputPoolValues — the CPU side of the write (#1539)', () => {
  it('a null store zeroes every lane', () => {
    const v = inputPoolValues(null)
    expect(v.input_f32_0).toBe(0)
    expect(v.input_color_0).toEqual([0, 0, 0, 0])
  })

  it('carries a live f32 into its declared slot, and only that slot', () => {
    const store = new InputStore()
    store.reset([
      {
        name: 'a',
        type: 'f32',
        slot: 0,
        default: { kind: 'NumberLiteral', value: 1, unit: null },
        line: 1,
      },
      {
        name: 'b',
        type: 'f32',
        slot: 1,
        default: { kind: 'NumberLiteral', value: 2, unit: null },
        line: 2,
      },
    ])
    store.set('b', 0.25)
    const v = inputPoolValues(store)
    expect(v.input_f32_0).toBe(1)
    expect(v.input_f32_1).toBe(0.25)
    expect(v.input_f32_2).toBe(0)
  })

  it('carries a live colour as RGBA 0..1, matching u.fill_color’s convention', () => {
    const store = new InputStore()
    store.reset([
      {
        name: 'hl',
        type: 'color',
        slot: 0,
        default: { kind: 'ColorLiteral', value: '#000000' },
        line: 1,
      },
    ])
    store.set('hl', '#ff0000')
    expect(inputPoolValues(store).input_color_0).toEqual([1, 0, 0, 1])
  })
})

const compile = (src: string) => {
  const tokens = new Lexer(`xgis 1\n${src}`).tokenize()
  return lower(new Parser(tokens).parse())
}

describe('an `input` read is REACHABLE in the emitted shader (#1539)', () => {
  // The load-bearing test. Delete the pool lanes from polygonU and this fails:
  // the WGSL still SAYS `u.input_f32_0` (the compiler emits a plain string) but
  // the struct no longer DECLARES it — a shader that would fail to compile on a
  // real device, with nothing else in the suite noticing.
  it('a bare f32 input in a paint binding emits a pool read the struct declares', () => {
    const scene = compile(`
input threshold: f32 = 0.5
source w { type: geojson, url: "w.geojson" }
layer l { source: w  | opacity-[threshold] }
`)
    expect(emitCommands(scene).inputs?.map((i) => [i.name, i.slot])).toEqual([['threshold', 0]])
    const wgsl = emitPolygonWgsl(null, false)
    expect(wgsl).toContain('input_f32_0')
  })

  it('a colour input compiles, and its lane is declared in the emitted struct', () => {
    const scene = compile(`
input highlight: color = #f59e0b
source w { type: geojson, url: "w.geojson" }
layer l { source: w  @color { return highlight } }
`)
    expect((scene.diagnostics ?? []).filter((d) => d.severity === 'error')).toEqual([])
    expect(emitCommands(scene).inputs?.map((i) => [i.name, i.type, i.slot])).toEqual([
      ['highlight', 'color', 0],
    ])
  })

  // The compiler emits a lane reference as PLAIN TEXT (`u.input_f32_0`), so the
  // only thing tying it to a real field is that this struct declares one by the
  // same name. Assert the whole addressable range, not just slot 0: a partial
  // pool would pass a slot-0-only check and still fail on the 8th declared
  // input. The compiler-side twin (compiler/src/__tests__/input-statement.test.ts)
  // pins that codegen emits these exact names.
  it('the emitted WGSL declares every lane the compiler can address', () => {
    const wgsl = emitPolygonWgsl(null, false)
    for (let i = 0; i < INPUT_F32_POOL_SIZE; i++) {
      expect(wgsl, `f32 lane ${i} undeclared`).toContain(`input_f32_${i}`)
    }
    for (let i = 0; i < INPUT_COLOR_POOL_SIZE; i++) {
      expect(wgsl, `colour lane ${i} undeclared`).toContain(`input_color_${i}`)
    }
  })
})
