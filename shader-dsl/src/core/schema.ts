// ═══ Shader DSL — struct schema builder ═══
//
// struct(name, { field: type }) declares a WGSL struct AND gives typed field
// access: helper.get(node, 'field') returns a Node of the field's type, so a
// wrong field name or a type mismatch downstream is a TS error (the AC4
// "WGSL layout error = TS error" mechanism). Byte-offset derivation (std140
// padding) lands in US-P0-7 alongside the wrong-offset probe; the field-type
// map is the part PoC-B (sdf_shape) needs.

import { Node, structT, type ShaderType, type StructDecl, type KeyOf } from './ir'

export interface StructHelper<F extends Record<string, ShaderType>> {
  readonly decl: StructDecl
  readonly type: ShaderType
  /** Typed field access on a Node of this struct type — the returned Node is
   *  keyed by the field's ShaderType, so a wrong field name (not in F) or a
   *  downstream type mismatch is a TS compile error (the AC4 gate). */
  get<K extends keyof F & string>(node: Node, field: K): Node<KeyOf<F[K]>>
  /** Typed field ACCESSOR over a Node of this struct type — `Foo.of(node).bar` is
   *  `node.field('bar', F['bar'])`, so the per-field string + ShaderType vanish and
   *  a wrong field name is a TS error. Emit is byte-identical (same member Expr). */
  of(node: Node): { readonly [K in keyof F]: Node<KeyOf<F[K]>> }
}

/**
 * @deprecated Superseded by `structDecl` in `core/sot` — the single home for the SoT
 * struct/binding helpers (uniformStruct / ioStruct / structDecl / storageBuffer / resource).
 * `structDecl` is a byte-identical superset (same `.decl` / `.type` / `.of` / `.get`). This
 * `struct()` has no remaining consumers; kept only for the deprecation window before removal.
 */
export function struct<F extends Record<string, ShaderType>>(name: string, fields: F): StructHelper<F> {
  const decl: StructDecl = {
    name,
    fields: Object.entries(fields).map(([n, type]) => ({ name: n, type })),
  }
  return {
    decl,
    type: structT(name),
    get<K extends keyof F & string>(node: Node, field: K): Node<KeyOf<F[K]>> {
      return node.field(field, fields[field])
    },
    of(node: Node) {
      return new Proxy({} as Record<string, Node>, {
        get: (_t, prop) => {
          const t = fields[prop as string]
          if (t === undefined) throw new Error(`shader-dsl: struct '${name}' has no field '${String(prop)}'`)
          return node.field(prop as string, t)
        },
      }) as { readonly [K in keyof F]: Node<KeyOf<F[K]>> }
    },
  }
}
