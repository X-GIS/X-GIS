// ═══ Shader DSL — single source of truth for IO structs & bound resources ═══
//
// Today a vertex/uniform layout is declared in up to FOUR places that must agree by
// hand: the StructDecl (fields + @location/@builtin attrs), the binding decl
// ({group,binding,name,space,type}), the bindingRef node, and every `.field('name',
// type)` access. Drift between them is a whole class of bug (the polygon slot-drift
// family, OPACITY). The SoT helpers declare a layout ONCE and DERIVE the rest, so the
// pieces cannot disagree and the type checker covers field names + types.

import { Node, structT, bindingRef, type ShaderType, type StructDecl, type KeyOf, type BindingDecl, type AddressSpace } from './ir'

export interface FieldSpec<T extends ShaderType = ShaderType> {
  readonly type: T
  readonly attr: string
}

/** A `@builtin(<name>)` IO field (e.g. builtin('position', vec4fT)). */
export const builtin = <T extends ShaderType>(name: string, type: T): FieldSpec<T> => ({
  type,
  attr: `@builtin(${name})`,
})

/** A `@location(<n>)` IO field, with optional `@interpolate(<mode>)` (e.g. 'flat'). */
export const location = <T extends ShaderType>(n: number, type: T, interpolate?: string): FieldSpec<T> => ({
  type,
  attr: `@location(${n})${interpolate ? ` @interpolate(${interpolate})` : ''}`,
})

export interface IoStruct<F extends Record<string, FieldSpec>> {
  readonly decl: StructDecl
  readonly type: ShaderType
  /** Typed field access on a value of this struct — `VsOut.of(node).uv` is
   *  `node.field('uv', <its type>)`, so the field name + type are checked and the
   *  emitted member Expr is byte-identical. */
  of(node: Node): { readonly [K in keyof F]: Node<KeyOf<F[K]['type']>> }
}

/** Declare an IO struct (vertex/fragment in/out) from one field map; derive the
 *  StructDecl (with attrs), the struct type, and typed field access. */
export function ioStruct<F extends Record<string, FieldSpec>>(name: string, fields: F): IoStruct<F> {
  const decl: StructDecl = {
    name,
    fields: Object.entries(fields).map(([n, spec]) => ({ name: n, type: spec.type, attr: spec.attr })),
  }
  return {
    decl,
    type: structT(name),
    of(node: Node) {
      return new Proxy({} as Record<string, Node>, {
        get: (_t, prop) => {
          const spec = fields[prop as string]
          if (spec === undefined) throw new Error(`sot: ioStruct '${name}' has no field '${String(prop)}'`)
          return node.field(prop as string, spec.type)
        },
      }) as { readonly [K in keyof F]: Node<KeyOf<F[K]['type']>> }
    },
  }
}

export interface UniformStruct<F extends Record<string, ShaderType>> {
  readonly struct: StructDecl
  readonly binding: BindingDecl
  readonly node: Node
  readonly field: { readonly [K in keyof F]: Node<KeyOf<F[K]>> }
}

/** Declare a uniform-buffer struct + its binding from one place; derive the StructDecl,
 *  the binding decl, the access node, and typed field access. `at.as` is the WGSL var name. */
export function uniformStruct<F extends Record<string, ShaderType>>(
  typeName: string,
  at: { group: number; binding: number; as: string },
  fields: F,
): UniformStruct<F> {
  const struct: StructDecl = { name: typeName, fields: Object.entries(fields).map(([n, type]) => ({ name: n, type })) }
  const type = structT(typeName)
  const node = bindingRef(at.as, type)
  return {
    struct,
    binding: { group: at.group, binding: at.binding, name: at.as, space: 'uniform', type },
    node,
    field: new Proxy({} as Record<string, Node>, {
      get: (_t, prop) => {
        const t = fields[prop as string]
        if (t === undefined) throw new Error(`sot: uniformStruct '${typeName}' has no field '${String(prop)}'`)
        return node.field(prop as string, t)
      },
    }) as { readonly [K in keyof F]: Node<KeyOf<F[K]>> },
  }
}

export interface Resource {
  readonly binding: BindingDecl
  readonly node: Node
}

/** A non-struct bound resource (texture / sampler): derive its binding decl + access
 *  node from one place. Space defaults to 'uniform' (the texture/sampler convention). */
export function resource(name: string, type: ShaderType, at: { group: number; binding: number; space?: AddressSpace }): Resource {
  return {
    binding: { group: at.group, binding: at.binding, name, space: at.space ?? 'uniform', type },
    node: bindingRef(name, type),
  }
}
