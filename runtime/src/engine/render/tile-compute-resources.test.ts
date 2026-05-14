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
