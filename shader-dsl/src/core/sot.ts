// ═══ Shader DSL — single source of truth for IO structs & bound resources ═══
//
// Before this layer, a vertex/uniform layout was declared in up to FOUR places that
// had to agree by hand: the StructDecl (fields + @location/@builtin attrs), the
// binding decl ({group,binding,name,space,type}), the bindingRef node, and every
// stringly member access (the since-removed `node.field('name', type)` — #763 H5).
// Drift between them is a whole class of bug (the polygon slot-drift family,
// OPACITY). The SoT helpers declare a layout ONCE and DERIVE the rest, so the
// pieces cannot disagree and the type checker covers field names + types.

import {
  Node,
  ReadonlyNode,
  structT,
  bindingRef,
  construct,
  member,
  arrayT,
  Var,
  constRef,
  type ShaderType,
  type StructDecl,
  type ConstDecl,
  type KeyOf,
  type ScalarKey,
  type BindingDecl,
  type AddressSpace,
} from './ir'

/** A module-level constant declared ONCE (#763 X2) — the missing SoT declarator.
 *  `decl` goes into module() (or `uses:`), `node` is the typed reference; the
 *  cross-file ConstDecl↔constRef('NAME') string contract is gone (a typo'd name
 *  used to compile and die at WGSL). */
export interface ConstHandle<T extends ShaderType> {
  readonly decl: ConstDecl
  readonly node: ReadonlyNode<KeyOf<T>>
}
export function constDecl<T extends ShaderType>(
  name: string,
  type: T,
  values: { readonly wgsl: number; readonly cpu: number },
): ConstHandle<T> {
  return {
    decl: { name, type, wgslValue: values.wgsl, cpuValue: values.cpu },
    node: constRef(name, type),
  }
}

export interface FieldSpec<T extends ShaderType = ShaderType> {
  readonly type: T
  /** The WGSL emit spelling. Backends never re-parse it — the structured
   *  fields below are the semantic source (#740 R3). */
  readonly attr: string
  readonly location?: number
  readonly builtin?: string
  readonly interpolate?: string
}

/** A `@builtin(<name>)` IO field (e.g. builtin('position', vec4fT)). */
export const builtin = <T extends ShaderType>(name: string, type: T): FieldSpec<T> => ({
  type,
  attr: `@builtin(${name})`,
  builtin: name,
})

/** A `@location(<n>)` IO field, with optional `@interpolate(<mode>)` (e.g. 'flat'). */
export const location = <T extends ShaderType>(
  n: number,
  type: T,
  interpolate?: string,
): FieldSpec<T> => ({
  type,
  attr: `@location(${n})${interpolate ? ` @interpolate(${interpolate})` : ''}`,
  location: n,
  ...(interpolate !== undefined ? { interpolate } : {}),
})

export interface IoStruct<F extends Record<string, FieldSpec>> {
  readonly decl: StructDecl
  readonly type: ShaderType
  /** Typed field access on a value of this struct — `VsOut.of(node).uv` emits the same
   *  member Expr as `member(node, 'uv', <its type>)`, so the field name + type are checked.
   *  The view's WRITE capability follows the BASE (#763 G2): a mutable base (`Var`) gives
   *  `Node` fields (assignable); a read-only base (a param, a `Let`) gives `ReadonlyNode`
   *  fields — assigning through a read-only value was tsc-green and died at the driver.
   *  NonNullable strips the `| undefined` a conditional-field spread
   *  (`...(cond ? { pick } : {})`) introduces, so optional output fields stay plain. */
  of(
    node: Node,
  ): { readonly [K in keyof F]-?: Node<KeyOf<NonNullable<F[K]>['type']>> } & {
    readonly $: ReadonlyNode
  }
  of(
    node: ReadonlyNode,
  ): { readonly [K in keyof F]-?: ReadonlyNode<KeyOf<NonNullable<F[K]>['type']>> } & {
    readonly $: ReadonlyNode
  }
  /** Declare a `var` of this struct and return its typed field proxy in one step —
   *  `const o = VsOut.var()` replaces the `const out = Var(VsOut.type); const o =
   *  VsOut.of(out)` stub pair. Assign fields via `o.uv.assign(…)`, return / forward the
   *  raw value via `o.$`. `name` pins the WGSL identifier (byte-stable emit). */
  var(
    name?: string,
  ): { readonly [K in keyof F]-?: Node<KeyOf<NonNullable<F[K]>['type']>> } & {
    readonly $: ReadonlyNode
  }
  /** Build a value of this struct in ONE expression — `LineOut(f0, f1, …)` — instead of a
   *  mutable `var out; out.f0 = …; return out`. Args are taken in field-declaration order, so a
   *  wrong/missing field is a TS error. Replaces the imperative field-by-field output build. */
  construct(values: {
    readonly [K in keyof F]: ReadonlyNode<KeyOf<NonNullable<F[K]>['type']>>
  }): Node
}

