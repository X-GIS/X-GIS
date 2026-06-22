// ═══ Shader DSL — single source of truth for IO structs & bound resources ═══
//
// Today a vertex/uniform layout is declared in up to FOUR places that must agree by
// hand: the StructDecl (fields + @location/@builtin attrs), the binding decl
// ({group,binding,name,space,type}), the bindingRef node, and every `.field('name',
// type)` access. Drift between them is a whole class of bug (the polygon slot-drift
// family, OPACITY). The SoT helpers declare a layout ONCE and DERIVE the rest, so the
// pieces cannot disagree and the type checker covers field names + types.

import { Node, structT, bindingRef, construct, member, type ShaderType, type StructDecl, type KeyOf, type BindingDecl, type AddressSpace } from './ir'

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
   *  emitted member Expr is byte-identical. NonNullable strips the `| undefined` a
   *  conditional-field spread (`...(cond ? { pick } : {})`) introduces, so optional
   *  output fields stay `Node`, not `Node | undefined`. */
  of(node: Node): { readonly [K in keyof F]-?: Node<KeyOf<NonNullable<F[K]>['type']>> }
  /** Build a value of this struct in ONE expression — `LineOut(f0, f1, …)` — instead of a
   *  mutable `var out; out.f0 = …; return out`. Args are taken in field-declaration order, so a
   *  wrong/missing field is a TS error. Replaces the imperative field-by-field output build. */
  construct(values: { readonly [K in keyof F]: Node<KeyOf<NonNullable<F[K]>['type']>> }): Node
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
          return member(node, prop as string, spec.type)
        },
      }) as { readonly [K in keyof F]-?: Node<KeyOf<NonNullable<F[K]>['type']>> }
    },
    construct(values: Record<string, Node>) {
      return construct(structT(name), decl.fields.map((f) => values[f.name]))
    },
  }
}

export interface PlainStruct<F extends Record<string, ShaderType>> {
  readonly decl: StructDecl
  readonly type: ShaderType
  /** Typed field access for a value of this struct — e.g. an array<T> storage element
   *  read via `Seg.of(segments.at(i)).p0_h`; replaces `node.field('p0_h', vec2fT)`. */
  of(node: Node): { readonly [K in keyof F]: Node<KeyOf<F[K]>> }
  /** Positional field access — `Seg.get(node, 'p0_h')` is `node.field('p0_h', <type>)`,
   *  a wrong field name a TS error. Same as `.of(node).p0_h`; kept for call sites that
   *  read many fields off a shared shorthand (`const g = Seg.get`). */
  get<K extends keyof F & string>(node: Node, field: K): Node<KeyOf<F[K]>>
}

/** Declare a plain (non-binding, non-IO) struct — a storage-buffer element type used in
 *  `array<T>`, or a nested struct — from one field map; derive the StructDecl, the struct
 *  type (`.type` replaces every `structT('Name')` string), and typed field access. The one
 *  struct kind the binding/IO helpers don't cover, so a layout has exactly ONE declaration. */
export function structDecl<F extends Record<string, ShaderType>>(name: string, fields: F): PlainStruct<F> {
  const decl: StructDecl = { name, fields: Object.entries(fields).map(([n, type]) => ({ name: n, type })) }
  const type = structT(name)
  return {
    decl,
    type,
    get<K extends keyof F & string>(node: Node, field: K): Node<KeyOf<F[K]>> {
      return member(node, field, fields[field])
    },
    of(node: Node) {
      return new Proxy({} as Record<string, Node>, {
        get: (_t, prop) => {
          const t = fields[prop as string]
          if (t === undefined) throw new Error(`sot: structDecl '${name}' has no field '${String(prop)}'`)
          return member(node, prop as string, t)
        },
      }) as { readonly [K in keyof F]: Node<KeyOf<F[K]>> }
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
        return member(node, prop as string, t)
      },
    }) as { readonly [K in keyof F]: Node<KeyOf<F[K]>> },
  }
}

export interface Resource<T extends ShaderType = ShaderType> {
  readonly binding: BindingDecl
  readonly node: Node<KeyOf<T>>
}

/** A non-struct bound resource (texture / sampler): derive its binding decl + access
 *  node from one place. Generic over the resource type, so `r.node` keeps the SPECIFIC key
 *  (`Node<'texture_2d<f32>'>`, `Node<'sampler'>`) and texture/sampler ops are type-checked —
 *  not the widened `Node`. Space defaults to 'uniform' (the texture/sampler convention). */
export function resource<T extends ShaderType>(name: string, type: T, at: { group: number; binding: number; space?: AddressSpace }): Resource<T> {
  return {
    binding: { group: at.group, binding: at.binding, name, space: at.space ?? 'uniform', type },
    node: bindingRef(name, type),
  }
}

/** A storage buffer binding (e.g. `array<f32>` feature data): derive its binding decl
 *  (space 'storage' + the access mode) + access node from one place. Closes the gap
 *  resource() left — resource is uniform-only. */
export function storageBuffer(
  name: string,
  type: ShaderType,
  at: { group: number; binding: number; access: 'read' | 'read_write' },
): Resource {
  return {
    binding: { group: at.group, binding: at.binding, name, space: 'storage', access: at.access, type },
    node: bindingRef(name, type),
  }
}
