import { describe, it, expect } from 'vitest'
import { fn, module, f32T, vec2fT, vec3fT, vec4fT, vec4uT, type FuncDecl } from './index'
import { emitModule } from '../backends/wgsl'

// ═══ #740 R9 — notation: scalar×vec broadcast + inferred swizzles ═══

const emitOne = (f: FuncDecl): string => emitModule(module({ funcs: [f] }))

describe('scalar-node × vec-node broadcast', () => {
  it('t.add(vec3) types and emits as ONE broadcast op (the julia.ts unroll case)', () => {
    const g = fn('bcast', { t: f32T, ph: vec3fT }, ({ t, ph }) => {
      const v = t.add(ph) // Node<'vec3<f32>'>
      return v.mul(0.5).x
    })
    expect(emitOne(g)).toContain('(t + ph)')
  })

  it('vec2+vec3 mixing is still rejected (binResultType, unchanged)', () => {
    expect(() => fn('bad2', { a: vec2fT, b: vec3fT }, ({ a, b }) => a.add(b as never).x)).toThrow(
      /SD0002/,
    )
  })
})

describe('inferred swizzles', () => {
  it('infers the result key from the components string', () => {
    const g = fn('swz', { v: vec4fT }, ({ v }) => v.swizzle('yx').x)
    expect(emitOne(g)).toContain('v.yx')
  })

  it('works on u32 vectors (impossible with the old f32-only getters)', () => {
    const h = fn('swzu', { u: vec4uT }, ({ u }) => u.swizzle('wzy').x)
    const wgsl = emitOne(h)
    expect(wgsl).toContain('u.wzy')
    expect(wgsl).toContain('-> u32') // elem-typed result, not a lied f32
  })

  it('rgba aliases resolve against the lane count', () => {
    const g = fn('swzc', { c: vec4fT }, ({ c }) => c.swizzle('bgra').x)
    expect(emitOne(g)).toContain('c.bgra')
  })

  it('validates components and lane bounds', () => {
    expect(() => fn('bad3', { v: vec4fT }, ({ v }) => v.swizzle('xq').x)).toThrow(/not a component/)
    expect(() => fn('bad4', { v: vec2fT }, ({ v }) => v.swizzle('xyz' as 'xy').x)).toThrow()
  })
})
