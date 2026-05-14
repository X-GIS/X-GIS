// ═══════════════════════════════════════════════════════════════════
// Renderer compute-integration simulation
// ═══════════════════════════════════════════════════════════════════
//
// Plan Phase 4 final validation before VTR integration. Builds a
// minimal renderer-shaped fixture that exercises every line a real
// renderer would write to wire compute paint into its pipeline:
//
//   1. emitCommands(scene, { enableComputePath: true }) — compile
//      side delivers computePlan + merged variant w/ computeBindings
//   2. extendBindGroupLayoutEntriesForCompute(variant, base, FRAGMENT)
//      — pipeline layout entries
//   3. new ComputeLayerRegistry(dispatcher) — frame-level aggregator
//   4. registry.attach(key, variant, plan, idx) — per-show
//   5. handle.uploadFromProps(getProps, featureCount) — per-tile
//   6. registry.dispatchAll(encoder) — once per frame
//   7. handle.getBindGroupEntries() — bind-group entry assembly
//   8. device.createBindGroup({ layout, entries: [...legacy, ...computeEntries] })
//   9. registry.detach(key) / destroyAll() — cleanup
//
// All steps run against the same fake GPU device + encoder used by
// the unit tests for the constituent pieces, so cross-step drift
// (e.g. binding index mismatches between the layout descriptor and
// the bind-group entries) trips this test BEFORE the real WebGPU
// validation does at runtime.

import { beforeAll, describe, expect, it } from 'vitest'
import {
  emitCommands,
  type Scene, type ColorValue, type DataExpr, type RenderNode,
  type SizeValue, type StrokeValue,
} from '@xgis/compiler'
import type { PropertyShape } from '@xgis/compiler'
import { ComputeDispatcher } from '../gpu/compute'
import { ComputeLayerRegistry } from './compute-layer-registry'
import { extendBindGroupLayoutEntriesForCompute } from './compute-bind-layout'

beforeAll(() => {
  if (typeof globalThis.GPUBufferUsage === 'undefined') {
    ;(globalThis as { GPUBufferUsage: Record<string, number> }).GPUBufferUsage = {
      MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8,
      INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128,
      INDIRECT: 256, QUERY_RESOLVE: 512,
    }
  }
})

const FRAGMENT_BIT = 2  // GPUShaderStage.FRAGMENT

interface RecordedBindGroup {
  label: string | null
  entryBindings: number[]
}

function makeFakeContext() {
  const buffers: { label: string; size: number; destroyed: boolean }[] = []
  const writes: { bytes: number }[] = []
  const dispatches: { entryPoint: string; workgroups: number }[] = []
  const layoutEntries: GPUBindGroupLayoutEntry[][] = []
  const bindGroupsCreated: RecordedBindGroup[] = []

  const device = {
    createShaderModule(d: { code: string; label?: string }) {
      return { _l: d.label } as unknown as GPUShaderModule
    },
    createComputePipeline(d: GPUComputePipelineDescriptor) {
      const ep = (d.compute as { entryPoint: string }).entryPoint
      return {
        _ep: ep,
        getBindGroupLayout() { return { _l: ep } as unknown as GPUBindGroupLayout },
      } as unknown as GPUComputePipeline
    },
    createBindGroup(d: GPUBindGroupDescriptor) {
      const entries = d.entries as GPUBindGroupEntry[]
      bindGroupsCreated.push({
        label: d.label ?? null,
        entryBindings: entries.map(e => e.binding),
      })
      return { _stub: true } as unknown as GPUBindGroup
    },
    createBindGroupLayout(d: GPUBindGroupLayoutDescriptor) {
      const entries = d.entries as GPUBindGroupLayoutEntry[]
      layoutEntries.push([...entries])
      return { _l: d.label } as unknown as GPUBindGroupLayout
    },
    createBuffer(d: GPUBufferDescriptor) {
      const rec = { label: d.label ?? '<unlabeled>', size: d.size, destroyed: false }
      buffers.push(rec)
      return {
        _label: d.label,
        get size() { return rec.size },
        destroy() { rec.destroyed = true },
      } as unknown as GPUBuffer
    },
    queue: {
      writeBuffer(_b: GPUBuffer, _off: number, data: BufferSource, _do?: number, size?: number) {
        writes.push({ bytes: size ?? (data as ArrayBuffer).byteLength })
      },
    },
  } as unknown as GPUDevice

  const encoder = {
    beginComputePass(_d: GPUComputePassDescriptor) {
      let ep = ''
      let workgroups = 0
      return {
        setPipeline(p: GPUComputePipeline) { ep = (p as unknown as { _ep: string })._ep },
        setBindGroup() { /* no-op */ },
        dispatchWorkgroups(n: number) { workgroups = n },
        end() { dispatches.push({ entryPoint: ep, workgroups }) },
      } as unknown as GPUComputePassEncoder
    },
  } as unknown as GPUCommandEncoder

  return {
    device,
    dispatcher: new ComputeDispatcher({ device } as never),
    encoder,
    buffers, writes, dispatches, layoutEntries, bindGroupsCreated,
  }
}

