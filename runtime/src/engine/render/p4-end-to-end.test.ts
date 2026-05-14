// ═══════════════════════════════════════════════════════════════════
// P4 end-to-end smoke test — compiler → runtime data flow
// ═══════════════════════════════════════════════════════════════════
//
// Locks in the contract between the compiler-side pieces shipped
// across this session and the runtime-side primitives:
//
//   1. compiler/emitCommands produces SceneCommands.computePlan
//   2. compiler/buildPerShowMergedVariant produces a merged
//      ShaderVariant whose computeBindings field signals the
//      runtime "use compute layout"
//   3. runtime/TileComputeResources holds the per-tile GPU buffers
//   4. runtime/packFeatureData packs per-feature property bags into
//      the f32 layout the kernel reads
//   5. runtime/ComputeDispatcher.dispatchKernel runs the kernel
//      against those buffers
//
// All seven pieces compose correctly when walked end-to-end. The
// test uses a fake GPUDevice (recording sentinels) so it runs in
// Node without WebGPU; what it ASSERTS is the cross-boundary
// alignment:
//
//   - kernel.entryPoint matches the merged variant's preamble decl
//   - kernel.categoryOrder drives the packer's string→ID lookup
//   - dispatchKernel uses the kernel.dispatchSize math the emitter
//     declared
//   - The (paintAxis, bindGroup, binding) triples on the merged
//     variant match the dispatcher's bind-group entries in count
//     and binding indices.
//
// Future refactors that drift any of these contracts trip this
// test BEFORE they hit a real GPU pipeline build.

import { beforeAll, describe, expect, it } from 'vitest'
import {
  emitCommands,
  buildPerShowMergedVariant,
  type Scene, type ColorValue, type DataExpr, type RenderNode,
  type SizeValue, type StrokeValue,
} from '@xgis/compiler'
import type { PropertyShape } from '@xgis/compiler'
import { ComputeDispatcher } from '../gpu/compute'
import { TileComputeResources } from './tile-compute-resources'
import { packFeatureData } from './compute-feature-packer'

beforeAll(() => {
  if (typeof globalThis.GPUBufferUsage === 'undefined') {
    ;(globalThis as { GPUBufferUsage: Record<string, number> }).GPUBufferUsage = {
      MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8,
      INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128,
      INDIRECT: 256, QUERY_RESOLVE: 512,
    }
  }
})

interface BufferRecord {
  size: number
  label: string
  destroyed: boolean
}

function makeFakeContext() {
  const buffers: BufferRecord[] = []
  const writes: { offset: number; bytes: number }[] = []
  const dispatches: { entryPoint: string; workgroups: number; bindings: number[] }[] = []

  const device = {
    createShaderModule(desc: { code: string; label?: string }): GPUShaderModule {
      return { _label: desc.label } as unknown as GPUShaderModule
    },
    createComputePipeline(desc: GPUComputePipelineDescriptor): GPUComputePipeline {
      const ep = (desc.compute as { entryPoint: string }).entryPoint
      return {
        _ep: ep,
        getBindGroupLayout(): GPUBindGroupLayout {
          return { _l: ep } as unknown as GPUBindGroupLayout
        },
      } as unknown as GPUComputePipeline
    },
    createBindGroup(desc: GPUBindGroupDescriptor): GPUBindGroup {
      // Record which binding indices were attached — we use this to
      // verify the dispatcher binds 3 entries (feat / out / count).
      const entries = desc.entries as GPUBindGroupEntry[]
      const indices = entries.map(e => e.binding)
      return { _label: desc.label, _indices: indices } as unknown as GPUBindGroup
    },
    createBuffer(desc: GPUBufferDescriptor): GPUBuffer {
      const rec: BufferRecord = {
        size: desc.size,
        label: desc.label ?? '<unlabeled>',
        destroyed: false,
      }
      buffers.push(rec)
      return {
        get size() { return rec.size },
        destroy() { rec.destroyed = true },
      } as unknown as GPUBuffer
    },
    queue: {
      writeBuffer(_b: GPUBuffer, offset: number, data: BufferSource, _dataOffset?: number, size?: number) {
        writes.push({ offset, bytes: size ?? (data as ArrayBuffer).byteLength })
      },
    },
  } as unknown as GPUDevice

  const encoder = {
    beginComputePass(_desc: GPUComputePassDescriptor): GPUComputePassEncoder {
      let ep = ''
      let workgroups = 0
      let bindIndices: number[] = []
      return {
        setPipeline(p: GPUComputePipeline) {
          ep = (p as unknown as { _ep: string })._ep
        },
        setBindGroup(_i: number, g: GPUBindGroup) {
          bindIndices = (g as unknown as { _indices: number[] })._indices ?? []
        },
        dispatchWorkgroups(n: number) { workgroups = n },
        end() {
          dispatches.push({ entryPoint: ep, workgroups, bindings: bindIndices })
        },
      } as unknown as GPUComputePassEncoder
    },
  } as unknown as GPUCommandEncoder

  return {
    dispatcher: new ComputeDispatcher({ device } as never),
    encoder,
    buffers, writes, dispatches,
  }
}

