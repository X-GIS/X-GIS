import { describe, it, expect } from 'vitest'
import { ioStruct, builtin, location, uniformStruct, resource } from './sot'
import { param, bindingRef, structT, vec4fT, vec2fT, vec3fT, f32T, texture2dfT } from './ir'
import { emitExpr } from './backends/wgsl'

// Single-source-of-truth for an IO struct. One declaration derives the StructDecl (with
// the @builtin/@location/@interpolate attrs), the struct type, and typed field access —
// replacing the hand-written StructDecl + separate `.field('name', type)` access (which
// must currently agree by hand). `decl` must byte-match the hand form so emit is unchanged.
const VsOut = ioStruct('VsOut', {
  clip_pos: builtin('position', vec4fT),
  uv: location(0, vec2fT),
  opacity: location(1, f32T),
  tint: location(2, vec3fT),
  sdf: location(3, f32T, 'flat'),
})

describe('sot — ioStruct (single source of truth for IO structs)', () => {
  it('derives the StructDecl exactly as the hand-written form', () => {
    expect(VsOut.decl).toEqual({
      name: 'VsOut',
      fields: [
        { name: 'clip_pos', type: vec4fT, attr: '@builtin(position)' },
        { name: 'uv', type: vec2fT, attr: '@location(0)' },
        { name: 'opacity', type: f32T, attr: '@location(1)' },
        { name: 'tint', type: vec3fT, attr: '@location(2)' },
        { name: 'sdf', type: f32T, attr: '@location(3) @interpolate(flat)' },
      ],
    })
  })

  it('derives the struct type', () => {
    expect(VsOut.type).toEqual(structT('VsOut'))
  })

  it('of(node) is typed field access identical to node.field(name, type)', () => {
    const n = param('in', structT('VsOut'))
    expect(emitExpr(VsOut.of(n).uv.expr)).toBe(emitExpr(n.field('uv', vec2fT).expr))
    expect(emitExpr(VsOut.of(n).sdf.expr)).toBe(emitExpr(n.field('sdf', f32T).expr))
  })
})

describe('sot — uniformStruct + resource (single source of truth for bindings)', () => {
  const U = uniformStruct('Uniforms', { group: 0, binding: 0, as: 'u' }, { viewport: vec2fT, _pad0: f32T })

  it('derives the StructDecl, the binding decl, and typed field access', () => {
    expect(U.struct).toEqual({ name: 'Uniforms', fields: [{ name: 'viewport', type: vec2fT }, { name: '_pad0', type: f32T }] })
    expect(U.binding).toEqual({ group: 0, binding: 0, name: 'u', space: 'uniform', type: structT('Uniforms') })
    expect(emitExpr(U.field.viewport.expr)).toBe(emitExpr(bindingRef('u', structT('Uniforms')).field('viewport', vec2fT).expr))
  })

  it('resource derives a non-struct binding decl + access node', () => {
    const tex = resource('atlas_tex', texture2dfT, { group: 0, binding: 1 })
    expect(tex.binding).toEqual({ group: 0, binding: 1, name: 'atlas_tex', space: 'uniform', type: texture2dfT })
    expect(emitExpr(tex.node.expr)).toBe(emitExpr(bindingRef('atlas_tex', texture2dfT).expr))
  })
})
