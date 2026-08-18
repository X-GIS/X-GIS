// ═══ Shader DSL — pipeline REFLECTION (additive; layout engine shared with GLSL emit) ═══
//
// The IR already carries every binding/struct/entry fact, but emitModule discards
// it into a string — so a host re-derives bind-group layouts + uniform byte offsets
// BY HAND (and they drift; see runtime point-uniform-layout.test.ts). reflect(module)
// recovers that metadata as a target-neutral `Reflection` object the host can consume
// mechanically: bind-group entries, std140/std430 struct byte layouts, vertex
// attributes, and entry-point signatures.
//
// PURE + ADDITIVE — scoped precisely (#763 H2): `reflect()` itself is read-only over
// the IR and sits on no emit path. The LAYOUT ENGINE in this file (typeLayout /
// structLayout) does NOT share that invariant: the GLSL backend imports it to bake
// std140 UBO / std430 storage offsets into emitted source (glsl.ts), so a layout-rule
// change here CAN change emitted GLSL bytes (never WGSL — the WGSL backend derives
// nothing from it). The std140/std430 offsets are anchored to the offsets the runtime
// already ships (reflect.test.ts).

import {
  type ShaderType,
  type StructDecl,
  type ModuleDecl,
  type AddressSpace,
  type Capability,
  type TextureElem,
  type BindingDecl,
  typeKey,
  stageOf,
  workgroupSizeOf,
} from './ir/index.js'
import { requiredCaps } from './passes/required-caps.js'
import { fp64Lower, type Fp64Flavor } from './passes/fp64-lower.js'

const roundUp = (x: number, a: number): number => Math.ceil(x / a) * a

/** Which host-shareable byte-layout RULE a struct's fields round to — WGSL's own two rules,
 *  reused here for GLSL ES 3.00's std140 UBO block and for std430-style vertex-attribute /
 *  storage offsets. `'std140'` is the WGSL `uniform`-address-space rule (also real GLSL
 *  std140): array elements and struct/array base alignment round UP to 16 bytes, so a `vec3`
 *  costs 16 and an array of `f32` wastes 12 of every 16. `'std430'` is WGSL's
 *  `storage`-address-space rule (natural alignment, no 16-byte round-up) — GLSL ES 3.00 has no
 *  SSBO to hold it, so a `storage` binding is rewritten to a data texture before GLSL emit, but
 *  `reflect()` of the AUTHORED module still reports its fields under std430 (`Reflection.storage`).
 *  A caller computing offsets by hand picks the rule from the binding's `space`, not from the
 *  target backend: `uniform` is always std140, `storage` is always std430, on both backends.
 *  One case this file does not support yet: a `mat2` field under std140 throws (reflect.ts:125)
 *  — WGSL's own std140-uniform column stride (8) disagrees with real GLSL std140's (16), and no
 *  producer needs the dual-rule fix yet.
 *
 *  Exported from `@xgis/shader-dsl`.
 */
export type LayoutKind = 'std140' | 'std430'

/** Size + alignment (bytes) of a host-shareable type under a layout. Throws on a
 *  non-host-shareable type (texture/sampler/void are bind resources, not struct fields). */
