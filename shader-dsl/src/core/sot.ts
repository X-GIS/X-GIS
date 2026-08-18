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
import { dslError } from './diagnostics/error'

/** A module-level constant declared ONCE (#763 X2) — the missing SoT declarator.
 *  `decl` goes into module() (or `uses:`), `node` is the typed reference; the
 *  cross-file ConstDecl↔constRef('NAME') string contract is gone (a typo'd name
 *  used to compile and die at WGSL). */
export interface ConstHandle<T extends ShaderType> {
  readonly decl: ConstDecl
  readonly node: ReadonlyNode<KeyOf<T>>
}
/** Declare a module-level scalar CONSTANT with its typed reference in one call. WGSL emits
 *  `values.wgsl` as the literal (the truncated spelling a hand-written `ConstDecl` uses too,
 *  e.g. `PI = 3.14159265`); the CPU f64 oracle evaluates `values.cpu` instead (full JS-double
 *  precision), so a WGSL literal you deliberately shorten never drags the parity check down
 *  with it.
 *
 *  Returns a {@link ConstHandle}: `.decl` goes into `module({ consts })` — or, more usually,
 *  into `module({ uses })`, which collects the `.decl` of any handle passed to it — and `.node`
 *  is the typed reference to use at call sites instead of a bare `constRef(name, type)`, so a
 *  renamed or typo'd constant is a `tsc` error everywhere it's used instead of a WGSL link
 *  failure. For a NON-scalar module constant (a `vec4<f32>` colour, an `array<vec4<f32>, N>`
 *  palette) use `constExpr` instead — it takes one constant-foldable literal Node rather than a
 *  WGSL/CPU value pair.
 *
 *  @example
 *  ```ts
 *  const TAU = constDecl('TAU', f32T, { wgsl: 6.2831853, cpu: Math.PI * 2 })
 *  const g = fn('g', { t: f32T }, ({ t }) => t.mul(TAU.node))
 *  const m = module({ consts: [TAU.decl], funcs: [g] })
 *  ```
 *
 *  Exported from `@xgis/shader-dsl`.
 */
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

/** One struct/param FIELD carrying a stage attribute — the shared return type of
 *  {@link builtin} and {@link location}, and the value type of both an `ioStruct()` field map
 *  and a `fn()` entry-point param record: the same two helpers attribute a vertex/fragment/
 *  compute param exactly the way they attribute an IO-struct field, so a stage-attributed
 *  param and a struct field are authored identically.
 *
 *  `attr` is ONLY the WGSL text spelling; `location` / `builtin` / `interpolate` are the
 *  structured twin backends actually branch on (capability checks, `reflect()`'s vertex-
 *  attribute table, the GLSL `flat` qualifier) — never re-parse `attr` to recover them. A field
 *  is either builtin-attributed or location-attributed, never both; build one with `builtin(name,
 *  type)` or `location(n, type, interpolate?)`, never this shape by hand.
 *
 *  Exported from `@xgis/shader-dsl`.
 */
export interface FieldSpec<T extends ShaderType = ShaderType> {
  readonly type: T
  /** The WGSL emit spelling. Backends never re-parse it — the structured
   *  fields below are the semantic source (#740 R3). */
  readonly attr: string
  readonly location?: number
  readonly builtin?: string
  readonly interpolate?: string
}

/** Every `@builtin(<name>)` id WGSL defines — the DSL's builtin vocabulary IS WGSL's
 *  (AUTHORING.md §4; each backend spells the id per target, e.g. fragment-input
 *  `position` reads as `gl_FragCoord` on GLSL). Typing {@link builtin} over this
 *  union moves a typo'd or GLSL-ism name (`'vertex_idx'`, `'frag_coord'`,
 *  `'point_size'`) from a GPU-compiler / emit-time failure to a `tsc` error at the
 *  authoring site — on WGSL an unknown name used to EMIT VERBATIM (the denylist
 *  stance in backends/wgsl.ts) and die at naga with no line back. Feature-gated ids
 *  (`subgroup_*`, `clip_distances`) and ids without a GLSL mapping yet
 *  (`sample_index`, the compute family on WebGL2) are deliberately INCLUDED:
 *  capability and per-target support are `assertBuiltins`/`builtinIn`'s job at emit,
 *  not the type's. A WGSL builtin newer than this union needs a one-line, TYPE-ONLY
 *  addition here — the emit layer already passes unknown names through by design.
 *
 *  Exported from `@xgis/shader-dsl`.
 */
