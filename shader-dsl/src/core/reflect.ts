// ═══ Shader DSL — pipeline REFLECTION (additive, never on the emit path) ═══
//
// The IR already carries every binding/struct/entry fact, but emitModule discards
// it into a string — so a host re-derives bind-group layouts + uniform byte offsets
// BY HAND (and they drift; see runtime point-uniform-layout.test.ts). reflect(module)
// recovers that metadata as a target-neutral `Reflection` object the host can consume
// mechanically: bind-group entries, std140/std430 struct byte layouts, vertex
// attributes, and entry-point signatures.
//
// PURE + ADDITIVE: this module is read-only over the IR and is NOT imported by any
// emit path, so it cannot change a single emitted byte. The std140/std430 offsets are
// anchored to the offsets the runtime already ships (reflect.test.ts).

import { type ShaderType, type StructDecl, type ModuleDecl, type AddressSpace, typeKey } from './ir'

const roundUp = (x: number, a: number): number => Math.ceil(x / a) * a

export type LayoutKind = 'std140' | 'std430'

/** Size + alignment (bytes) of a host-shareable type under a layout. Throws on a
 *  non-host-shareable type (texture/sampler/void are bind resources, not struct fields). */
function typeLayout(t: ShaderType, layout: LayoutKind, structs: ReadonlyMap<string, StructDecl>): { size: number; align: number } {
  switch (t.kind) {
    case 'scalar':
      return { size: 4, align: 4 }
    case 'vec':
      // vec2 → 8/8, vec3 → 12/16, vec4 → 16/16 (elem is always 4 bytes)
      return t.n === 2 ? { size: 8, align: 8 } : t.n === 3 ? { size: 12, align: 16 } : { size: 16, align: 16 }
    case 'mat': {
      // matNxN<f32>: N columns of vecN; column stride = round(size,align) of the column vec.
      const col = t.n === 2 ? { size: 8, align: 8 } : t.n === 3 ? { size: 12, align: 16 } : { size: 16, align: 16 }
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
      if (layout === 'std140') { stride = roundUp(stride, 16); align = roundUp(align, 16) }
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

export interface FieldLayout { readonly name: string; readonly type: string; readonly offset: number; readonly align: number; readonly size: number }
export interface StructLayout { readonly name: string; readonly size: number; readonly align: number; readonly fields: readonly FieldLayout[] }

/** Compute the std140 (uniform) / std430 (storage) byte layout of a struct: per-field
 *  offset/align/size + the struct's total size + alignment. Std140 rounds the STRUCT
 *  and ARRAY base alignment up to 16 (uniform rule); std430 uses natural alignment. */
export function wgslLayout(struct: StructDecl, layout: LayoutKind, structs: ReadonlyMap<string, StructDecl> = new Map()): StructLayout {
  return structLayout(struct, layout, structs.size ? structs : new Map([[struct.name, struct]]))
}

function structLayout(struct: StructDecl, layout: LayoutKind, structs: ReadonlyMap<string, StructDecl>): StructLayout {
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
export interface BindGroup { readonly group: number; readonly entries: readonly BindEntry[] }
export interface VertexAttr { readonly name: string; readonly location: number; readonly type: string; readonly offset: number }
export interface VertexLayout { readonly attributes: readonly VertexAttr[]; readonly arrayStride: number }
export interface EntryInfo {
  readonly name: string
  readonly stage: 'vertex' | 'fragment' | 'compute'
  readonly workgroupSize?: number
  readonly inputs: readonly string[]
  readonly output: string
}
export interface Reflection {
  readonly bindGroups: readonly BindGroup[]
  /** std140 uniform-buffer struct layouts (one per uniform binding whose type is a struct). */
  readonly uniforms: readonly StructLayout[]
  /** std430 storage-buffer struct layouts. */
  readonly storage: readonly StructLayout[]
  /** Vertex attributes from the @vertex entry's @location params (packed offsets). */
  readonly vertex?: VertexLayout
  readonly entries: readonly EntryInfo[]
}

const resourceKind = (space: AddressSpace, t: ShaderType): ResourceKind =>
  t.kind === 'texture' ? 'texture' : t.kind === 'sampler' ? 'sampler' : space === 'storage' ? 'storage-buffer' : 'uniform-buffer'

const stageOf = (attrs: readonly string[] | undefined): EntryInfo['stage'] | undefined =>
  attrs?.some((a) => a.startsWith('@vertex')) ? 'vertex'
    : attrs?.some((a) => a.startsWith('@fragment')) ? 'fragment'
      : attrs?.some((a) => a.startsWith('@compute')) ? 'compute' : undefined

const workgroupSize = (attrs: readonly string[] | undefined): number | undefined => {
  const m = attrs?.map((a) => a.match(/@workgroup_size\((\d+)/)).find(Boolean)
  return m ? Number(m[1]) : undefined
}

/** Recover the target-neutral pipeline metadata from a module's IR. Pure + read-only. */
export function reflect(m: ModuleDecl): Reflection {
  const structs = new Map(m.structs.map((s) => [s.name, s]))
  // bind groups (sorted by group, then binding)
  const byGroup = new Map<number, BindEntry[]>()
  for (const b of m.bindings) {
    const e: BindEntry = {
      group: b.group, binding: b.binding, name: b.name, space: b.space,
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
    const stage = stageOf(f.attrs)
    if (!stage) continue
    entries.push({
      name: f.name, stage,
      ...(stage === 'compute' ? { workgroupSize: workgroupSize(f.attrs) ?? 64 } : {}),
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
        attributes.push({ name: p.name, location: p.location, type: typeKey(p.type), offset: cursor })
        cursor += size
      }
      if (attributes.length) vertex = { attributes, arrayStride: cursor }
    }
  }

  return { bindGroups, uniforms, storage, ...(vertex ? { vertex } : {}), entries }
}