function typeLayout(
  t: ShaderType,
  layout: LayoutKind,
  structs: ReadonlyMap<string, StructDecl>,
): { size: number; align: number } {
  switch (t.kind) {
    case 'scalar':
      return { size: 4, align: 4 }
    // f64 (emulated double) occupies its lowered vec2<f32> slot — hi then lo,
    // 8 bytes, 8-aligned — under BOTH layouts, so reflecting the authored module
    // and the lowered module yield byte-identical offsets. Hosts pack with
    // splitF64 (core/fp64/df64-lib.ts).
    case 'f64':
      return { size: 8, align: 8 }
    // vec64 lowers to `struct { hi: vecN<f32>, lo: vecN<f32> }` — derive the
    // layout from THAT struct through the same engine (single authority), so
    // authored and lowered reflections agree byte-for-byte here too.
    case 'vec64': {
      const vecT: ShaderType = { kind: 'vec', n: t.n, elem: 'f32' }
      const sl = structLayout(
        {
          name: `DF64Vec${t.n}`,
          fields: [
            { name: 'hi', type: vecT },
            { name: 'lo', type: vecT },
          ],
        },
        layout,
        structs,
      )
      return { size: sl.size, align: sl.align }
    }
    case 'vec':
      // vec2 → 8/8, vec3 → 12/16, vec4 → 16/16 (elem is always 4 bytes)
      return t.n === 2
        ? { size: 8, align: 8 }
        : t.n === 3
          ? { size: 12, align: 16 }
          : { size: 16, align: 16 }
    case 'mat': {
      // mat64 (emulated double) lowers to `struct DF64MatN { c0..c(N-1): DF64VecN }`
      // — derive the layout from THAT struct through the same engine (single
      // authority), so authored and lowered reflections agree byte-for-byte.
      if (t.elem === 'f64') {
        const vecT: ShaderType = { kind: 'vec', n: t.n, elem: 'f32' }
        const colStruct: StructDecl = {
          name: `DF64Vec${t.n}`,
          fields: [
            { name: 'hi', type: vecT },
            { name: 'lo', type: vecT },
          ],
        }
        const nested = new Map(structs)
        nested.set(colStruct.name, colStruct)
        const sl = structLayout(
          {
            name: `DF64Mat${t.n}`,
            fields: Array.from({ length: t.n }, (_, j) => ({
              name: `c${j}`,
              type: { kind: 'struct', name: colStruct.name } as ShaderType,
            })),
          },
          layout,
          nested,
        )
        return { size: sl.size, align: sl.align }
      }
      // #763 P7 — mat2 std140 DIVERGES between WGSL uniform rules (column stride 8)
      // and real GLSL std140 (columns round to vec4 → stride 16). The GLSL UBO emit
      // declares this layout THE offset contract, so a mat2 field would drift host
      // bytes vs GL for it and every following field. No producer exists (types.ts
      // exports only mat4x4fT) — reject until the vec4-rounded rule + a layout test land.
      if (layout === 'std140' && t.n === 2) {
        throw new Error(
          'wgslLayout: mat2 in std140 is not supported — WGSL uniform rules (stride 8) and GLSL std140 (stride 16) disagree; add the dual-rule layout + tests before using mat2 in a UBO',
        )
      }
      // matNxN<f32>: N columns of vecN; column stride = round(size,align) of the column vec.
      const col =
        t.n === 2
          ? { size: 8, align: 8 }
          : t.n === 3
            ? { size: 12, align: 16 }
            : { size: 16, align: 16 }
      const stride = roundUp(col.size, col.align)
      return { size: stride * t.n, align: col.align }
    }
    case 'struct': {
      const sl = structLayout(structByName(structs, t.name), layout, structs)
      return { size: sl.size, align: sl.align }
    }
    case 'array': {
      const el = typeLayout(t.elem, layout, structs)
      let stride = roundUp(el.size, el.align)
      let align = el.align
      if (layout === 'std140') {
        stride = roundUp(stride, 16)
        align = roundUp(align, 16)
      }
      const count = t.size ?? 0 // runtime-sized array → 0 (stride still defined)
      return { size: count * stride, align }
    }
    default:
      throw new Error(`reflect: type '${t.kind}' is not host-shareable (no byte layout)`)
  }
}

function structByName(structs: ReadonlyMap<string, StructDecl>, name: string): StructDecl {
  const s = structs.get(name)
  if (!s) throw new Error(`reflect: struct '${name}' not found in module`)
  return s
}

/** One struct field's recovered byte layout — name, DSL type key, and its `offset`/`align`/
 *  `size` under whichever `LayoutKind` the enclosing `StructLayout` was computed with, in
 *  BYTES. A CPU packer that writes `Float32Array` slots divides by 4 itself and asserts the
 *  remainder is zero first — `uniformFieldSlots` (rhi-webgpu/reflection-to-webgpu.ts:99-112)
 *  throws on a non-f32-aligned offset rather than silently truncating it. `UniformBlock`
 *  (engine/src/render/uniform-block.ts) is the canonical consumer: it turns an array of these
 *  into typed, per-field pack/write functions so a struct's byte offsets never get hand-copied
 *  into a renderer again.
 *
 *  Exported from `@xgis/shader-dsl`.
 */