/** Declare an IO struct (vertex/fragment in/out) from one field map; derive the
 *  StructDecl (with attrs), the struct type, and typed field access. */
export function ioStruct<F extends Record<string, FieldSpec>>(
  name: string,
  fields: F,
): IoStruct<F> {
  const decl: StructDecl = {
    name,
    fields: Object.entries(fields).map(([n, spec]) => ({
      name: n,
      type: spec.type,
      attr: spec.attr,
      location: spec.location,
      builtin: spec.builtin,
      interpolate: spec.interpolate,
    })),
  }
  return {
    decl,
    type: structT(name),
    of(node: ReadonlyNode) {
      return new Proxy({} as Record<string, Node>, {
        get: (_t, prop) => {
          // Symbols are protocol probes (NODE_BRAND #763 D1, Symbol.toPrimitive,
          // inspection) — never authored fields. Answer undefined, don't throw.
          if (typeof prop !== 'string') return undefined
          if (prop === 'then' || prop === 'toJSON') return undefined // protocol probes (#763 X13)
          // `$` = the raw struct-value Node (#740 R6): lets a field proxy be
          // FORWARDED — fn call factories unwrap it, so `helper(p.input)` works
          // when p.input arrived as a typed handle param. Not a WGSL identifier,
          // so it can never shadow a real field.
          if (prop === '$') return node
          // Duck-type as the raw node for value positions (#763 X14): `return o`
          // / `Return(o)` read `.expr`/`.type` — they used to die at LOAD with a
          // misleading "no field 'expr'". A declared field of that name wins.
          if ((prop === 'expr' || prop === 'type') && !(prop in fields))
            return node[prop]
          const spec = fields[prop as string]
          if (spec === undefined)
            throw new Error(`sot: ioStruct '${name}' has no field '${String(prop)}'`)
          return member(node, prop as string, spec.type)
        },
        // The empty proxy TARGET has no keys, so without this trap `'$' in proxy`
        // is false and the call-factory unwrap misses — the proxy then gets
        // misparsed as a named-args bag ("has no field 'input'" at module load).
        has: (_t, prop) => prop === '$' || (typeof prop === 'string' && prop in fields),
      }) as { readonly [K in keyof F]-?: Node<KeyOf<NonNullable<F[K]>['type']>> } & {
        readonly $: ReadonlyNode
      }
    },
    var(varName?: string) {
      return this.of(varName !== undefined ? Var(varName, this.type) : Var(this.type))
    },
    construct(values: Record<string, ReadonlyNode>) {
      return construct(
        structT(name),
        decl.fields.map((f) => values[f.name]),
      )
    },
  }
}

