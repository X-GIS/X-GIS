// ═══ InputStore — the host contract for `map.setInput()` (#1539) ═══
//
// The behaviours here ARE the public contract, so they are pinned directly
// rather than through the map: a typo'd name must throw (not silently do
// nothing — the failure `input` exists to remove), a type mismatch must throw
// before it can reach a uniform lane, and a restyle must not snap a host-driven
// value back to its compile-time default.

import { describe, it, expect } from 'vitest'
import type { ResolvedInputInfo } from '@xgis/compiler'
import { InputStore } from './input-store'
import { INPUT_KEY_PREFIX } from '@xgis/compiler'

const f32 = (name: string, slot: number, value = 0.5): ResolvedInputInfo => ({
  name,
  type: 'f32',
  slot,
  default: { kind: 'NumberLiteral', value, unit: null },
  line: 1,
})
const color = (name: string, slot: number, value = '#000000'): ResolvedInputInfo => ({
  name,
  type: 'color',
  slot,
  default: { kind: 'ColorLiteral', value },
  line: 1,
})

describe('InputStore — declarations and defaults', () => {
  it('seeds every declared input with its compile-time default', () => {
    const s = new InputStore()
    s.reset([f32('threshold', 0, 0.25), color('hl', 0, '#ff0000')])
    expect(s.get('threshold')).toBe(0.25)
    expect(s.get('hl')).toBe('#ff0000')
    expect(s.names()).toEqual(['threshold', 'hl'])
  })

  it('an undeclared name reads undefined', () => {
    expect(new InputStore().get('nope')).toBeUndefined()
  })

  it('toEvalInputs is stable between mutations (no per-feature allocation)', () => {
    const s = new InputStore()
    s.reset([f32('a', 0)])
    expect(s.toEvalInputs()).toBe(s.toEvalInputs())
    s.set('a', 0.9)
    expect(s.toEvalInputs()).toEqual({ a: 0.9 })
  })

  it('the eval bag keys by bare name — makeEvalProps applies the sigil', () => {
    const s = new InputStore()
    s.reset([f32('a', 0)])
    expect(Object.keys(s.toEvalInputs())).toEqual(['a'])
    expect(Object.keys(s.toEvalInputs())[0]).not.toContain(INPUT_KEY_PREFIX)
  })
})

describe('InputStore.set — throws instead of silently doing nothing', () => {
  const seeded = () => {
    const s = new InputStore()
    s.reset([f32('threshold', 0), color('hl', 0)])
    return s
  }

  it('an unknown name throws, and names the declared inputs', () => {
    expect(() => seeded().set('treshold', 1)).toThrow(/no `input treshold` is declared/)
    expect(() => seeded().set('treshold', 1)).toThrow(/threshold, hl/)
  })

  it('a non-number for an f32 input throws', () => {
    expect(() => seeded().set('threshold', '#ff0000')).toThrow(/declared `: f32`/)
    expect(() => seeded().set('threshold', NaN)).toThrow(/finite number/)
  })

  it('a non-colour for a colour input throws — including a malformed hex', () => {
    expect(() => seeded().set('hl', 1)).toThrow(/declared `: color`/)
    expect(() => seeded().set('hl', 'red')).toThrow(/hex colour string/)
    expect(() => seeded().set('hl', '#gg0000')).toThrow(/hex colour string/)
  })

  it('reports whether the value actually changed, so the caller can skip a redraw', () => {
    const s = seeded()
    expect(s.set('threshold', 0.9)).toBe(true)
    expect(s.set('threshold', 0.9)).toBe(false)
  })
})

describe('InputStore.reset — restyle semantics', () => {
  it('keeps a host-set value when the new style still declares it at the same type', () => {
    const s = new InputStore()
    s.reset([f32('threshold', 0, 0.5)])
    s.set('threshold', 0.9)
    s.reset([f32('threshold', 0, 0.5)])
    expect(s.get('threshold')).toBe(0.9)
  })

  it('re-seeds when the declared TYPE changed under the same name', () => {
    const s = new InputStore()
    s.reset([f32('x', 0)])
    s.set('x', 0.9)
    s.reset([color('x', 0, '#123456')])
    expect(s.get('x')).toBe('#123456')
  })

  it('drops a name the new style no longer declares', () => {
    const s = new InputStore()
    s.reset([f32('gone', 0)])
    s.reset([f32('kept', 0)])
    expect(s.get('gone')).toBeUndefined()
    expect(() => s.set('gone', 1)).toThrow()
  })

  it('a style with no inputs clears the pool lanes', () => {
    const s = new InputStore()
    s.reset([f32('a', 0, 1)])
    expect(s.f32Slots[0]).toBe(1)
    s.reset(undefined)
    expect(s.f32Slots[0]).toBe(0)
    expect(s.names()).toEqual([])
  })
})
