import { describe, it, expect, afterEach } from 'vitest'
import { setSourceTracing } from './loc'
import { emitModule } from '../backends/wgsl'
import {
  module, fn, f32T, u32T, vec2fT, vec4fT, f32, vec2, vec4, If,
} from '../ir'
import { ioStruct, builtin, location, uniformStruct } from '../sot'

afterEach(() => setSourceTracing(false))

// Author the SAME shader module from scratch — used twice, once per tracing state. Source
// tracing populates a WeakMap side-table at author time; this proves it never reaches emit.
const build = () => {
  const U = uniformStruct('Uniforms', { group: 0, binding: 0, as: 'u' }, { tint: vec4fT, bias: f32T })
  const VsOut = ioStruct('VsOut', { pos: builtin('position', vec4fT), uv: location(0, vec2fT) })

  const vs = fn('vs_full', { idx: builtin('vertex_index', u32T) }, (p) => {
    const pos = vec2(-1, -1)
    If(p.idx.eq(1), () => { pos.assign(vec2(3, -1)) })
      .elif(p.idx.eq(2), () => { pos.assign(vec2(-1, 3)) })
    return VsOut.construct({ pos: vec4(pos, 0, 1), uv: vec2(pos.x.add(1).mul(0.5), pos.y.add(1).mul(0.5)) })
  }, { stage: 'vertex' })

  const fs = fn('fs_main', { in: VsOut.type }, (p) => {
    const pin = VsOut.of(p.in)
    return vec4(pin.uv.x.add(U.field.bias), pin.uv.y, 0, f32(1))
  }, { stage: 'fragment', retAttr: '@location(0)' })

  return module({ structs: [U.struct, VsOut.decl], bindings: [U.binding], funcs: [vs, fs] })
}

describe('byte-stability: source tracing never changes emitted WGSL', () => {
  it('emit is byte-identical with tracing OFF vs ON', () => {
    setSourceTracing(false)
    const off = emitModule(build())

    setSourceTracing(true)
    const on = emitModule(build())

    expect(on).toBe(off)
  })
})