export interface FieldLayout {
  readonly name: string
  readonly type: string
  readonly offset: number
  readonly align: number
  readonly size: number
}
/** A struct's complete recovered byte layout: total `size`/`align` plus one `FieldLayout` per
 *  field, in declaration order. Produced by `wgslLayout(struct, kind)` for a standalone struct
 *  handle, and by `reflect(module).uniforms` / `.storage` for every struct actually bound in a
 *  module (std140 for `uniform`, std430 for `storage` — see `LayoutKind`). `size` is already
 *  rounded up to `align` (the struct's own base alignment, itself rounded to 16 under std140),
 *  so it is the correct stride for an ARRAY of this struct, not just one instance's byte count.
 *
 *  Exported from `@xgis/shader-dsl`.
 */
export interface StructLayout {
  readonly name: string
  readonly size: number
  readonly align: number
  readonly fields: readonly FieldLayout[]
}

/** Compute the std140 (uniform) / std430 (storage) byte layout of a struct: per-field
 *  offset/align/size + the struct's total size + alignment. Std140 rounds the STRUCT
 *  and ARRAY base alignment up to 16 (uniform rule); std430 uses natural alignment. */
export function wgslLayout(
  struct: StructDecl,
  layout: LayoutKind,
  structs: ReadonlyMap<string, StructDecl> = new Map(),
): StructLayout {
  return structLayout(struct, layout, structs.size ? structs : new Map([[struct.name, struct]]))
}

function structLayout(
  struct: StructDecl,
  layout: LayoutKind,
  structs: ReadonlyMap<string, StructDecl>,
): StructLayout {
  let cursor = 0
  let maxAlign = 1
  const fields: FieldLayout[] = []
  for (const f of struct.fields) {
    const { size, align } = typeLayout(f.type, layout, structs)
    cursor = roundUp(cursor, align)
    fields.push({ name: f.name, type: typeKey(f.type), offset: cursor, align, size })
    cursor += size
    if (align > maxAlign) maxAlign = align
  }
  const structAlign = layout === 'std140' ? roundUp(maxAlign, 16) : maxAlign
  return { name: struct.name, size: roundUp(cursor, structAlign), align: structAlign, fields }
}

/** What a bind entry actually IS at the host API, independent of which WGSL address space
 *  (`uniform`/`storage`) or DSL type (`texture`/`sampler`) declared it — the field a host
 *  switches on to pick its GPU resource type rather than re-deriving it from `space` plus the
 *  binding's raw type. `'uniform-buffer'` and `'storage-buffer'` both back a `GPUBuffer`; the
 *  entry's `access` (present only on the latter) further splits it into read-only vs
 *  read-write storage (`bufferTypeFor`, rhi-webgpu/reflection-to-webgpu.ts:34-38).
 *  `'texture'`/`'sampler'` are the two kinds a buffer-only adapter must reject rather than
 *  silently mis-bind — `reflectionGroupToBindGroupLayoutEntries` throws on either
 *  (rhi-webgpu/reflection-to-webgpu.ts:61-65). On the GLSL ES 3.00 backend a `'sampler'` entry
 *  FUSES into its paired `'texture'` entry's combined `sampler2D` uniform and gets no emitted
 *  declaration of its own (glsl.ts:1461) — it still appears in `bindGroups` (reflection reports
 *  structure, not what GLSL chose to elide), just with nothing separate for a host to bind.
 *
 *  Exported from `@xgis/shader-dsl`.
 */
