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
//   - Own the GPUShaderStage BIT VALUES. Which stages read a binding is no
//     longer the renderer's knowledge to author — `reflect()` reports it as
//     `BindEntry.stages` (#1906), from the same reachability walk the per-stage
//     GLSL emit uses — so this module DERIVES visibility and the caller supplies
//     only the three spec constants to OR together. They are passed in (not
//     imported) for the reason the sibling records at compute-bind-layout.ts:31 —
//     so tests run without WebGPU globals; `GPUShaderStage` itself satisfies the
//     shape, so a real caller passes it whole.

import type { Reflection, BindGroup, BindEntry, StructLayout } from '@xgis/shader-dsl'

/** The three `GPUShaderStage` bit values, passed in rather than imported so this
 *  module stays free of WebGPU globals (compute-bind-layout.ts:31 records the same
 *  reason for its `fragmentVisibilityBit`). The browser's own `GPUShaderStage`
 *  satisfies this structurally — `@webgpu/types` declares exactly these three
 *  readonly members — so a real caller passes the global itself and a Node test
 *  passes `{ VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 }`. */
export interface ShaderStageBits {
  readonly VERTEX: number
  readonly FRAGMENT: number
  readonly COMPUTE: number
}

/** OR the bits for the stages that actually reach this binding (#1913). `stages` is
 *  `reflect()`'s own answer, derived from the walk the emit uses to decide which unit
 *  declares which uniform — so a mask can no longer be narrower than the shader that
 *  runs under it, which is the failure a hand-authored map produced silently.
 *
 *  For a HOST-owned binding (`owner: 'host'`) `stages` is documented as the MODULE's
 *  view — a lower bound, not the authority. This adapter builds the layout for the
 *  module's OWN pipeline, so the lower bound is the right answer here; a host whose
 *  real layout is wider owns that layout itself and does not come through this path. */
const visibilityFor = (e: BindEntry, bits: ShaderStageBits): number => {
  let mask = 0
  for (const stage of e.stages)
    mask |= stage === 'vertex' ? bits.VERTEX : stage === 'fragment' ? bits.FRAGMENT : bits.COMPUTE
  return mask
}

const bufferTypeFor = (e: BindEntry): GPUBufferBindingType => {
  if (e.resourceKind === 'uniform-buffer') return 'uniform'
  // storage-buffer: 'read' access → read-only-storage, else read-write storage.
  return e.access === 'read_write' ? 'storage' : 'read-only-storage'
}

/** Map a reflected bind GROUP into the GPUBindGroupLayoutEntry[] the renderer
 *  passes to `device.createBindGroupLayout`. Entries come out in the
 *  reflection's binding order (reflect() already sorts by binding).
 *
 *  Visibility is DERIVED from each entry's `stages` (#1913); `bits` supplies only the
 *  three GPUShaderStage constants to OR together. An entry no stage reaches would make
 *  a `visibility` of 0, which WebGPU rejects — that throws here instead, so the case
 *  fails loud at layout-build time rather than at a `createBindGroupLayout` whose
 *  message names no binding.
 *
 *  Texture / sampler resources are not produced here (no point shader uses
 *  them); they would need `texture`/`sampler` descriptor members and are
 *  rejected so an unhandled kind can't slip through as a buffer entry. */
export function reflectionGroupToBindGroupLayoutEntries(
  group: BindGroup,
  bits: ShaderStageBits,
): GPUBindGroupLayoutEntry[] {
  return group.entries.map((e) => {
    const vis = visibilityFor(e, bits)
    if (vis === 0) {
      throw new Error(`reflectionToWebGPU: no stage reaches binding ${e.binding} ('${e.name}')`)
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
  bits: ShaderStageBits,
): GPUBindGroupLayoutEntry[] {
  const group0 = reflection.bindGroups.find((g) => g.group === 0)
  if (!group0) throw new Error('reflectionToWebGPU: reflection has no @group(0) bindings')
  return reflectionGroupToBindGroupLayoutEntries(group0, bits)
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
