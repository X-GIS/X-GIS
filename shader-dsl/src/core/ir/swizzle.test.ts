import { describe, it, expect } from 'vitest'
import { param, vec3fT, vec4fT, vec2fT, module, fn } from './index'
import { emitExpr } from '../backends/wgsl'
import { compileModule } from '../oracle'

// Multi-component swizzle getters (w.zxy etc.) — readability over vec3(w.z, w.x, w.y) or
// the untyped swizzle<'vec3<f32>'>('zxy'). Each getter is a pure alias of .swizzle(), so the
// emitted IR is byte-identical, and the CPU oracle reorders components per the swizzle.
const v = param('v', vec3fT)

describe('ir — multi-component swizzle getters', () => {
  it('each getter emits identically to the explicit .swizzle(comps)', () => {
    expect(emitExpr(v.zxy.expr)).toBe(emitExpr(v.swizzle('zxy').expr))
    expect(emitExpr(v.yzx.expr)).toBe(emitExpr(v.swizzle('yzx').expr))
    expect(emitExpr(v.xyz.expr)).toBe(emitExpr(v.swizzle('xyz').expr))
    expect(emitExpr(v.zyx.expr)).toBe(emitExpr(v.swizzle('zyx').expr))
    expect(emitExpr(v.xy.expr)).toBe(emitExpr(v.swizzle('xy').expr))
    expect(emitExpr(param('c', vec4fT).bgra.expr)).toBe(
      emitExpr(param('c', vec4fT).swizzle('bgra').expr),
    )
  })

  it('the emitted WGSL is the dotted swizzle', () => {
    expect(emitExpr(v.zxy.expr)).toBe('v.zxy')
    expect(emitExpr(v.yzx.expr)).toBe('v.yzx')
  })

  it('CPU eval reorders components per the swizzle', () => {
    const m = compileModule(
      module({
        funcs: [
          fn('zxy', { p: vec3fT }, vec3fT, ({ p }, _b) => p.zxy),
          fn('yzx', { p: vec3fT }, vec3fT, ({ p }, _b) => p.yzx),
          fn('xy', { p: vec3fT }, vec2fT, ({ p }, _b) => p.xy),
        ],
      }),
    )
    expect(m.fns.zxy([1, 2, 3])).toEqual([3, 1, 2]) // [z,x,y]
    expect(m.fns.yzx([1, 2, 3])).toEqual([2, 3, 1]) // [y,z,x]
    expect(m.fns.xy([1, 2, 3])).toEqual([1, 2]) //     [x,y]
  })
})