export type ResourceKind = 'uniform-buffer' | 'storage-buffer' | 'texture' | 'sampler'
/** One resource slot in a reflected bind group — the recovered shape of a single WGSL
 *  `@group(G) @binding(B) var<space> name: T` declaration (or, on the GLSL ES 3.00 backend, its
 *  emitted sampler uniform or std140 UBO block). `name` is the DECLARATION's own identifier —
 *  what shader code addresses through (`field_view.foo`) — which is NOT what a GLSL host binds
 *  by for a struct binding: GLSL's block syntax is `layout(std140) uniform <StructName> { … }
 *  <name>;`, so `getUniformBlockIndex` needs `structName` (the struct's own type name, e.g.
 *  `'FieldView'` for a binding named `field_view` — map/src/shaders/dsl/field-lattice.ts:111-113),
 *  not `name`. Get this wrong and the block does not fail to link — it silently lands at GL's
 *  default binding point 0, aliasing whatever else is there (the real incident:
 *  arrow-retained-advected-material.ts:48-53).
 *
 *  `group`/`binding` are metadata ONLY on the GLSL backend: the emitted GLSL source carries no
 *  binding qualifier at all (GLSL ES 3.00 has none to write — glsl.ts never emits
 *  `layout(binding=…)`), so a GLSL host resolves every entry by NAME at link time and then
 *  assigns the binding point / texture unit itself from these numbers. WGSL's `group` has no
 *  GLSL counterpart to carry it forward — a host that wants two groups' binding-0 entries not to
 *  collide in GLSL's one flat namespace has to fold `group` into the point itself
 *  (rhi-webgl2.ts:1277-1283 does `group * 8 + binding` for UBOs, but a raw `binding` for sampler
 *  texture units at rhi-webgl2.ts:1316 — the two kinds are NOT namespaced the same way). This
 *  stays latent in practice: every shader module in this repo declares only group 0
 *  (rhi-webgpu/reflection-to-webgpu.ts:74-76).
 *
 *  Exported from `@xgis/shader-dsl`.
 */
export interface BindEntry {
  readonly group: number
  readonly binding: number
  readonly name: string
  readonly space: AddressSpace
  readonly access?: 'read' | 'read_write'
  readonly resourceKind: ResourceKind
  /** WHO owns the resource (#1710) — `'module'` when we declare it and the host builds its
   *  bind group from this reflection, `'host'` when the surrounding renderer owns it and
   *  ITS layout is the authority. ALWAYS set, same contract as `resourceKind`: an
   *  only-when-interesting field would make `undefined` mean both "module-owned" and "an
   *  older reflection that predates the distinction". `bindGroups` stays the COMPLETE set
   *  either way — a host still has to know about a binding it owns, it just must not
   *  allocate for it. */
  readonly owner: 'module' | 'host'
  /** For a HOST-owned STRUCT binding ONLY (#1710): how GLSL ES 3.00 spells it. Absent
   *  everywhere else, because everywhere else there is no choice to report — a module-owned
   *  block is always std140, and WGSL has one spelling regardless.
   *
   *  A consumer needs this to know how to BIND: `'std140-block'` means bind a UBO to the
   *  block index, `'loose'` means the members were flattened into the default block and are
   *  set individually with `glUniform*` under their FIELD names (the layout in `uniforms`
   *  still lists them, in declaration order). */
  readonly glslSpelling?: 'std140-block' | 'loose'
  readonly structName?: string
  /** For a `texture` entry ONLY (#1651): which texture dim the shader declared, so a
   *  host can create/validate the matching view (`2d-array` needs an array view and
   *  a layer-aware bind, `2d-ms` a multisampled one). ALWAYS set on a texture entry —
   *  `resourceKind: 'texture'` alone under-describes the binding, and an
   *  only-when-interesting field would make `undefined` mean two different things. */
  readonly textureDim?: '2d' | '2d-ms' | '2d-array'
  /** For a `texture` entry ONLY (#1703): the texel ELEMENT the shader declared. Same
   *  contract as `textureDim` — ALWAYS set on a texture entry, never elsewhere.
   *
   *  A host needs BOTH axes to build a valid binding: dim alone does not say whether
   *  the view is float or integer, and the two are not interchangeable — WebGPU's
   *  `GPUTextureBindingLayout.sampleType` must be `'uint'` / `'sint'` for `u32` / `i32`
   *  (`'float'` for f32), and WebGL2 must back it with an INTEGER internal format
   *  (R32UI / R32I). Reported as the DSL's own element rather than pre-translated to
   *  either target's vocabulary, because reflection takes a module and never a backend.
   *
   *  An integer texture is also UNFILTERABLE, so a host must not pair one with a
   *  filtering sampler — there is no `sampler` binding to pair it with in a
   *  correctly-authored module, since `textureSample` rejects those keys at tsc. */
  readonly textureElem?: TextureElem
}
/** One WGSL `@group(N)`'s worth of bind entries, sorted by `binding`. `Reflection.bindGroups`
 *  is the complete list across every group the module declares, sorted by `group` — but every
 *  shader module in this repo declares only group 0 today
 *  (`reflectionToBindGroupLayoutEntries`'s group-0 convenience,
 *  rhi-webgpu/reflection-to-webgpu.ts:74-76), so a consumer reaching for `bindGroups[1]` is
 *  reaching for something nothing here yet produces. GLSL ES 3.00 has no notion of a group at
 *  all — see `BindEntry` for how a GLSL host has to fold it back in.
 *
 *  Exported from `@xgis/shader-dsl`.
 */