export interface PlainStruct<F extends Record<string, ShaderType>> {
  readonly decl: StructDecl
  readonly type: ShaderType
  /** Typed field access for a struct value you only hold as a raw Node — e.g.
   *  `Seg.of(someNode).p0_h` (replaces the removed `node.field('p0_h', vec2fT)`).
   *  NB: storage-buffer reads don't need this — `segments.at(i)` is ALREADY the
   *  typed field proxy (#740 R6c); `.of` is for nodes that arrive untyped.
   *  Write capability follows the base (#763 G2): mutable base → `Node` fields,
   *  read-only base → `ReadonlyNode` fields.
   *  `.$` is the raw struct-value Node (forwardable — call factories unwrap it). */
  of(node: Node): { readonly [K in keyof F]: Node<KeyOf<F[K]>> } & { readonly $: ReadonlyNode }
  of(
    node: ReadonlyNode,
  ): { readonly [K in keyof F]: ReadonlyNode<KeyOf<F[K]>> } & { readonly $: ReadonlyNode }
  /** Positional field access — `Seg.get(node, 'p0_h')` is `node.field('p0_h', <type>)`,
   *  a wrong field name a TS error. Same as `.of(node).p0_h`; kept for call sites that
   *  read many fields off a shared shorthand (`const g = Seg.get`). A READ accessor —
   *  returns `ReadonlyNode` (#763 G2). */
  get<K extends keyof F & string>(node: ReadonlyNode, field: K): ReadonlyNode<KeyOf<F[K]>>
  /** Declare a `var` of this struct and return its typed MUTABLE field proxy —
   *  the structDecl twin of IoStruct.var (#763 X10; declarator capability parity). */
  var(name?: string): { readonly [K in keyof F]: Node<KeyOf<F[K]>> } & { readonly $: ReadonlyNode }
  /** Build a value of this struct in ONE expression — field-keyed, declaration
   *  order (#763 X10; the ioStruct.construct twin). */
  construct(values: { readonly [K in keyof F]: ReadonlyNode<KeyOf<F[K]>> }): Node
}

/** Declare a plain (non-binding, non-IO) struct — a storage-buffer element type used in
 *  `array<T>`, or a nested struct — from one field map; derive the StructDecl, the struct
 *  type (`.type` replaces every `structT('Name')` string), and typed field access. The one
 *  struct kind the binding/IO helpers don't cover, so a layout has exactly ONE declaration. */
export function structDecl<F extends Record<string, ShaderType>>(
  name: string,
  fields: F,
): PlainStruct<F> {
  const decl: StructDecl = {
    name,
    fields: Object.entries(fields).map(([n, type]) => ({ name: n, type })),
  }
  const type = structT(name)
  return {
    decl,
    type,
    get<K extends keyof F & string>(node: ReadonlyNode, field: K): ReadonlyNode<KeyOf<F[K]>> {
      return member(node, field, fields[field])
    },
    var(varName?: string) {
      return this.of(varName !== undefined ? Var(varName, this.type) : Var(this.type))
    },
    construct(values: Record<string, ReadonlyNode>) {
      return construct(
        structT(name),
        decl.fields.map((f) => values[f.name]),
      )
    },
    of(node: ReadonlyNode) {
      return new Proxy({} as Record<string, Node>, {
        get: (_t, prop) => {
          if (typeof prop !== 'string') return undefined // symbol probes (#763 D1) — never fields
          if (prop === 'then' || prop === 'toJSON') return undefined // protocol probes (#763 X13)
          if (prop === '$') return node // raw struct-value Node (#740 R6, forwardable)
          if ((prop === 'expr' || prop === 'type') && !(prop in fields))
            return node[prop] // #763 X14
          const t = fields[prop as string]
          if (t === undefined)
            throw new Error(`sot: structDecl '${name}' has no field '${String(prop)}'`)
          return member(node, prop as string, t)
        },
        // `'$' in proxy` must be true for the call-factory unwrap (empty target).
        has: (_t, prop) => prop === '$' || (typeof prop === 'string' && prop in fields),
      }) as { readonly [K in keyof F]: Node<KeyOf<F[K]>> } & { readonly $: ReadonlyNode }
    },
  }
}

/** A fixed-size `array<Element, N>` uniform field whose ELEMENT is a struct handle —
 *  `patterns: arrayOf(PatternSlot, 3)`. The field proxy then exposes a TYPED `.at(i)`
 *  (`LAYER.field.patterns.at(k).id`) instead of the raw-node `.at(i, elemType)` + `.of()`
 *  bridge pair. The declared WGSL type is the same `array<T, N>` the plain spelling produced. */
export interface HandleArray<H extends StructHandle> {
  readonly element: H
  readonly count: number
}
/** A fixed-size array uniform field with a PLAIN element type (#763 X11) —
 *  `dash_array: arrayOf(vec4fT, 2)`. `.at(i)` returns the typed element read;
 *  the old spelling restated the element type at EVERY read site. */