// ── Scene helpers ──

function makeMatchScene(): Scene {
  const expr: DataExpr = {
    ast: {
      kind: 'FnCall',
      callee: { kind: 'Identifier', name: 'match' },
      args: [{ kind: 'FieldAccess', object: null, field: 'class' }],
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

// The "legacy" bind-group layout entries the renderer creates today
// for a feature-buffer variant (uniform at 0, feat-data storage at 1,
// palette texture at 2, palette sampler at 4). Compute path extends
// this with one entry per computeBindings spec.
const LEGACY_ENTRIES: readonly GPUBindGroupLayoutEntry[] = [
  { binding: 0, visibility: 3, buffer: { type: 'uniform', hasDynamicOffset: true } },
  { binding: 1, visibility: 2, buffer: { type: 'read-only-storage' } },
  { binding: 2, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
  { binding: 4, visibility: 2, sampler: { type: 'filtering' } },
]

describe('Renderer compute integration — full pipeline simulation', () => {
  it('compile → layout → registry → dispatch → bind group end-to-end', () => {
    // ── Step 1: compile with compute path enabled ──
    const cmds = emitCommands(makeMatchScene(), {
      enableComputePath: true,
      computePathBindGroup: 0,
      computePathBaseBinding: 16,
    })
    expect(cmds.shows).toHaveLength(1)
    expect(cmds.computePlan).toBeDefined()
    expect(cmds.computePlan!.length).toBe(1)
    const variant = cmds.shows[0]!.shaderVariant!
    expect(variant.computeBindings).toBeDefined()
    expect(variant.computeBindings!.length).toBe(1)
    expect(variant.computeBindings![0]!.binding).toBe(16)
    expect(variant.fillExpr).toContain('compute_out_fill')

    // ── Step 2: extend pipeline layout entries ──
    const extended = extendBindGroupLayoutEntriesForCompute(
      variant, LEGACY_ENTRIES, FRAGMENT_BIT,
    )
    // 4 legacy + 1 compute = 5 entries.
    expect(extended.length).toBe(5)
    expect(extended[4]!.binding).toBe(16)
    expect((extended[4]! as { buffer: { type: string } }).buffer.type).toBe('read-only-storage')

    // ── Step 3: registry + attach the show ──
    const { device, dispatcher, encoder, buffers, dispatches, bindGroupsCreated } = makeFakeContext()
    const registry = new ComputeLayerRegistry(dispatcher)
    const handle = registry.attach('layer-landuse', variant, cmds.computePlan, /* idx */ 0)
    expect(handle).not.toBeNull()
    expect(registry.size).toBe(1)
    // 3 GPU buffers created (feat / out / count) for the one kernel.
    expect(buffers).toHaveLength(3)

    // ── Step 4: upload feature properties ──
    const props = (fid: number) => fid === 0 ? { class: 'school' } : { class: 'hospital' }
    handle!.uploadFromProps(props, 50)

    // ── Step 5: per-frame dispatch ──
    registry.dispatchAll(encoder)
    expect(dispatches).toHaveLength(1)
    expect(dispatches[0]!.entryPoint).toBe('eval_match')
    // 50 / 64 → 1 workgroup
    expect(dispatches[0]!.workgroups).toBe(1)

    // ── Step 6: build the variant's bind-group ──
    // First create the layout (a real renderer would cache this).
    const layout = device.createBindGroupLayout({
      label: 'sim-feature-layout-extended',
      entries: extended as GPUBindGroupLayoutEntry[],
    })
    // Then build entries: legacy + compute.
    const computeEntries = handle!.getBindGroupEntries()
    expect(computeEntries).not.toBeNull()
    expect(computeEntries!.length).toBe(1)
    expect(computeEntries![0]!.binding).toBe(16)
    const legacyBindEntries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: {} as GPUBuffer, offset: 0, size: 192 } },
      { binding: 1, resource: { buffer: {} as GPUBuffer } },
      { binding: 2, resource: {} as GPUTextureView },
      { binding: 4, resource: {} as GPUSampler },
    ]
    device.createBindGroup({
      label: 'sim-feature-bg',
      layout,
      entries: [...legacyBindEntries, ...computeEntries!],
    })
    const lastBg = bindGroupsCreated.at(-1)!
    expect(lastBg.entryBindings).toEqual([0, 1, 2, 4, 16])

    // ── Step 7: cleanup ──
    expect(buffers.filter(b => !b.destroyed)).toHaveLength(3)
    registry.detach('layer-landuse')
    expect(registry.size).toBe(0)
    expect(buffers.filter(b => !b.destroyed)).toHaveLength(0)
  })

  it('legacy variant (no computeBindings) → registry is no-op + layout unchanged', () => {
    // A scene whose variants have no computeBindings — the renderer
    // calls the same wire-up code but every compute-side call
    // short-circuits. This is the production state today.
    const scene: Scene = {
      sources: [], symbols: [],
      renderNodes: [{
        name: 'plain', sourceRef: 's', zOrder: 0,
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
    const cmds = emitCommands(scene, { enableComputePath: true })
    const variant = cmds.shows[0]!.shaderVariant!
    expect(variant.computeBindings).toBeUndefined()

    // Layout extension returns the input by reference (no alloc).
    const extended = extendBindGroupLayoutEntriesForCompute(variant, LEGACY_ENTRIES, FRAGMENT_BIT)
    expect(extended).toBe(LEGACY_ENTRIES)

    // Registry attach returns null + does nothing.
    const { dispatcher, encoder, dispatches, buffers } = makeFakeContext()
    const registry = new ComputeLayerRegistry(dispatcher)
    const handle = registry.attach('layer-plain', variant, cmds.computePlan, 0)
    expect(handle).toBeNull()
    expect(buffers).toHaveLength(0)

    // dispatchAll is safe to call (no-op).
    registry.dispatchAll(encoder)
    expect(dispatches).toHaveLength(0)
  })

  it('compute-disabled emit + legacy renderer call sites → unchanged behaviour', () => {
    // The flag itself: emit WITHOUT compute path. The renderer
    // wire-up is the same code, but the variant never carries
    // computeBindings → every compute step is a no-op.
    const cmds = emitCommands(makeMatchScene())  // enableComputePath defaults to false
    const variant = cmds.shows[0]!.shaderVariant!
    expect(variant.computeBindings).toBeUndefined()

    const extended = extendBindGroupLayoutEntriesForCompute(variant, LEGACY_ENTRIES, FRAGMENT_BIT)
    expect(extended).toBe(LEGACY_ENTRIES)

    const { dispatcher } = makeFakeContext()
    const registry = new ComputeLayerRegistry(dispatcher)
    expect(registry.attach('k', variant, cmds.computePlan, 0)).toBeNull()
  })

  it('multi-show scene: each show attaches its own handle, dispatchAll fires once per show', () => {
    // Two layers, each with its own match() AST → two distinct
    // ComputeKernel objects → two handles → two dispatches per frame.
    function twoShowScene(): Scene {
      const buildExpr = (fieldName: string, arm: string, hex: string): DataExpr => ({
        ast: {
          kind: 'FnCall',
          callee: { kind: 'Identifier', name: 'match' },
          args: [{ kind: 'FieldAccess', object: null, field: fieldName }],
          matchBlock: {
            kind: 'MatchBlock',
            arms: [
              { pattern: arm, value: { kind: 'ColorLiteral', value: hex } },
              { pattern: '_',  value: { kind: 'ColorLiteral', value: '#000000' } },
            ],
          },
        },
      })
      const mkNode = (name: string, field: string, arm: string, hex: string): RenderNode => ({
        name, sourceRef: 's', zOrder: 0,
        fill: { kind: 'data-driven', expr: buildExpr(field, arm, hex) } as ColorValue,
        stroke: { color: { kind: 'none' }, width: { kind: 'constant', value: 0 } } as StrokeValue,
        opacity: { kind: 'constant', value: 1 },
        size: { kind: 'none' } as SizeValue,
        extrude: { kind: 'none' } as never,
        extrudeBase: { kind: 'none' } as never,
        projection: 'mercator', visible: true, pointerEvents: 'auto',
        filter: null, geometry: null, billboard: true,
        shape: { kind: 'named', name: 'circle' } as never,
      })
      return {
        sources: [], symbols: [],
        renderNodes: [
          mkNode('landuse', 'class', 'school', '#aaaaaa'),
          mkNode('roads',   'rank',  'major',  '#bbbbbb'),
        ],
      } as Scene
    }
    const cmds = emitCommands(twoShowScene(), {
      enableComputePath: true,
      computePathBindGroup: 0,
      computePathBaseBinding: 16,
    })
    expect(cmds.shows).toHaveLength(2)
    expect(cmds.computePlan!.length).toBe(2)

    const { dispatcher, encoder, dispatches } = makeFakeContext()
    const registry = new ComputeLayerRegistry(dispatcher)
    for (let i = 0; i < cmds.shows.length; i++) {
      const v = cmds.shows[i]!.shaderVariant!
      const handle = registry.attach(`show-${i}`, v, cmds.computePlan, i)
      handle?.uploadFromProps(() => ({ class: 'school', rank: 'major' }), 10)
    }
    expect(registry.size).toBe(2)

    registry.dispatchAll(encoder)
    expect(dispatches).toHaveLength(2)
    registry.destroyAll()
    expect(registry.size).toBe(0)
  })
})
