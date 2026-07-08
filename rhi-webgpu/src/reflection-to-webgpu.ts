// ═══════════════════════════════════════════════════════════════════
// Reflection → WebGPU adapter (pure runtime-side descriptor factory)
// ═══════════════════════════════════════════════════════════════════
//
// Sibling of compute-bind-layout.ts: a pure, GPUDevice-free mapper from
// the @xgis/shader-dsl neutral `Reflection` (reflect(module)) into the
// WebGPU descriptor shapes the renderer hands to `device.create*`.
//
// Why this exists: a renderer used to re-derive its bind-group layout and
// its uniform byte offsets BY HAND from the WGSL it shipped — two parallel
// hand-maintained tables that silently drift from the shader (the point
// path had a real `viewport @20 vs @24` drift bug; see
// point-uniform-layout.test.ts). reflect() recovers those facts from the
// SAME IR the shader is emitted from, so sourcing them here makes drift
// structurally impossible.
//
// What this module does NOT do (mirrors compute-bind-layout.ts):
//   - Create the GPUBindGroupLayout. The caller passes the returned
//     descriptor entries to `device.createBindGroupLayout` itself; this
//     keeps the module pure + Node-testable.
//   - Decide visibility flags. Reflection records structure (binding
//     number, resource kind, access), NOT which shader stages read a
//     binding — that is the renderer's own knowledge and was never the
//     drift source. The caller supplies per-binding visibility bits;
//     they are passed in (not imported) so tests run without WebGPU
//     globals.

import type { Reflection, BindGroup, BindEntry, StructLayout } from '@xgis/shader-dsl'

/** Per-binding shader-stage visibility (GPUShaderStage bits). Keyed by the
 *  binding slot the reflection reports. */
export type VisibilityMap = ReadonlyMap<number, number>

const bufferTypeFor = (e: BindEntry): GPUBufferBindingType => {
  if (e.resourceKind === 'uniform-buffer') return 'uniform'
  // storage-buffer: 'read' access → read-only-storage, else read-write storage.
  return e.access === 'read_write' ? 'storage' : 'read-only-storage'
}

/** Map a reflected bind GROUP into the GPUBindGroupLayoutEntry[] the renderer
 *  passes to `device.createBindGroupLayout`. Entries come out in the
 *  reflection's binding order (reflect() already sorts by binding).
 *
 *  `visibility` supplies the GPUShaderStage bits per binding (the one fact
 *  reflection cannot know — which stages read the resource). Throws if a
 *  binding has no visibility entry so a missing stage flag fails loud at
 *  layout-build time rather than silently rendering with a wrong layout.
 *
 *  Texture / sampler resources are not produced here (no point shader uses
 *  them); they would need `texture`/`sampler` descriptor members and are
 *  rejected so an unhandled kind can't slip through as a buffer entry. */
export function reflectionGroupToBindGroupLayoutEntries(
  group: BindGroup,
  visibility: VisibilityMap,
): GPUBindGroupLayoutEntry[] {
  return group.entries.map((e) => {
    const vis = visibility.get(e.binding)
    if (vis === undefined) {
      throw new Error(`reflectionToWebGPU: no visibility for binding ${e.binding} ('${e.name}')`)
    }
    if (e.resourceKind === 'texture' || e.resourceKind === 'sampler') {
      throw new Error(
        `reflectionToWebGPU: ${e.resourceKind} binding ${e.binding} not supported by the buffer adapter`,
      )
    }
    return {
      binding: e.binding,
      visibility: vis,
      buffer: { type: bufferTypeFor(e) },
    }
  })
}

/** Convenience: build the bind-group-layout entries for group 0 of a
 *  reflection (the only group X-GIS shaders use). */
export function reflectionToBindGroupLayoutEntries(
  reflection: Reflection,
  visibility: VisibilityMap,
): GPUBindGroupLayoutEntry[] {
  const group0 = reflection.bindGroups.find((g) => g.group === 0)
  if (!group0) throw new Error('reflectionToWebGPU: reflection has no @group(0) bindings')
  return reflectionGroupToBindGroupLayoutEntries(group0, visibility)
}

/** The std140 uniform struct's field byte-offsets, keyed by field name, as
 *  f32 SLOT indices (byteOffset / 4) — the unit the CPU Float32Array packer
 *  writes in. Sourced from `reflect(module).uniforms`. Throws if no uniform
 *  struct of `structName` is present.
 *
 *  Returned alongside the struct's total f32 slot count so the packer can
 *  size its Float32Array from the same source. */
export interface UniformFieldSlots {
  /** field name → f32 slot index (byteOffset / 4). */
  readonly slot: Readonly<Record<string, number>>
  /** total struct size in f32 slots (sizeBytes / 4). */
  readonly slots: number
}

export function uniformFieldSlots(reflection: Reflection, structName: string): UniformFieldSlots {
  const u: StructLayout | undefined = reflection.uniforms.find((s) => s.name === structName)
  if (!u) throw new Error(`reflectionToWebGPU: no uniform struct '${structName}' in reflection`)
  const slot: Record<string, number> = {}
  for (const f of u.fields) {
    if (f.offset % 4 !== 0) {
      throw new Error(
        `reflectionToWebGPU: field '${f.name}' byteOffset ${f.offset} is not f32-aligned`,
      )
    }
    slot[f.name] = f.offset / 4
  }
  return { slot, slots: u.size / 4 }
}
