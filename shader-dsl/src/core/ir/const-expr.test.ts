// ═══ Non-scalar module constants (ConstDecl.valueExpr / constExpr) ═══
// Vector / array / struct constants are first-class: WGSL + GLSL emit the
// literal expression, and the CPU oracle evaluates it. The scalar dual-precision
// path (wgslValue/cpuValue) stays the default for ordinary f32 consts.

import { describe, it, expect } from 'vitest'
import { module, constExpr, fn } from './builder'
import { vec4, arrayLit, constRef } from './node'
import { vec4fT, f32T, arrayT } from './types'
import { emitModule } from '../backends/wgsl'
import { emitGlslModule } from '../backends/glsl'
import { compileModule } from '../oracle'

describe('ConstDecl.valueExpr — non-scalar module constants', () => {
  const fillConst = constExpr('FILL', vec4fT, vec4(1, 0, 0, 1))
  const palConst = constExpr(
    'PAL',
    arrayT(vec4fT, 2),
    arrayLit(vec4fT, vec4(1, 0, 0, 1), vec4(0, 1, 0, 1)),
  )
  // A fn referencing the consts so they survive any dead-decl elimination.
  const getFill = fn('get_fill', {}, () => constRef('FILL', vec4fT))

  it('WGSL emits a vec4 const as the literal constructor', () => {
    const wgsl = emitModule(module({ consts: [fillConst], funcs: [getFill] }))
    expect(wgsl).toContain('const FILL: vec4<f32> = vec4<f32>(1.0, 0.0, 0.0, 1.0);')
  })

  it('WGSL emits an array<vec4> const literal', () => {
    const wgsl = emitModule(module({ consts: [palConst], funcs: [fn('p', {}, () => constRef('PAL', arrayT(vec4fT, 2)))] }))
    expect(wgsl).toContain('const PAL: array<vec4<f32>, 2> = array<vec4<f32>, 2>(vec4<f32>(1.0, 0.0, 0.0, 1.0), vec4<f32>(0.0, 1.0, 0.0, 1.0));')
  })

  it('GLSL emits the vec4 const with GLSL spelling', () => {
    const glsl = emitGlslModule(module({ consts: [fillConst], funcs: [getFill] }))
    expect(glsl).toContain('const vec4 FILL = vec4(1.0, 0.0, 0.0, 1.0);')
  })

  it('the CPU oracle evaluates a vec4 const to its component array', () => {
    const cpu = compileModule(module({ consts: [fillConst], funcs: [getFill] }))
    expect(cpu.fns.get_fill()).toEqual([1, 0, 0, 1])
  })

  it('scalar consts still use the dual-precision wgslValue/cpuValue path', () => {
    const pi = { name: 'PI', type: f32T, wgslValue: 3.14159265, cpuValue: Math.PI }
    const m = module({ consts: [pi], funcs: [fn('get_pi', {}, () => constRef('PI'))] })
    expect(emitModule(m)).toContain('const PI: f32 = 3.14159265;')
    expect(compileModule(m).fns.get_pi()).toBe(Math.PI)
  })
})