export interface BindGroup {
  readonly group: number
  readonly entries: readonly BindEntry[]
}
/** One `@location`-attributed parameter of the module's `@vertex` entry point, in the order the
 *  entry function declares its params. `offset` comes from walking those params in declaration
 *  order and rounding each one up to its OWN type's std430 alignment (reflect.ts:516-527) — a
 *  tightly-packed-per-alignment layout, not a hand-chosen one, so reordering the entry's params
 *  changes every later attribute's `offset`. `type` is the DSL type key (`typeKey`), the same
 *  spelling `StructLayout.fields[].type` uses.
 *
 *  Exported from `@xgis/shader-dsl`.
 */
export interface VertexAttr {
  readonly name: string
  readonly location: number
  readonly type: string
  readonly offset: number
}
/** The reflected vertex-buffer layout for a module's `@vertex` entry: every `@location`
 *  parameter plus the total interleaved `arrayStride` those parameters pack into. `reflect()`
 *  captures only the FIRST `@vertex` entry it finds walking `module.funcs` (reflect.ts:513's
 *  `!vertex` guard) — a module authoring more than one vertex entry point gets a `VertexLayout`
 *  for whichever is declared first, and nothing for the rest. `Reflection.vertex` is
 *  `undefined`, not an empty object, when the module has no `@location` vertex params at all.
 *
 *  Exported from `@xgis/shader-dsl`.
 */
export interface VertexLayout {
  readonly attributes: readonly VertexAttr[]
  readonly arrayStride: number
}
/** One `@vertex`/`@fragment`/`@compute` entry point: its stage, parameter/return types as DSL
 *  type keys (not full `ShaderType`s), and — for `@compute` only — its workgroup size, defaulted
 *  to 64 when the entry declares none (reflect.ts:509's `workgroupSizeOf(f) ?? 64`, matching the
 *  WGSL backend's own default). This is the shape `semanticDiff` fingerprints a module's public
 *  interface with (`entry <name> stage=<s> wg=<n> in=[…] out=<t>`, core/semantic-diff.ts:181-186)
 *  — two modules whose entries differ here have a different pipeline contract even if every
 *  other byte of emitted source matches.
 *
 *  Exported from `@xgis/shader-dsl`.
 */
export interface EntryInfo {
  readonly name: string
  readonly stage: 'vertex' | 'fragment' | 'compute'
  readonly workgroupSize?: number
  readonly inputs: readonly string[]
  readonly output: string
  /** The PORTABLE KERNEL TIER declaration (#1812), present only when the entry declares it —
   *  never `false`. This is the HOST-CONTRACT signal: on a backend with no compute stage the
   *  module emits as fragment-GPGPU and must be dispatched as a fullscreen DRAW into an R32UI
   *  target rather than as a compute dispatch (`rhi-webgl2/src/compute-webgl2.ts` absorbs
   *  exactly that). Read it to decide which dispatch shape a kernel needs; its absence means
   *  the kernel is WebGPU-only. */
  readonly portable?: true
}
/** A pipeline SPECIALIZATION CONSTANT (#923) the host must supply per pipeline
 *  variant. Both backends' host shapes derive from this: the WGSL `constants: {}`
 *  dict is `{ [name]: value }` (default when the host injects nothing), and the GLSL
 *  `#define` header is one `#define <name> <value>` line per entry — both keyed by
 *  `name`, defaulting to `default`. */