function fieldAccess(name: string) {
  return { kind: 'FieldAccess' as const, object: null, field: name }
}

function makeMatchScene(): Scene {
  const expr: DataExpr = {
    ast: {
      kind: 'FnCall',
      callee: { kind: 'Identifier', name: 'match' },
      args: [fieldAccess('class')],
      matchBlock: {
        kind: 'MatchBlock',
        arms: [
          { pattern: 'school',   value: { kind: 'ColorLiteral', value: '#f0e8f8' } },
          { pattern: 'hospital', value: { kind: 'ColorLiteral', value: '#f5deb3' } },
          { pattern: '_',        value: { kind: 'ColorLiteral', value: '#888888' } },
        ],
      },
    },
  }
  const fill: ColorValue = { kind: 'data-driven', expr }
  const node: RenderNode = {
    name: 'landuse', sourceRef: 'lu', zOrder: 0,
    fill,
    stroke: {
      color: { kind: 'none' },
      width: { kind: 'constant', value: 0 } as PropertyShape<number>,
    } as StrokeValue,
    opacity: { kind: 'constant', value: 1 },
    size: { kind: 'none' } as SizeValue,
    extrude: { kind: 'none' } as never,
    extrudeBase: { kind: 'none' } as never,
    projection: 'mercator', visible: true, pointerEvents: 'auto',
    filter: null, geometry: null, billboard: true,
    shape: { kind: 'named', name: 'circle' } as never,
  }
  return { sources: [], symbols: [], renderNodes: [node] } as Scene
}