export type WgslBuiltinName =
  | 'vertex_index'
  | 'instance_index'
  | 'position'
  | 'front_facing'
  | 'frag_depth'
  | 'sample_index'
  | 'sample_mask'
  | 'local_invocation_id'
  | 'local_invocation_index'
  | 'global_invocation_id'
  | 'workgroup_id'
  | 'num_workgroups'
  | 'subgroup_invocation_id'
  | 'subgroup_size'
  | 'clip_distances'

/** A `@builtin(<name>)` IO field (e.g. builtin('position', vec4fT)). `name` is bounded
 *  to {@link WgslBuiltinName} — the closed WGSL vocabulary — so a typo or a GLSL-only
 *  spelling is a `tsc` error here instead of a naga error with no authoring line. */
export const builtin = <T extends ShaderType>(name: WgslBuiltinName, type: T): FieldSpec<T> => ({
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

/** The handle {@link ioStruct} returns — a struct that crosses a STAGE boundary (a vertex/
 *  fragment/compute IO struct, `@builtin`/`@location`-attributed fields), collapsing into one
 *  object what this file's header describes as four hand-synced declarations (a `StructDecl`,
 *  per-field member access, and an imperative build) that used to drift apart. Bundles the
 *  `StructDecl` for `module({ structs })`, the struct `ShaderType`, a typed field-read proxy for
 *  any node of this shape, and a one-expression constructor. Reach for {@link PlainStruct}
 *  instead when the struct never crosses a stage boundary (a storage-buffer element, a nested
 *  struct) — its fields carry no `@location`/`@builtin` attribute, which is the whole
 *  difference between the two.
 *
 *  Exported from `@xgis/shader-dsl`.
 */
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
  of(node: Node): { readonly [K in keyof F]-?: Node<KeyOf<NonNullable<F[K]>['type']>> } & {
    readonly $: ReadonlyNode
  }
  of(node: ReadonlyNode): {
    readonly [K in keyof F]-?: ReadonlyNode<KeyOf<NonNullable<F[K]>['type']>>
  } & {
    readonly $: ReadonlyNode
  }
  /** Declare a `var` of this struct and return its typed field proxy in one step —
   *  `const o = VsOut.var()` replaces the `const out = Var(VsOut.type); const o =
   *  VsOut.of(out)` stub pair. Assign fields via `o.uv.assign(…)`, return / forward the
   *  raw value via `o.$`. `name` pins the WGSL identifier (byte-stable emit). */
  var(name?: string): { readonly [K in keyof F]-?: Node<KeyOf<NonNullable<F[K]>['type']>> } & {
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
          if ((prop === 'expr' || prop === 'type') && !(prop in fields)) return node[prop]
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

/** The handle {@link structDecl} returns — a struct declared for something OTHER than a
 *  stage's own IO boundary: a storage-buffer ELEMENT type (paired with {@link storageBuffer}),
 *  or a struct nested inside another struct. Fields are plain `ShaderType`, with no `@location`/
 *  `@builtin` attribute ({@link IoStruct} is the twin that carries those), so this is the one
 *  struct kind the IO/uniform/storage declarators don't already cover — a layout still ends up
 *  with exactly ONE declaration. Same shape as `IoStruct` (`.decl`/`.type`/`.of`/`.var`/
 *  `.construct`), plus the extra positional `.get(node, field)` reader `IoStruct` has no need
 *  of.
 *
 *  Exported from `@xgis/shader-dsl`.
 */
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
          if ((prop === 'expr' || prop === 'type') && !(prop in fields)) return node[prop] // #763 X14
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

/** Declare a FIXED-length array FIELD inside a {@link uniformStruct} field map. The array is
 *  always `array<T, N>` (a declared `count`) — never the runtime-length `array<T>` a top-level
 *  {@link storageBuffer} binding gets from its element alone with no count at all; the two
 *  declarators are not interchangeable. Which overload applies is decided from `element`'s
 *  RUNTIME shape, not a marker argument: a struct handle (`structDecl`/`ioStruct`, recognised by
 *  having an `.of` method) returns a {@link HandleArray} whose field `.at(i)` gives the typed
 *  field proxy; a bare `ShaderType` (which never carries an `.of`) returns a {@link TypeArray}
 *  whose field `.at(i)` gives the element read directly — the two element kinds can never be
 *  mistaken for each other.
 *
 *  Exported from `@xgis/shader-dsl`.
 */
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

/** The handle {@link uniformStruct} returns — a struct AND its binding declared together
 *  (`.struct`/`.decl` for `module()`, `.binding` for the bind group, `.field` for typed,
 *  read-only field access; uniforms are read-only in WGSL, so `.field.x.assign(…)` is a `tsc`
 *  error rather than a naga rejection). `F` may include a fixed-size {@link arrayOf} array
 *  field (a struct-element array or a plain-type array) — the one field shape {@link
 *  PlainStruct} cannot express.
 *
 *  Exported as a TYPE deliberately, not just returned as a value: it is a generic constraint
 *  other packages accept to build something from the struct's SHAPE `F` without re-declaring
 *  it — the engine package's `UniformBlock.of(u: UniformStruct<F>)` derives a CPU-side std140
 *  buffer writer straight from `u.struct` (no shader compilation involved), and a helper can
 *  return `UniformStruct<{ time: …; resolution: … } & F>` to compose a base uniform layout with
 *  a caller's extra fields under one still-type-checked struct.
 *
 *  Exported from `@xgis/shader-dsl`.
 */
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

/** The minimal single-binding handle: a `BindingDecl` for `module({ bindings })` plus a typed
 *  access node — nothing else, because a texture/sampler/host uniform has no fields to proxy.
 *  Returned by BOTH {@link resource} (textures, samplers — any module-owned non-struct binding)
 *  and {@link hostUniform} (a scalar/vector/matrix uniform the HOST supplies), which is why the
 *  type is generic over the resource kind rather than named after either one: `node`'s key type
 *  tracks the SPECIFIC `T` (`Node<'texture_2d<f32>'>`, `Node<'sampler'>`, `Node<'vec4<f32>'>`),
 *  not the widened `Node`, so kind-specific ops (`textureSample`, `.mul`, …) stay type-checked
 *  at the call site instead of accepting anything.
 *
 *  Exported from `@xgis/shader-dsl`.
 */
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

/** Declare a HOST-OWNED uniform (#1710) — one value the surrounding renderer supplies,
 * spelled the way that renderer's target actually spells it.
 *
 * On **WGSL** this is an ordinary `@group(N) @binding(M) var<uniform>` declaration; the
 * only difference from {@link resource} is that `reflect()` marks it `owner: 'host'`, so a
 * consumer knows the HOST's bind-group layout is the authority and it must not allocate
 * one itself.
 *
 * On **GLSL ES 3.00** it lowers to a LOOSE `uniform <type> <name>;` in the default block —
 * which is what a GLSL host prelude actually provides — instead of the std140 block a
 * module-owned uniform gets. That is the whole point: before this, the only way to reach
 * a loose uniform was to emit the block and then cut it back open with string surgery,
 * which bypassed `reflect()` and broke under `minify()`.
 *
 * Scalars, vectors and matrices only. A host-owned STRUCT is {@link hostBlock}, which owns
 * the same choice one level up: it can flatten to exactly these loose declarations, or stay
 * a std140 block.
 *
 * ```ts
 * const viewport = hostUniform('u_viewport_px', vec2fT, { group: 0, binding: 1 }, {
 *   precision: 'highp',        // GLSL-only; ignored on WGSL
 * })
 * ```
 *
 * If the host's prelude ALREADY declares the symbol and we must not re-declare it, that is
 * {@link externVar} (#1713) instead — it emits nothing at all.
 *
 * @param name - the uniform's name, as the host spells it.
 * @param type - its shader type.
 * @param at - the WGSL group/binding slot. Unused by the GLSL lowering, required because
 *   the same declaration has to work on both targets.
 * @param opts - `precision`, a GLSL-only qualifier for this declaration.
 */
export function hostUniform<T extends ShaderType>(
  name: string,
  type: T,
  at: { group: number; binding: number },
  opts?: { precision?: 'highp' | 'mediump' | 'lowp' },
): Resource<T> {
  if (type.kind === 'struct' || type.kind === 'array')
    throw dslError('SD0016', `hostUniform '${name}': ${type.kind} — use hostBlock for a struct`)
  return {
    binding: {
      group: at.group,
      binding: at.binding,
      name,
      space: 'uniform',
      type,
      owner: 'host',
      ...(opts?.precision ? { precision: opts.precision } : {}),
    },
    node: bindingRef(name, type),
  }
}

/** Declare a HOST-OWNED uniform BLOCK (#1710) — a whole struct of values the surrounding
 * renderer supplies, from one declaration that works on both targets.
 *
 * This is the resource-ownership half of the host boundary, and the reason it cannot be
 * expressed as N {@link hostUniform} calls: on WGSL a host-owned bind group is ONE unit.
 * The renderer hands us `@group(0)` and its layout is the authority; decomposing that into
 * N scalars describes a different program.
 *
 * ```ts
 * const camera = hostBlock('CameraUniforms', { group: 0, binding: 0, as: 'u_camera' }, {
 *   u_matrix: mat4fT,
 *   u_viewport_px: vec2fT,
 * }, { glsl: 'loose' })
 *
 * camera.field.u_matrix        // typed, and type-checked against the declared shape
 * ```
 *
 * On **WGSL** it is an ordinary `@group(N) @binding(M) var<uniform>` block — the shader must
 * still declare a binding to read it — with `reflect()` marking every entry `owner: 'host'`
 * so a consumer knows not to build a layout for it.
 *
 * On **GLSL ES 3.00** the spelling is the caller's choice, because a GLSL host prelude
 * provides one or the other and no correctness in the wrong one will link:
 *
 * - `glsl: 'std140-block'` (default) — `layout(std140) uniform CameraUniforms { … } u_camera;`
 * - `glsl: 'loose'` — one `uniform mat4 u_matrix;` per member, and every `u_camera.u_matrix`
 *   read rewritten to bare `u_matrix`. That rewrite happens on the IR before emit, which is
 *   the entire difference from the `replaceAll('block.field', 'field')` a consumer had to
 *   write: it cannot corrupt an unrelated substring, it survives `minify()`, and `reflect()`
 *   still describes what was emitted.
 *
 * A loose block's members must be scalars, vectors or matrices — the default block has no
 * spelling for a nested struct — and their names must not collide with another loose
 * block's, since flattening puts them all in one namespace. Both throw SD0016 at authoring
 * time rather than emitting GLSL that fails to link.
 *
 * @param typeName - the struct's type name, as the host spells it.
 * @param at - the WGSL group/binding slot plus `as`, the block variable's name.
 * @param fields - the members, in the host's declaration order.
 * @param opts - `glsl` picks the GLSL spelling; `precision` is a GLSL-only qualifier applied
 *   to each member of a `'loose'` block (a std140 block takes the stage default).
 * @throws SD0016 when `glsl: 'loose'` is asked for a member the default block cannot spell.
 */
export function hostBlock<F extends Record<string, UniformFieldSpec>>(
  typeName: string,
  at: { group: number; binding: number; as: string },
  fields: F,
  opts?: { glsl?: 'std140-block' | 'loose'; precision?: 'highp' | 'mediump' | 'lowp' },
): UniformStruct<F> {
  const base = uniformStruct(typeName, at, fields)
  const glsl = opts?.glsl ?? 'std140-block'
  if (glsl === 'loose')
    for (const f of base.struct.fields)
      if (f.type.kind !== 'scalar' && f.type.kind !== 'vec' && f.type.kind !== 'mat')
        throw dslError(
          'SD0016',
          `hostBlock '${typeName}' member '${f.name}': ${f.type.kind} cannot be a loose uniform`,
        )
  return {
    ...base,
    binding: {
      ...base.binding,
      owner: 'host',
      glsl,
      ...(opts?.precision ? { precision: opts.precision } : {}),
    },
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
/** Declare a bound `array<Element>` STORAGE buffer from its element alone — a struct handle
 *  (`structDecl`/`ioStruct`) or a scalar/vector `ShaderType` — deriving the binding decl (space
 *  `'storage'`), the access node, and a typed `.at(i)` in one place; see {@link StorageBuffer}
 *  for what `.at(i)` returns for each element kind. Unlike {@link arrayOf}, there is no
 *  `count` — the WGSL array is runtime-length, sized by whatever buffer the host binds.
 *
 *  `access` decides the returned element view's write capability at the TYPE level (#763 G2):
 *  `'read'` hands out read-only fields (`buf.at(i).p0.assign(…)` is now a `tsc` error, not a
 *  driver-time failure); `'read_write'` hands out mutable ones.
 *
 *  **On GLSL ES 3.00 (WebGL2), which has no SSBO, `'read_write'` is a hard build-time error.**
 *  A storage binding lowers automatically to a data-texture read (`texelFetch`) at GLSL emit —
 *  no authoring change needed — but that lowering is GATHER-ONLY: it rewrites reads, has no
 *  write form, and throws `UnsupportedFeatureError` on a `read_write` binding rather than
 *  silently dropping the write (a compute kernel's output instead lowers through the
 *  compute→fragment path — declare the kernel `portable: true`, #1812; the legacy
 *  `emitGlslModule({ emulateCompute: true })` opt-in remains for undeclared kernels).
 *  Prefer `'read'` unless the module is
 *  WGSL-only, or the divergent access mode surfaces only once someone finally emits it for
 *  GLSL.
 *
 *  @example
 *  ```ts
 *  const segmentsB = storageBuffer('segments', ShapeSegment, { group: 0, binding: 9, access: 'read' })
 *  const p0 = segmentsB.at(i).p0 // typed field read, no `.of()`, no element-type argument
 *  ```
 *
 *  Exported from `@xgis/shader-dsl`.
 */
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