export interface OverrideInfo {
  readonly name: string
  readonly type: string
  readonly default: number | boolean
}
/** The complete target-neutral pipeline metadata `reflect(module)` recovers from a module's IR:
 *  bind-group layout (`bindGroups`), every bound struct's byte layout (`uniforms`/`storage`),
 *  the vertex-attribute layout if any (`vertex`), every entry point's signature (`entries`),
 *  specialization constants (`overrides`), the capabilities a host must activate before pipeline
 *  creation (`requiredFeatures`), and host-provided externs the module expects (`requires`) —
 *  see each field's own doc for its shape. This is the object that replaced hand-derived
 *  bind-group layouts and hand-copied byte offsets across the renderer: every
 *  `map/src/render/*-uniform-slots.ts` file, `BindGroupRegistry`, and `point-renderer.ts`'s
 *  bind-group-layout builder source their numbers from a `reflect()` call on the SAME module the
 *  shader text is emitted from, instead of a second hand-maintained table that can drift from it
 *  (the motivating bug: a `viewport` field at byte 20 in the shader and byte 24 in the hand
 *  packer — point-renderer.ts:52-54).
 *
 *  Exported from `@xgis/shader-dsl`.
 */
export interface Reflection {
  readonly bindGroups: readonly BindGroup[]
  /** std140 uniform-buffer struct layouts (one per uniform binding whose type is a struct). */
  readonly uniforms: readonly StructLayout[]
  /** std430 storage-buffer struct layouts. */
  readonly storage: readonly StructLayout[]
  /** Vertex attributes from the @vertex entry's @location params. Offsets are
   *  std430-ALIGNED (each field rounded up to its type's alignment — see the
   *  roundUp in the vertex branch), not tightly packed (#763 H3); consumers take
   *  offset+stride from here, verified against 4 renderers. */
  readonly vertex?: VertexLayout
  readonly entries: readonly EntryInfo[]
  /** Pipeline specialization constants (#923) — names + types + defaults the host
   *  passes at pipeline creation (WGSL `constants` / GLSL `#define` header). Always
   *  present; empty for a module that declares no overrides. */
  readonly overrides: readonly OverrideInfo[]
  /** Every capability this module's emit requires (#1670) — the DERIVED resource caps
   *  (a storage binding ⇒ `storageBuffer`, a `@compute` entry ⇒ `compute`, an MSAA
   *  texture load ⇒ `msaaTextureLoad`) plus everything the module declared in
   *  `enables`. Sorted, deduped. Always present; empty for a module that needs nothing.
   *
   *  This is what a host must have ACTIVE before it creates a pipeline for this module.
   *  The ids are NEUTRAL (#1650) because reflection is target-neutral — it takes a
   *  module, never a backend — so translate each through the target backend's
   *  `capProfile` with `hostFeaturesFor`, THE host-activation lookup (core/backend.ts):
   *
   *  ```ts
   *  for (const ext of hostFeaturesFor(glslEs300Backend, reflect(m).requiredFeatures)) {
   *    if (!gl.getExtension(ext)) throw new Error(`WebGL2 lacks ${ext}`)
   *  }
   *  // WebGPU, at BOOT (requiredFeatures are fixed at requestDevice — pipeline time is
   *  // too late): requestDevice({
   *  //   requiredFeatures: hostFeaturesFor(wgslBackend, reflect(m).requiredFeatures) })
   *  ```
   *
   *  Almost every cap the target has NO row for is unreachable here in a usable pipeline —
   *  emit already failed closed at assertCaps naming it (SD0030). The exception is
   *  `storageBuffer` on GLSL: a storage module is REWRITTEN to a data texture before the
   *  gate, so it emits fine while reflection of the AUTHORED module still reports the cap.
   *  A host loop is unharmed either way — `hostFeaturesFor` skips every cap whose row (or
   *  whose row's `hostFeature`) is absent. A row's `directive` is likewise not the host's
   *  business: it is already in the emitted source. */
  readonly requiredFeatures: readonly Capability[]
  /** HOST-PROVIDED symbols this module references but does not declare (#1713) — the
   *  `externVar` declarators, reported so a composer can check them against what the
   *  host's prelude actually supplies. Always present; empty for a module that expects
   *  nothing from its host. Its function twin, `externFn`, has no declaration to report;
   *  a fragment's `requires` (#1711) covers those by walking call sites. */
  readonly requires: readonly ExternRequirement[]
}

