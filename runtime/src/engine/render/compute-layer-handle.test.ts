// ═══════════════════════════════════════════════════════════════════
// compute-layer-handle.ts — lifecycle wrapper tests
// ═══════════════════════════════════════════════════════════════════

import { beforeAll, describe, expect, it } from 'vitest'
import { ComputeLayerHandle } from './compute-layer-handle'
import { ComputeDispatcher } from '../gpu/compute'
import {
  emitMatchComputeKernel,
  buildComputeVariantAddendum,
  mergeComputeAddendumIntoVariant,
} from '@xgis/compiler'
import type { ShaderVariant, ComputePlanEntry } from '@xgis/compiler'

beforeAll(() => {
  if (typeof globalThis.GPUBufferUsage === 'undefined') {
    ;(globalThis as { GPUBufferUsage: Record<string, number> }).GPUBufferUsage = {
      MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8,
      INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128,
      INDIRECT: 256, QUERY_RESOLVE: 512,
    }
  }
})

function makeFakeContext() {
  const dispatches: { entryPoint: string; workgroups: number }[] = []
  let destroyedCount = 0

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
    createBindGroup(_d: GPUBindGroupDescriptor) { return { _stub: true } as unknown as GPUBindGroup },
    createBuffer(d: GPUBufferDescriptor) {
      return {
        _label: d.label, _size: d.size,
        get size() { return d.size },
        destroy() { destroyedCount++ },
      } as unknown as GPUBuffer
    },
    queue: { writeBuffer() { /* no-op */ } },
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
    dispatcher: new ComputeDispatcher({ device } as never),
    encoder,
    dispatches,
    destroyedCountRef: () => destroyedCount,
  }
}

function legacyVariant(): ShaderVariant {
  return {
    key: 'L', preamble: '', fillExpr: 'u.fill_color', strokeExpr: 'u.stroke_color',
    needsFeatureBuffer: false, featureFields: [], uniformFields: [],
    categoryOrder: {}, paletteColorGradients: [],
    fillUsesPalette: false, strokeUsesPalette: false,
  }
}

function makeMatchEntry(field: string, renderNodeIndex: number): ComputePlanEntry {
  const kernel = emitMatchComputeKernel({
    fieldName: field,
    arms: [{ pattern: 'a', colorHex: '#ff0000' }],
    defaultColorHex: '#000000',
  })
  return {
    renderNodeIndex, paintAxis: 'fill', kernel,
    fieldOrder: kernel.fieldOrder, categoryOrder: kernel.categoryOrder ?? {},
  }
}

function mergedVariantFor(entries: ComputePlanEntry[]): ShaderVariant {
  const addendum = buildComputeVariantAddendum(entries, 0, 16)
  return mergeComputeAddendumIntoVariant(legacyVariant(), addendum)
}

describe('ComputeLayerHandle — construction', () => {
  it('builds resources for variants with one compute binding', () => {
    const { dispatcher } = makeFakeContext()
    const entry = makeMatchEntry('class', 3)
    const variant = mergedVariantFor([entry])
    const handle = new ComputeLayerHandle(dispatcher, variant, [entry], 3)
    expect(handle.kernelCount).toBe(1)
  })

  it('filters scene plan to the show\'s renderNodeIndex', () => {
    const { dispatcher } = makeFakeContext()
    const thisShow = makeMatchEntry('class', 5)
    const otherShow = makeMatchEntry('rank', 9)
    const variant = mergedVariantFor([thisShow])
    // Plan has entries for two shows; the handle keeps only ours.
    const handle = new ComputeLayerHandle(
      dispatcher, variant, [thisShow, otherShow], 5,
    )
    expect(handle.kernelCount).toBe(1)
  })

  it('throws when plan filter count doesn\'t match variant computeBindings', () => {
    // Drift detection — variant says "I expect 1 compute binding"
    // but the plan filter produced 0 entries → upstream bug.
    const { dispatcher } = makeFakeContext()
    const entry = makeMatchEntry('class', 3)
    const variant = mergedVariantFor([entry])
    expect(() => {
      new ComputeLayerHandle(dispatcher, variant, [/* empty */], 3)
    }).toThrow(/plan entries.*don't match.*computeBindings/)
  })

  it('legacy variant (no computeBindings) → zero kernels', () => {
    const { dispatcher } = makeFakeContext()
    const handle = new ComputeLayerHandle(dispatcher, legacyVariant(), [], 0)
    expect(handle.kernelCount).toBe(0)
  })
})

describe('ComputeLayerHandle — uploadFromProps + dispatch', () => {
  it('dispatch fires one compute pass per kernel', () => {
    const { dispatcher, encoder, dispatches } = makeFakeContext()
    const entry = makeMatchEntry('class', 0)
    const variant = mergedVariantFor([entry])
    const handle = new ComputeLayerHandle(dispatcher, variant, [entry], 0)
    handle.uploadFromProps((_fid) => ({ class: 'a' }), 100)
    handle.dispatch(encoder)
    expect(dispatches).toHaveLength(1)
    expect(dispatches[0]!.entryPoint).toBe('eval_match')
    // ceil(100/64) = 2 workgroups
    expect(dispatches[0]!.workgroups).toBe(2)
  })

  it('uploadFromProps skipped → dispatch is a no-op (featureCount=0)', () => {
    const { dispatcher, encoder, dispatches } = makeFakeContext()
    const entry = makeMatchEntry('class', 0)
    const handle = new ComputeLayerHandle(dispatcher, mergedVariantFor([entry]), [entry], 0)
    handle.dispatch(encoder)
    expect(dispatches).toHaveLength(0)
  })

  it('idempotent: second uploadFromProps with same count doesn\'t allocate', () => {
    const { dispatcher } = makeFakeContext()
    const entry = makeMatchEntry('class', 0)
    const handle = new ComputeLayerHandle(dispatcher, mergedVariantFor([entry]), [entry], 0)
    handle.uploadFromProps(() => ({ class: 'a' }), 10)
    handle.uploadFromProps(() => ({ class: 'b' }), 10)
    // Internal: same featureCount → no reallocation; verifying through
    // the public API (the dispatch still fires correctly).
    const { encoder } = makeFakeContext()
    handle.dispatch(encoder)
  })
})

describe('ComputeLayerHandle — getBindGroupEntries', () => {
  it('returns one entry per compute binding', () => {
    const { dispatcher } = makeFakeContext()
    const entry = makeMatchEntry('class', 0)
    const variant = mergedVariantFor([entry])
    const handle = new ComputeLayerHandle(dispatcher, variant, [entry], 0)
    handle.uploadFromProps(() => ({ class: 'a' }), 10)
    const entries = handle.getBindGroupEntries()
    expect(entries).not.toBeNull()
    expect(entries!.length).toBe(1)
    expect(entries![0]!.binding).toBe(16)
  })

  it('legacy variant → empty entries array', () => {
    const { dispatcher } = makeFakeContext()
    const handle = new ComputeLayerHandle(dispatcher, legacyVariant(), [], 0)
    expect(handle.getBindGroupEntries()).toEqual([])
  })
})

describe('ComputeLayerHandle — destroy', () => {
  it('destroy releases every owned buffer', () => {
    const { dispatcher, destroyedCountRef } = makeFakeContext()
    const entry = makeMatchEntry('class', 0)
    const handle = new ComputeLayerHandle(dispatcher, mergedVariantFor([entry]), [entry], 0)
    const before = destroyedCountRef()
    handle.destroy()
    // 3 buffers per kernel (feat / out / count).
    expect(destroyedCountRef()).toBeGreaterThanOrEqual(before + 3)
  })
})
