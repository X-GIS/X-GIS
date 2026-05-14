// ═══════════════════════════════════════════════════════════════════
// tile-compute-resources.ts — tests with fake GPUDevice
// ═══════════════════════════════════════════════════════════════════

import { beforeAll, describe, expect, it } from 'vitest'
import { TileComputeResources } from './tile-compute-resources'
import { ComputeDispatcher } from '../gpu/compute'
import {
  emitMatchComputeKernel,
  emitTernaryComputeKernel,
  type ComputePlanEntry,
} from '@xgis/compiler'

beforeAll(() => {
  if (typeof globalThis.GPUBufferUsage === 'undefined') {
    ;(globalThis as { GPUBufferUsage: Record<string, number> }).GPUBufferUsage = {
      MAP_READ:      0x0001,
      MAP_WRITE:     0x0002,
      COPY_SRC:      0x0004,
      COPY_DST:      0x0008,
      INDEX:         0x0010,
      VERTEX:        0x0020,
      UNIFORM:       0x0040,
      STORAGE:       0x0080,
      INDIRECT:      0x0100,
      QUERY_RESOLVE: 0x0200,
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
  const dispatches: { entryPoint: string; workgroups: number }[] = []

  const device = {
    createShaderModule(desc: { code: string; label?: string }): GPUShaderModule {
      return { _label: desc.label ?? '<unlabeled>' } as unknown as GPUShaderModule
    },
    createComputePipeline(desc: GPUComputePipelineDescriptor): GPUComputePipeline {
      const ep = (desc.compute as { entryPoint: string }).entryPoint
      return {
        _entryPoint: ep,
        getBindGroupLayout(): GPUBindGroupLayout {
          return { _l: ep } as unknown as GPUBindGroupLayout
        },
      } as unknown as GPUComputePipeline
    },
    createBindGroup(_desc: GPUBindGroupDescriptor): GPUBindGroup {
      return { _stub: true } as unknown as GPUBindGroup
    },
    createBuffer(desc: GPUBufferDescriptor): GPUBuffer {
      const rec: BufferRecord = {
        size: desc.size,
        label: desc.label ?? '<unlabeled>',
        destroyed: false,
      }
      buffers.push(rec)
      return {
        _rec: rec,
        get size() { return rec.size },
        destroy() { rec.destroyed = true },
      } as unknown as GPUBuffer
    },
    queue: {
      writeBuffer(
        _buffer: GPUBuffer,
        offset: number,
        _data: BufferSource,
        _dataOffset?: number,
        size?: number,
      ) {
        writes.push({
          offset,
          bytes: size ?? (_data as ArrayBuffer).byteLength,
        })
      },
    },
  } as unknown as GPUDevice

  const encoder = {
    beginComputePass(_desc: GPUComputePassDescriptor): GPUComputePassEncoder {
      let pipe: { _entryPoint: string } | null = null
      let dispatched = 0
      return {
        setPipeline(p: GPUComputePipeline) { pipe = p as unknown as { _entryPoint: string } },
        setBindGroup() { /* no-op */ },
        dispatchWorkgroups(x: number) { dispatched = x },
        end() {
          if (pipe) dispatches.push({ entryPoint: pipe._entryPoint, workgroups: dispatched })
        },
      } as unknown as GPUComputePassEncoder
    },
  } as unknown as GPUCommandEncoder

  const ctx = { device } as { device: GPUDevice }
  return {
    dispatcher: new ComputeDispatcher(ctx as never),
    encoder,
    buffers,
    writes,
    dispatches,
  }
}

function makeMatchPlanEntry(field: string, renderNodeIndex = 0): ComputePlanEntry {
  const kernel = emitMatchComputeKernel({
    fieldName: field,
    arms: [
      { pattern: 'a', colorHex: '#ff0000' },
      { pattern: 'b', colorHex: '#00ff00' },
    ],
    defaultColorHex: '#000000',
  })
  return {
    renderNodeIndex,
    paintAxis: 'fill',
    kernel,
    fieldOrder: kernel.fieldOrder,
    categoryOrder: kernel.categoryOrder ?? {},
  }
}

function makeTernaryPlanEntry(field: string, renderNodeIndex = 0): ComputePlanEntry {
  const kernel = emitTernaryComputeKernel({
    fields: [field],
    branches: [{ pred: `v_${field} != 0.0`, colorHex: '#ff0000' }],
    defaultColorHex: '#000000',
  })
  return {
    renderNodeIndex,
    paintAxis: 'stroke-color',
    kernel,
    fieldOrder: kernel.fieldOrder,
    categoryOrder: kernel.categoryOrder ?? {},
  }
}

describe('TileComputeResources — construction', () => {
  it('empty plan → no buffers allocated', () => {
    const { dispatcher, buffers } = makeFakeContext()
    new TileComputeResources(dispatcher, [])
    expect(buffers).toHaveLength(0)
  })

  it('one match entry → 3 buffers (feat / out / count)', () => {
    const { dispatcher, buffers } = makeFakeContext()
    new TileComputeResources(dispatcher, [makeMatchPlanEntry('class')])
    expect(buffers).toHaveLength(3)
    expect(buffers.map(b => b.label).sort()).toEqual([
      'tile-count:eval_match',
      'tile-feat:eval_match',
      'tile-out:eval_match',
    ])
  })

  it('multiple entries → 3 buffers per entry, labelled by entryPoint', () => {
    const { dispatcher, buffers } = makeFakeContext()
    new TileComputeResources(dispatcher, [
      makeMatchPlanEntry('class'),
      makeTernaryPlanEntry('flag'),
    ])
    expect(buffers).toHaveLength(6)
    const labels = buffers.map(b => b.label).sort()
    expect(labels).toContain('tile-feat:eval_match')
    expect(labels).toContain('tile-feat:eval_case')
  })

  it('entryCount reflects plan length', () => {
    const { dispatcher } = makeFakeContext()
    const r = new TileComputeResources(dispatcher, [
      makeMatchPlanEntry('class'),
      makeTernaryPlanEntry('flag'),
    ])
    expect(r.entryCount).toBe(2)
  })
})

describe('TileComputeResources — getOutBuffer', () => {
  it('returns the matching entry by (renderNodeIndex, paintAxis)', () => {
    const { dispatcher } = makeFakeContext()
    const r = new TileComputeResources(dispatcher, [
      makeMatchPlanEntry('class', 0),       // (0, fill)
      makeTernaryPlanEntry('flag', 1),      // (1, stroke-color)
    ])
    const fill = r.getOutBuffer(0, 'fill')
    const stroke = r.getOutBuffer(1, 'stroke-color')
    expect(fill).not.toBeNull()
    expect(stroke).not.toBeNull()
    expect(fill).not.toBe(stroke)
  })

  it('returns null when no entry matches the coordinate', () => {
    const { dispatcher } = makeFakeContext()
    const r = new TileComputeResources(dispatcher, [makeMatchPlanEntry('class', 0)])
    expect(r.getOutBuffer(5, 'fill')).toBeNull()
    expect(r.getOutBuffer(0, 'stroke-color')).toBeNull()
  })
})

describe('TileComputeResources — uploadFromProps', () => {
  it('packs + uploads feature data per entry', () => {
    const { dispatcher, writes } = makeFakeContext()
    const r = new TileComputeResources(dispatcher, [makeMatchPlanEntry('class')])
    const props = (fid: number) => fid === 0 ? { class: 'a' } : { class: 'b' }
    r.uploadFromProps(props, 2)
    // Two writes per entry: feat data + count.
    expect(writes).toHaveLength(2)
  })

  it('reallocates feat / out buffers when feature count exceeds capacity', () => {
    const { dispatcher, buffers } = makeFakeContext()
    const r = new TileComputeResources(dispatcher, [makeMatchPlanEntry('class')])
    const init = buffers.length
    r.uploadFromProps(() => ({ class: 'a' }), 100)
    // Reallocation: 2 buffers destroyed + 2 created (feat + out).
    // Count buffer reused.
    expect(buffers.length).toBeGreaterThan(init)
    const destroyed = buffers.filter(b => b.destroyed).length
    expect(destroyed).toBeGreaterThanOrEqual(2)
  })

  it('writeCount fires per entry', () => {
    const { dispatcher, writes } = makeFakeContext()
    const r = new TileComputeResources(dispatcher, [
      makeMatchPlanEntry('class'),
      makeTernaryPlanEntry('flag'),
    ])
    // Use 10 features so feat-data writes (10*1*4=40 bytes per entry)
    // are distinguishable from count writes (always 4 bytes).
    r.uploadFromProps(() => ({ class: 'a', flag: 1 }), 10)
    // 2 entries × (1 feat-data write + 1 count write) = 4 writes.
    expect(writes).toHaveLength(4)
    const countWrites = writes.filter(w => w.bytes === 4)
    expect(countWrites).toHaveLength(2)
  })

  it('idempotent with same feature count (no extra alloc)', () => {
    const { dispatcher, buffers } = makeFakeContext()
    const r = new TileComputeResources(dispatcher, [makeMatchPlanEntry('class')])
    r.uploadFromProps(() => ({ class: 'a' }), 10)
    const afterFirst = buffers.length
    r.uploadFromProps(() => ({ class: 'a' }), 10)
    // No additional allocations — buffers are reused.
    expect(buffers.length).toBe(afterFirst)
  })
})

describe('TileComputeResources — dispatch', () => {
  it('dispatches one compute pass per plan entry', () => {
    const { dispatcher, dispatches, encoder } = makeFakeContext()
    const r = new TileComputeResources(dispatcher, [
      makeMatchPlanEntry('class'),
      makeTernaryPlanEntry('flag'),
    ])
    r.uploadFromProps(() => ({ class: 'a', flag: 1 }), 5)
    r.dispatch(encoder)
    expect(dispatches).toHaveLength(2)
    expect(dispatches.map(d => d.entryPoint).sort()).toEqual(['eval_case', 'eval_match'])
  })

  it('dispatchWorkgroups uses kernel.dispatchSize(featureCount)', () => {
    const { dispatcher, dispatches, encoder } = makeFakeContext()
    const r = new TileComputeResources(dispatcher, [makeMatchPlanEntry('class')])
    r.uploadFromProps(() => ({ class: 'a' }), 200)
    r.dispatch(encoder)
    // 200 / 64 = ceil(3.125) = 4 workgroups.
    expect(dispatches[0]!.workgroups).toBe(4)
  })

  it('skips entries with featureCount=0 (no dispatch fired)', () => {
    const { dispatcher, dispatches, encoder } = makeFakeContext()
    const r = new TileComputeResources(dispatcher, [makeMatchPlanEntry('class')])
    // Skip uploadFromProps → featureCount stays at 0.
    r.dispatch(encoder)
    expect(dispatches).toHaveLength(0)
  })
})

describe('TileComputeResources — forEachOutput / destroy', () => {
  it('forEachOutput walks every (kernel, outBuffer, renderNodeIndex, paintAxis)', () => {
    const { dispatcher } = makeFakeContext()
    const r = new TileComputeResources(dispatcher, [
      makeMatchPlanEntry('class', 7),
      makeTernaryPlanEntry('flag', 11),
    ])
    const seen: { index: number; axis: string; entry: string }[] = []
    r.forEachOutput((kernel, _out, idx, axis) => {
      seen.push({ index: idx, axis, entry: kernel.entryPoint })
    })
    expect(seen).toEqual([
      { index: 7,  axis: 'fill',          entry: 'eval_match' },
      { index: 11, axis: 'stroke-color',  entry: 'eval_case' },
    ])
  })

  it('destroy releases every buffer and clears entries', () => {
    const { dispatcher, buffers } = makeFakeContext()
    const r = new TileComputeResources(dispatcher, [
      makeMatchPlanEntry('class'),
      makeTernaryPlanEntry('flag'),
    ])
    r.destroy()
    expect(buffers.filter(b => !b.destroyed)).toHaveLength(0)
    expect(r.entryCount).toBe(0)
  })

  it('dispatch after destroy is a no-op (entries cleared)', () => {
    const { dispatcher, dispatches, encoder } = makeFakeContext()
    const r = new TileComputeResources(dispatcher, [makeMatchPlanEntry('class')])
    r.destroy()
    r.dispatch(encoder)
    expect(dispatches).toHaveLength(0)
  })
})

describe('TileComputeResources — kernel dedup (P4-6 runtime half)', () => {
  // Helper: build two entries that REFERENCE the same ComputeKernel
  // object (simulating compute-plan's dedup output for fill + stroke
  // axes that emit identical WGSL). The kernel object is shared by
  // reference — that's the dedup signal the runtime keys on.
  function makeSharedKernelEntries(): ComputePlanEntry[] {
    const kernel = emitMatchComputeKernel({
      fieldName: 'class',
      arms: [{ pattern: 'a', colorHex: '#ff0000' }],
      defaultColorHex: '#000000',
    })
    return [
      {
        renderNodeIndex: 0, paintAxis: 'fill', kernel,
        fieldOrder: kernel.fieldOrder, categoryOrder: kernel.categoryOrder ?? {},
      },
      {
        renderNodeIndex: 0, paintAxis: 'stroke-color', kernel, // SAME kernel reference
        fieldOrder: kernel.fieldOrder, categoryOrder: kernel.categoryOrder ?? {},
      },
    ]
  }

  it('two entries with shared kernel → 3 buffers allocated (not 6)', () => {
    const { dispatcher, buffers } = makeFakeContext()
    new TileComputeResources(dispatcher, makeSharedKernelEntries())
    // Dedup: 1 unique kernel × 3 buffers = 3 (was 6 pre-dedup).
    expect(buffers).toHaveLength(3)
  })

  it('uniqueKernelCount reflects ref-equal kernels, not plan length', () => {
    const { dispatcher } = makeFakeContext()
    const r = new TileComputeResources(dispatcher, makeSharedKernelEntries())
    expect(r.entryCount).toBe(2)
    expect(r.uniqueKernelCount).toBe(1)
  })

  it('getOutBuffer for both axes returns the SAME shared buffer', () => {
    const { dispatcher } = makeFakeContext()
    const r = new TileComputeResources(dispatcher, makeSharedKernelEntries())
    const fillOut = r.getOutBuffer(0, 'fill')
    const strokeOut = r.getOutBuffer(0, 'stroke-color')
    expect(fillOut).not.toBeNull()
    expect(strokeOut).not.toBeNull()
    expect(fillOut).toBe(strokeOut) // reference equality
  })

  it('dispatch fires ONCE per unique kernel, not per entry', () => {
    const { dispatcher, dispatches, encoder } = makeFakeContext()
    const r = new TileComputeResources(dispatcher, makeSharedKernelEntries())
    r.uploadFromProps(() => ({ class: 'a' }), 10)
    r.dispatch(encoder)
    expect(dispatches).toHaveLength(1) // not 2
  })

  it('uploadFromProps packs ONCE per unique kernel, not per entry', () => {
    const { dispatcher, writes } = makeFakeContext()
    const r = new TileComputeResources(dispatcher, makeSharedKernelEntries())
    r.uploadFromProps(() => ({ class: 'a' }), 10)
    // 1 unique kernel × (1 feat write + 1 count write) = 2 writes
    // (was 4 pre-dedup).
    expect(writes).toHaveLength(2)
  })

  it('forEachOutput still walks every binding — same outBuffer reported twice', () => {
    const { dispatcher } = makeFakeContext()
    const r = new TileComputeResources(dispatcher, makeSharedKernelEntries())
    const seen: { axis: string; buf: GPUBuffer }[] = []
    r.forEachOutput((_k, out, _i, axis) => { seen.push({ axis, buf: out }) })
    expect(seen).toHaveLength(2)
    expect(seen[0]!.buf).toBe(seen[1]!.buf) // same shared buffer
  })

  it('destroy fires once per unique kernel (not per entry)', () => {
    const { dispatcher, buffers } = makeFakeContext()
    const r = new TileComputeResources(dispatcher, makeSharedKernelEntries())
    r.destroy()
    // 3 buffers from one kernel, all destroyed.
    expect(buffers).toHaveLength(3)
    expect(buffers.every(b => b.destroyed)).toBe(true)
  })

  it('three entries with shared kernel + one distinct → 6 buffers total', () => {
    const { dispatcher, buffers } = makeFakeContext()
    const sharedKernel = emitMatchComputeKernel({
      fieldName: 'class',
      arms: [{ pattern: 'a', colorHex: '#ff0000' }],
      defaultColorHex: '#000000',
    })
    const distinctKernel = emitTernaryComputeKernel({
      fields: ['flag'],
      branches: [{ pred: 'v_flag != 0.0', colorHex: '#00ff00' }],
      defaultColorHex: '#000000',
    })
    new TileComputeResources(dispatcher, [
      { renderNodeIndex: 0, paintAxis: 'fill', kernel: sharedKernel,
        fieldOrder: sharedKernel.fieldOrder, categoryOrder: sharedKernel.categoryOrder ?? {} },
      { renderNodeIndex: 0, paintAxis: 'stroke-color', kernel: sharedKernel,
        fieldOrder: sharedKernel.fieldOrder, categoryOrder: sharedKernel.categoryOrder ?? {} },
      { renderNodeIndex: 1, paintAxis: 'fill', kernel: sharedKernel,
        fieldOrder: sharedKernel.fieldOrder, categoryOrder: sharedKernel.categoryOrder ?? {} },
      { renderNodeIndex: 2, paintAxis: 'fill', kernel: distinctKernel,
        fieldOrder: distinctKernel.fieldOrder, categoryOrder: distinctKernel.categoryOrder ?? {} },
    ])
    // 2 unique kernels × 3 buffers = 6 (was 12 pre-dedup).
    expect(buffers).toHaveLength(6)
  })
})