/** One host-provided global a module expects (#1713). `type` is the DSL type key, and
 *  `wgsl`/`glsl` are the per-target spellings the emit actually writes — the host binds by
 *  those, not by the logical `name`. */
export interface ExternRequirement {
  readonly name: string
  readonly type: string
  readonly wgsl: string
  readonly glsl: string
  readonly stage?: 'vertex' | 'fragment' | 'compute'
}

const resourceKind = (space: AddressSpace, t: ShaderType): ResourceKind =>
  t.kind === 'texture'
    ? 'texture'
    : t.kind === 'sampler'
      ? 'sampler'
      : space === 'storage'
        ? 'storage-buffer'
        : 'uniform-buffer'

// String fallback ONLY (#740 R3): fn()-authored decls carry structured
// `stage`/`workgroupSize` — reflect reads those first; the attrs-string parse
// survives solely for hand-built FuncDecl literals.
// Stage / workgroup-size predicates live in core/ir (#763 S1) — one shared helper
// for reflect, the capability gate, GLSL entry classification, and fn-DCE roots.

/** Options for {@link reflect}. */
export interface ReflectOptions {
  /** Which df64 EFT registry the emit will use (#1724). It decides whether the `_fp64`
   *  anti-fast-math guard binding exists at all: the `'float'` bodies (the default) read it,
   *  the `'integer'` ones do not. Pass the same value the emit will get, or a host building
   *  a bind group from this reflection is describing a different program than the one it
   *  will run. */
  readonly fp64Flavor?: Fp64Flavor
}

/** The module's declared bindings, plus any a LOWERING injects that a host must still bind
 *  (#1724).
 *
 *  `fp64Lower` auto-injects the `_fp64` guard texture into any module whose f64 helpers read
 *  it — authors declare nothing, which is the documented contract (`fp64/df64-lib.ts`: "Either
 *  way the binding shows up in reflect() … and the host MUST bind a 1x1 texture"). It runs
 *  inside emit, so before this the emitted source declared a binding the reflection did not
 *  report, and a host that built its bind group from the reflection never bound the guard the
 *  shader samples. On WebGPU that is a validation error; on WebGL2 there is no error at all —
 *  the sampler stays on its default unit and the guard silently reads a value that is not 1.0,
 *  so the anti-fast-math protection lapses without a symptom.
 *
 *  The decision is fp64Lower's and stays there: whether a guard is needed depends on WHICH
 *  helpers the lowering pulled in (comparison-only closures read no guard) and on the flavor,
 *  neither of which is cheap to re-derive — and a second copy of that rule is how the two
 *  authorities drifted in the first place. So this runs the pass and takes ONLY the bindings
 *  it added. Deliberately not "reflect the lowered module": that would also re-report every
 *  f64 type as its `vec2<f32>` emulation, which is a much larger change than the contract
 *  violation being fixed here.
 *
 *  Identity for every module without f64 — `fp64Lower` returns the same object, so the cost
 *  is one reference comparison. */
function bindingsIncludingInjected(
  m: ModuleDecl,
  flavor: Fp64Flavor | undefined,
): readonly BindingDecl[] {
  const lowered = fp64Lower(m, flavor !== undefined ? { flavor } : undefined)
  if (lowered === m) return m.bindings
  const declared = new Set(m.bindings.map((b) => b.name))
  const injected = lowered.bindings.filter((b) => !declared.has(b.name))
  return injected.length === 0 ? m.bindings : [...m.bindings, ...injected]
}

/**
 * Recover the target-neutral pipeline metadata from a module's IR. Pure + read-only.
 *
 * Reports the bindings a host must create — including the ones a LOWERING injects rather
 * than the author declaring (#1724, see {@link ReflectOptions.fp64Flavor}), because a host
 * builds its bind group from this and a binding missing here is a binding never bound.
 *
 * @param m - the module to describe.
 * @param opts - emit facts that change what the host must bind. Pass the same values the
 *   emit will get; a default here that disagrees with the emit describes a different program.
 */