export interface TypeArray<T extends ShaderType> {
  readonly elemType: T
  readonly count: number
}
type UniformFieldSpec = ShaderType | HandleArray<StructHandle> | TypeArray<ShaderType>

export function arrayOf<H extends StructHandle>(element: H, count: number): HandleArray<H>
export function arrayOf<T extends ShaderType>(element: T, count: number): TypeArray<T>
export function arrayOf(
  element: StructHandle | ShaderType,
  count: number,
): HandleArray<StructHandle> | TypeArray<ShaderType> {
  return typeof element === 'object' && 'of' in element
    ? { element: element as StructHandle, count }
    : { elemType: element as ShaderType, count }
}

const isHandleArray = (v: UniformFieldSpec): v is HandleArray<StructHandle> =>
  typeof v === 'object' && 'element' in v && 'count' in v
const isTypeArray = (v: UniformFieldSpec): v is TypeArray<ShaderType> =>
  typeof v === 'object' && 'elemType' in v && 'count' in v

/** Uniform fields are READ-ONLY in WGSL — the field proxy hands out `ReadonlyNode`
 *  (#763 G2): `U.field.opacity.assign(…)` is a tsc error, not a naga rejection.
 *  Handle-array fields get the element handle's read view (the `.of` read overload). */
type UniformFieldNode<V> =
  V extends HandleArray<infer H>
    ? { at(i: ReadonlyNode<ScalarKey> | number): ReturnType<H['of']> }
    : V extends TypeArray<infer T>
      ? { at(i: ReadonlyNode<ScalarKey> | number): ReadonlyNode<KeyOf<T>> }
      : V extends ShaderType
        ? ReadonlyNode<KeyOf<V>>
        : never

export interface UniformStruct<F extends Record<string, UniformFieldSpec>> {
  readonly struct: StructDecl
  /** Alias of `struct` (#763 X10) — every other declarator spells it `.decl`;
   *  `structs: [U.decl, VsOut.decl]` no longer mixes two spellings in one line. */
  readonly decl: StructDecl
  /** The struct ShaderType (previously computed internally but not exposed). */
  readonly type: ShaderType
  readonly binding: BindingDecl
  readonly node: Node
  readonly field: { readonly [K in keyof F]: UniformFieldNode<F[K]> }
}

/** Declare a uniform-buffer struct + its binding from one place; derive the StructDecl,
 *  the binding decl, the access node, and typed field access. `at.as` is the WGSL var name. */
