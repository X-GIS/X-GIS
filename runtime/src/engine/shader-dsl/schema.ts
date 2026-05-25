// ═══ Shader DSL — struct schema builder ═══
//
// struct(name, { field: type }) declares a WGSL struct AND gives typed field
// access: helper.get(node, 'field') returns a Node of the field's type, so a
// wrong field name or a type mismatch downstream is a TS error (the AC4
// "WGSL layout error = TS error" mechanism). Byte-offset derivation (std140
// padding) lands in US-P0-7 alongside the wrong-offset probe; the field-type
// map is the part PoC-B (sdf_shape) needs.

import { Node, structT, type ShaderType, type StructDecl } from './ir'

export interface StructHelper<F extends Record<string, ShaderType>> {
  readonly decl: StructDecl
  readonly type: ShaderType
  /** Typed field access on a Node of this struct type. */
  get<K extends keyof F & string>(node: Node, field: K): Node
}

export function struct<F extends Record<string, ShaderType>>(name: string, fields: F): StructHelper<F> {
  const decl: StructDecl = {
    name,
    fields: Object.entries(fields).map(([n, type]) => ({ name: n, type })),
  }
  return {
    decl,
    type: structT(name),
    get: (node, field) => node.field(field, fields[field]),
  }
}