export function reflect(m: ModuleDecl, opts?: ReflectOptions): Reflection {
  const structs = new Map(m.structs.map((s) => [s.name, s]))
  const allBindings = bindingsIncludingInjected(m, opts?.fp64Flavor)
  // bind groups (sorted by group, then binding)
  const byGroup = new Map<number, BindEntry[]>()
  for (const b of allBindings) {
    const e: BindEntry = {
      group: b.group,
      binding: b.binding,
      name: b.name,
      space: b.space,
      ...(b.access ? { access: b.access } : {}),
      resourceKind: resourceKind(b.space, b.type),
      owner: b.owner ?? 'module',
      ...(b.type.kind === 'struct' && b.owner === 'host'
        ? { glslSpelling: b.glsl ?? 'std140-block' }
        : {}),
      ...(b.type.kind === 'struct' ? { structName: b.type.name } : {}),
      ...(b.type.kind === 'texture' ? { textureDim: b.type.dim, textureElem: b.type.elem } : {}),
    }
    ;(byGroup.get(b.group) ?? byGroup.set(b.group, []).get(b.group)!).push(e)
  }
  const bindGroups: BindGroup[] = [...byGroup.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([group, entries]) => ({ group, entries: entries.sort((a, b) => a.binding - b.binding) }))

  const uniforms: StructLayout[] = []
  const storage: StructLayout[] = []
  for (const b of allBindings) {
    if (b.type.kind !== 'struct') continue
    const s = structs.get(b.type.name)
    if (!s) continue
    if (b.space === 'uniform') uniforms.push(structLayout(s, 'std140', structs))
    else storage.push(structLayout(s, 'std430', structs))
  }

  const entries: EntryInfo[] = []
  let vertex: VertexLayout | undefined
  for (const f of m.funcs) {
    const stage = stageOf(f)
    if (!stage) continue
    entries.push({
      name: f.name,
      stage,
      ...(stage === 'compute' ? { workgroupSize: workgroupSizeOf(f) ?? 64 } : {}),
      inputs: f.params.map((p) => typeKey(p.type)),
      output: typeKey(f.ret),
      // Present only when declared (#1812) — an absent field, not `portable: false`, so the
      // host reads "WebGPU-only" the same way it reads every other absent capability.
      ...(f.portable === true ? { portable: true as const } : {}),
    })
    if (stage === 'vertex' && !vertex) {
      let cursor = 0
      const attributes: VertexAttr[] = []
      for (const p of f.params) {
        if (p.location === undefined) continue
        const { size, align } = typeLayout(p.type, 'std430', structs)
        cursor = roundUp(cursor, align)
        attributes.push({
          name: p.name,
          location: p.location,
          type: typeKey(p.type),
          offset: cursor,
        })
        cursor += size
      }
      if (attributes.length) vertex = { attributes, arrayStride: cursor }
    }
  }

  // #923 — specialization constants, in declaration order (the host reads names +
  // defaults straight from here to build the WGSL `constants` dict / GLSL define header).
  const overrides: OverrideInfo[] = (m.overrides ?? []).map((o) => ({
    name: o.name,
    type: typeKey(o.type),
    default: o.default,
  }))

  // #1670 — the caps the host must have active before pipeline creation. Same
  // derivation the emit gate uses (requiredCaps: shape-derived + declared `enables`), so
  // reflection and assertCaps can never disagree about what a module needs; sorted for a
  // deterministic order. Always present, empty when the module needs nothing — the
  // `overrides` model, so a consumer never distinguishes "needs nothing" from "old
  // reflection shape".
  const requiredFeatures = requiredCaps(m).sort()

  return {
    bindGroups,
    uniforms,
    storage,
    ...(vertex ? { vertex } : {}),
    entries,
    overrides,
    requiredFeatures,
    requires: (m.externs ?? []).map((e) => ({
      name: e.name,
      type: typeKey(e.type),
      wgsl: e.spelling?.wgsl ?? e.name,
      glsl: e.spelling?.glsl ?? e.name,
      ...(e.stage ? { stage: e.stage } : {}),
    })),
  }
}