export function uniformStruct<F extends Record<string, UniformFieldSpec>>(
  typeName: string,
  at: { group: number; binding: number; as: string },
  fields: F,
): UniformStruct<F> {
  const fieldType = (v: UniformFieldSpec): ShaderType =>
    isHandleArray(v)
      ? arrayT(v.element.type, v.count)
      : isTypeArray(v)
        ? arrayT(v.elemType, v.count)
        : v
  const struct: StructDecl = {
    name: typeName,
    fields: Object.entries(fields).map(([n, v]) => ({ name: n, type: fieldType(v) })),
  }
  const type = structT(typeName)
  const node = bindingRef(at.as, type)
  return {
    struct,
    decl: struct,
    type,
    binding: { group: at.group, binding: at.binding, name: at.as, space: 'uniform', type },
    node,
    field: new Proxy({} as Record<string, unknown>, {
      get: (_t, prop) => {
        if (typeof prop !== 'string') return undefined // symbol probes (#763 D1) — never fields
        if (prop === 'then' || prop === 'toJSON') return undefined // protocol probes (#763 X13) — await/JSON.stringify must not throw
        const v = fields[prop as string]
        if (v === undefined)
          throw new Error(`sot: uniformStruct '${typeName}' has no field '${String(prop)}'`)
        if (isHandleArray(v)) {
          const arrNode = member(node, prop as string, arrayT(v.element.type, v.count))
          return {
            at: (i: ReadonlyNode<ScalarKey> | number) =>
              v.element.of(arrNode.at(i, v.element.type)),
          }
        }
        if (isTypeArray(v)) {
          const arrNode = member(node, prop as string, arrayT(v.elemType, v.count))
          return { at: (i: ReadonlyNode<ScalarKey> | number) => arrNode.at(i, v.elemType) }
        }
        return member(node, prop as string, v)
      },
      // `in`/spread feature-detection must see the declared fields (#763 X13 —
      // the sibling proxies got this trap in R6; this one was the gap).
      has: (_t, prop) => typeof prop === 'string' && prop in fields,
    }) as { readonly [K in keyof F]: UniformFieldNode<F[K]> },
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
export function resource<T extends ShaderType>(
  name: string,
  type: T,
  at: { group: number; binding: number; space?: AddressSpace },
): Resource<T> {
  return {
    binding: { group: at.group, binding: at.binding, name, space: at.space ?? 'uniform', type },
    node: bindingRef(name, type),
  }
}

/** A bound `array<Element>` storage buffer. `.at(i)` is the element accessor: for a struct ELEMENT
 *  (a structDecl / ioStruct handle) it returns the TYPED field proxy — `buf.at(i).p0_h`, no `.of()`,
 *  no element-type argument; for a scalar element (f32T) it returns the element Node. */
export interface StorageBuffer<A> {
  readonly binding: BindingDecl
  readonly node: Node
  /** The struct element's decl, when the element was a struct handle — lets
   *  `module({ uses: [buf] })` register the element struct too (#763 X1). */
  readonly elementDecl?: StructDecl
  at(i: ReadonlyNode<ScalarKey> | number): A
}

/** A struct ELEMENT handle (structDecl / ioStruct) — has a `.type` and a typed `.of(node)` proxy. */
type StructHandle = {
  readonly type: ShaderType
  readonly decl?: StructDecl
  of(node: ReadonlyNode): object
}

/** A storage buffer binding declared from its ELEMENT (a struct handle or a scalar type) in one place;
 *  derives the binding decl (space 'storage' + access), the access node, AND `.at(i)` element access. */
/** Re-map a read view's fields to their mutable twins — the element view of a
 *  `read_write` storage buffer. Homomorphic, so field optionality/readonly are kept;
 *  the raw `$` node stays ReadonlyNode (writes go through fields, not the whole value). */
type MutableView<V> = {
  [K in keyof V]: K extends '$' ? V[K] : V[K] extends ReadonlyNode<infer T> ? Node<T> : V[K]
}

// The element view's WRITE capability follows the declared ACCESS (#763 G2):
// `access: 'read'` hands out read views (`buf.at(i).p0.assign(…)` is a tsc error —
// it used to compile and die at the driver); `read_write` hands out mutable views.
export function storageBuffer<H extends StructHandle>(
  name: string,
  element: H,
  at: { group: number; binding: number; access: 'read' },
): StorageBuffer<ReturnType<H['of']>>
export function storageBuffer<H extends StructHandle>(
  name: string,
  element: H,
  at: { group: number; binding: number; access: 'read_write' },
): StorageBuffer<MutableView<ReturnType<H['of']>>>
export function storageBuffer<T extends ShaderType>(
  name: string,
  element: T,
  at: { group: number; binding: number; access: 'read' },
): StorageBuffer<ReadonlyNode<KeyOf<T>>>
export function storageBuffer<T extends ShaderType>(
  name: string,
  element: T,
  at: { group: number; binding: number; access: 'read_write' },
): StorageBuffer<Node<KeyOf<T>>>
export function storageBuffer(
  name: string,
  element: StructHandle | ShaderType,
  at: { group: number; binding: number; access: 'read' | 'read_write' },
): StorageBuffer<unknown> {
  const handle = typeof element === 'object' && 'of' in element ? element : undefined
  const elemType = handle ? handle.type : (element as ShaderType)
  const arr = arrayT(elemType)
  const node = bindingRef(name, arr)
  return {
    binding: {
      group: at.group,
      binding: at.binding,
      name,
      space: 'storage',
      access: at.access,
      type: arr,
    },
    node,
    ...(handle?.decl !== undefined ? { elementDecl: handle.decl } : {}),
    at: (i) => (handle ? handle.of(node.at(i, elemType)) : node.at(i, elemType)),
  }
}
