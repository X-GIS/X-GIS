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
  typeKey,
  stageOf,
  workgroupSizeOf,
} from './ir'

const roundUp = (x: number, a: number): number => Math.ceil(x / a) * a

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

export interface FieldLayout {
  readonly name: string
  readonly type: string
  readonly offset: number
  readonly align: number
  readonly size: number
}
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

export type ResourceKind = 'uniform-buffer' | 'storage-buffer' | 'texture' | 'sampler'
export interface BindEntry {
  readonly group: number
  readonly binding: number
  readonly name: string
  readonly space: AddressSpace
  readonly access?: 'read' | 'read_write'
  readonly resourceKind: ResourceKind
  readonly structName?: string
}
export interface BindGroup {
  readonly group: number
  readonly entries: readonly BindEntry[]
}
export interface VertexAttr {
  readonly name: string
  readonly location: number
  readonly type: string
  readonly offset: number
}
export interface VertexLayout {
  readonly attributes: readonly VertexAttr[]
  readonly arrayStride: number
}
export interface EntryInfo {
  readonly name: string
  readonly stage: 'vertex' | 'fragment' | 'compute'
  readonly workgroupSize?: number
  readonly inputs: readonly string[]
  readonly output: string
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

/** Recover the target-neutral pipeline metadata from a module's IR. Pure + read-only. */
export function reflect(m: ModuleDecl): Reflection {
  const structs = new Map(m.structs.map((s) => [s.name, s]))
  // bind groups (sorted by group, then binding)
  const byGroup = new Map<number, BindEntry[]>()
  for (const b of m.bindings) {
    const e: BindEntry = {
      group: b.group,
      binding: b.binding,
      name: b.name,
      space: b.space,
      ...(b.access ? { access: b.access } : {}),
      resourceKind: resourceKind(b.space, b.type),
      ...(b.type.kind === 'struct' ? { structName: b.type.name } : {}),
    }
    ;(byGroup.get(b.group) ?? byGroup.set(b.group, []).get(b.group)!).push(e)
  }
  const bindGroups: BindGroup[] = [...byGroup.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([group, entries]) => ({ group, entries: entries.sort((a, b) => a.binding - b.binding) }))

  const uniforms: StructLayout[] = []
  const storage: StructLayout[] = []
  for (const b of m.bindings) {
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

  return { bindGroups, uniforms, storage, ...(vertex ? { vertex } : {}), entries, overrides }
}
