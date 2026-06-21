import { describe, it, expect } from 'vitest'
import { struct } from './schema'
import { param, structT, vec4fT, vec2fT } from './ir'
import { emitExpr } from './backends/wgsl'

// #1 DX — typed struct field accessor. `Tile.of(node).proj_params` replaces the
// stringly-typed `node.field('proj_params', vec4fT)`: the field name + ShaderType
// vanish, a wrong field is a TS error, and the emitted member Expr is byte-identical.
const Tile = struct('Tile', { proj_params: vec4fT, cam_h: vec2fT, cam_l: vec2fT })

describe('schema — typed struct field accessor (#1 DX)', () => {
  const n = param('tile', structT('Tile'))

  it('of(node).field emits identically to node.field(name, type)', () => {
    expect(emitExpr(Tile.of(n).proj_params.expr)).toBe(emitExpr(n.field('proj_params', vec4fT).expr))
    expect(emitExpr(Tile.of(n).cam_h.expr)).toBe(emitExpr(n.field('cam_h', vec2fT).expr))
  })

  it('a wrong field name throws (and is a TS error)', () => {
    // @ts-expect-error — 'nope' is not a field of Tile
    expect(() => Tile.of(n).nope).toThrow()
  })
})
