import { describe, it, expect } from 'vitest'
import { ioStruct, builtin, location, uniformStruct, resource, storageBuffer, structDecl, arrayOf } from './sot'
import { member, param, bindingRef, structT, vec4fT, vec2fT, vec3fT, f32T, u32T, texture2dfT, arrayT, fn, module, Var } from './ir'
import { emitExpr, emitModule } from './backends/wgsl'

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
  it('derives the StructDecl exactly as the hand-written form (+ structured attrs, #740 R3)', () => {
    expect(VsOut.decl).toEqual({
      name: 'VsOut',
      fields: [
        { name: 'clip_pos', type: vec4fT, attr: '@builtin(position)', builtin: 'position' },
        { name: 'uv', type: vec2fT, attr: '@location(0)', location: 0 },
        { name: 'opacity', type: f32T, attr: '@location(1)', location: 1 },
        { name: 'tint', type: vec3fT, attr: '@location(2)', location: 2 },
        { name: 'sdf', type: f32T, attr: '@location(3) @interpolate(flat)', location: 3, interpolate: 'flat' },
      ],
    })
  })

  it('derives the struct type', () => {
    expect(VsOut.type).toEqual(structT('VsOut'))
  })

  it('of(node) is typed field access identical to member(node, name, type)', () => {
    const n = param('in', structT('VsOut'))
    expect(emitExpr(VsOut.of(n).uv.expr)).toBe(emitExpr(member(n, 'uv', vec2fT).expr))
    expect(emitExpr(VsOut.of(n).sdf.expr)).toBe(emitExpr(member(n, 'sdf', f32T).expr))
  })

  it('.var() fuses the Var(T.type) + .of(out) output stub — byte-identical emit (#740 R6c)', () => {
    const emitF = (f: ReturnType<typeof fn>): string => emitModule(module({ funcs: { f } }))
    const viaVar = emitF(fn('f', {}, () => {
      const o = VsOut.var('out')
      o.opacity.assign(o.opacity.mul(0))
      return o.$
    }))
    const viaStub = emitF(fn('f', {}, () => {
      const out = Var('out', VsOut.type)
      const o = VsOut.of(out)
      o.opacity.assign(o.opacity.mul(0))
      return out
    }))
    expect(viaVar).toBe(viaStub)
    // Anonymous form still declares a var (auto-named).
    expect(emitF(fn('f', {}, () => VsOut.var().$))).toContain('var ')
  })
})

describe('sot — uniformStruct + resource (single source of truth for bindings)', () => {
  const U = uniformStruct('Uniforms', { group: 0, binding: 0, as: 'u' }, { viewport: vec2fT, _pad0: f32T })

  it('derives the StructDecl, the binding decl, and typed field access', () => {
    expect(U.struct).toEqual({ name: 'Uniforms', fields: [{ name: 'viewport', type: vec2fT }, { name: '_pad0', type: f32T }] })
    expect(U.binding).toEqual({ group: 0, binding: 0, name: 'u', space: 'uniform', type: structT('Uniforms') })
    expect(emitExpr(U.field.viewport.expr)).toBe(emitExpr(member(bindingRef('u', structT('Uniforms')), 'viewport', vec2fT).expr))
  })

  it('resource derives a non-struct binding decl + access node', () => {
    const tex = resource('atlas_tex', texture2dfT, { group: 0, binding: 1 })
    expect(tex.binding).toEqual({ group: 0, binding: 1, name: 'atlas_tex', space: 'uniform', type: texture2dfT })
    expect(emitExpr(tex.node.expr)).toBe(emitExpr(bindingRef('atlas_tex', texture2dfT).expr))
  })

  it('storageBuffer derives an array<element> storage binding + .at(i) reads the scalar element', () => {
    const buf = storageBuffer('feat_data', f32T, { group: 0, binding: 0, access: 'read' })
    expect(buf.binding).toEqual({ group: 0, binding: 0, name: 'feat_data', space: 'storage', access: 'read', type: arrayT(f32T) })
    expect(emitExpr(buf.node.expr)).toBe(emitExpr(bindingRef('feat_data', arrayT(f32T)).expr))
    expect(emitExpr(buf.at(3).expr)).toBe(emitExpr(bindingRef('feat_data', arrayT(f32T)).at(3, f32T).expr))
  })

  it('storageBuffer .at(i) on a struct element gives the typed field proxy (no .of/.field)', () => {
    const Seg = structDecl('Seg', { a: f32T, b: vec2fT })
    const buf = storageBuffer('segs', Seg, { group: 0, binding: 1, access: 'read' })
    expect(buf.binding.type).toEqual(arrayT(structT('Seg')))
    // buf.at(i).a  emits  segs[i].a  — same member Expr the old `Seg.of(segs.at(i)).a` produced.
    expect(emitExpr(buf.at(2).a.expr)).toBe(emitExpr(member(bindingRef('segs', arrayT(structT('Seg'))).at(2, structT('Seg')), 'a', f32T).expr))
  })

  it('arrayOf(handle, n) uniform field declares array<T, n> and .at(i) gives the typed proxy (#740 R6c)', () => {
    const Slot = structDecl('Slot', { id: u32T, size: f32T })
    const L = uniformStruct('Layer', { group: 1, binding: 0, as: 'layer' }, {
      mpp: f32T,
      slots: arrayOf(Slot, 3),
    })
    // Declared WGSL type is the same array<Slot, 3> the plain arrayT spelling produced.
    expect(L.struct).toEqual({
      name: 'Layer',
      fields: [{ name: 'mpp', type: f32T }, { name: 'slots', type: arrayT(structT('Slot'), 3) }],
    })
    // layer.slots[k].id — same Expr chain as the old Slot.of(L.field.slots.at(k, Slot.type)).id.
    const node = bindingRef('layer', structT('Layer'))
    const old = member(member(node, 'slots', arrayT(structT('Slot'), 3)).at(2, structT('Slot')), 'id', u32T)
    expect(emitExpr(L.field.slots.at(2).id.expr)).toBe(emitExpr(old.expr))
    // Unknown field still throws.
    expect(() => (L.field as Record<string, unknown>).nope).toThrow(/no field/)
  })
})