describe('P4 end-to-end — compiler ↔ runtime contract', () => {
  it('Scene with match() fill produces SceneCommands.computePlan + ShowCommand.shaderVariant', () => {
    const cmds = emitCommands(makeMatchScene())
    expect(cmds.shows).toHaveLength(1)
    expect(cmds.computePlan).toBeDefined()
    expect(cmds.computePlan!.length).toBe(1)
  })

  it('buildPerShowMergedVariant attaches computeBindings to the show variant', () => {
    const cmds = emitCommands(makeMatchScene())
    const showVariant = cmds.shows[0]!.shaderVariant!
    const merged = buildPerShowMergedVariant(
      showVariant, cmds.computePlan, 0, /* group */ 3, /* base */ 1,
    )
    expect(merged.computeBindings).toBeDefined()
    expect(merged.computeBindings!.length).toBe(1)
    expect(merged.computeBindings![0]!.paintAxis).toBe('fill')
    expect(merged.computeBindings![0]!.bindGroup).toBe(3)
    expect(merged.computeBindings![0]!.binding).toBe(1)
  })

  it('merged variant fillExpr references the same WGSL var the preamble declares', () => {
    const cmds = emitCommands(makeMatchScene())
    const showVariant = cmds.shows[0]!.shaderVariant!
    const merged = buildPerShowMergedVariant(showVariant, cmds.computePlan, 0, 3, 1)
    // The preamble should declare compute_out_fill; fillExpr must
    // reference the same name. Drift here would produce an
    // unresolved-identifier WGSL compile error at pipeline create.
    expect(merged.preamble).toContain('compute_out_fill')
    expect(merged.fillExpr).toContain('compute_out_fill')
  })

  it('TileComputeResources allocates buffers per ComputePlanEntry', () => {
    const cmds = emitCommands(makeMatchScene())
    const { dispatcher } = makeFakeContext()
    const resources = new TileComputeResources(dispatcher, cmds.computePlan ?? [])
    expect(resources.entryCount).toBe(1)
    // One entry × 3 buffers (feat / out / count).
    // (The buffer count assertion belongs to TileComputeResources's
    // own tests; here we just verify the resource exists for
    // (renderNodeIndex=0, paintAxis='fill').)
    expect(resources.getOutBuffer(0, 'fill')).not.toBeNull()
  })

  it('packer + kernel category alignment: ID 0 = first sorted pattern', () => {
    const cmds = emitCommands(makeMatchScene())
    const entry = cmds.computePlan![0]!
    // sorted: ['hospital', 'school'] → ID 0 = hospital, ID 1 = school
    const props = (fid: number) => {
      if (fid === 0) return { class: 'hospital' }
      if (fid === 1) return { class: 'school' }
      return { class: 'unknown' }
    }
    const data = packFeatureData({
      getProps: props,
      fieldOrder: entry.fieldOrder,
      categoryOrder: entry.categoryOrder,
      featureCount: 3,
    })
    expect(Array.from(data)).toEqual([0, 1, -1])
    // The kernel's if-else chain matches these IDs (alphabetical
    // categoryOrder). Hospital → arm 0, school → arm 1, unknown →
    // default branch.
    expect(entry.kernel.wgsl).toContain('v_class == 0.0')
    expect(entry.kernel.wgsl).toContain('v_class == 1.0')
  })

  it('dispatch fires one compute pass with 3-binding bind group after uploadFromProps', () => {
    const cmds = emitCommands(makeMatchScene())
    const { dispatcher, encoder, dispatches } = makeFakeContext()
    const resources = new TileComputeResources(dispatcher, cmds.computePlan ?? [])
    const props = (_fid: number) => ({ class: 'school' })
    resources.uploadFromProps(props, 200)
    resources.dispatch(encoder)

    expect(dispatches).toHaveLength(1)
    expect(dispatches[0]!.entryPoint).toBe('eval_match')
    expect(dispatches[0]!.bindings).toEqual([0, 1, 2])
    // 200 features / workgroup_size 64 = ceil(200/64) = 4 workgroups.
    expect(dispatches[0]!.workgroups).toBe(4)
  })

  it('no-compute scene → empty computePlan, identity-merged variant, no resources', () => {
    const scene: Scene = {
      sources: [], symbols: [],
      renderNodes: [{
        name: 'a', sourceRef: 's', zOrder: 0,
        fill: { kind: 'constant', rgba: [1, 0, 0, 1] },
        stroke: { color: { kind: 'none' }, width: { kind: 'constant', value: 0 } } as StrokeValue,
        opacity: { kind: 'constant', value: 1 },
        size: { kind: 'none' } as SizeValue,
        extrude: { kind: 'none' } as never,
        extrudeBase: { kind: 'none' } as never,
        projection: 'mercator', visible: true, pointerEvents: 'auto',
        filter: null, geometry: null, billboard: true,
        shape: { kind: 'named', name: 'circle' } as never,
      } as RenderNode],
    } as Scene
    const cmds = emitCommands(scene)
    expect(cmds.computePlan).toBeUndefined()

    const showVariant = cmds.shows[0]!.shaderVariant!
    const merged = buildPerShowMergedVariant(showVariant, cmds.computePlan, 0, 3, 1)
    expect(merged).toBe(showVariant)               // identity-preserved
    expect(merged.computeBindings).toBeUndefined() // no signal to runtime

    const { dispatcher } = makeFakeContext()
    const resources = new TileComputeResources(dispatcher, cmds.computePlan ?? [])
    expect(resources.entryCount).toBe(0)
  })
})
