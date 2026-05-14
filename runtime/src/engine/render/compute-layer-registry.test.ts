// ═══════════════════════════════════════════════════════════════════
// compute-layer-registry.ts — aggregator lifecycle tests
// ═══════════════════════════════════════════════════════════════════

import { beforeAll, describe, expect, it } from 'vitest'
import { ComputeLayerRegistry } from './compute-layer-registry'
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

describe('ComputeLayerRegistry — attach', () => {
  it('legacy variant (no computeBindings) → returns null, no handle created', () => {
    const { dispatcher } = makeFakeContext()
    const reg = new ComputeLayerRegistry(dispatcher)
    const handle = reg.attach('layer-a', legacyVariant(), [], 0)
    expect(handle).toBeNull()
    expect(reg.size).toBe(0)
  })

  it('variant with computeBindings + plan → creates handle, increments size', () => {
    const { dispatcher } = makeFakeContext()
    const reg = new ComputeLayerRegistry(dispatcher)
    const entry = makeMatchEntry('class', 0)
    const variant = mergedVariantFor([entry])
    const handle = reg.attach('layer-a', variant, [entry], 0)
    expect(handle).not.toBeNull()
    expect(reg.size).toBe(1)
    expect(handle!.kernelCount).toBe(1)
  })

  it('idempotent — same key returns existing handle', () => {
    const { dispatcher } = makeFakeContext()
    const reg = new ComputeLayerRegistry(dispatcher)
    const entry = makeMatchEntry('class', 0)
    const variant = mergedVariantFor([entry])
    const first = reg.attach('layer-a', variant, [entry], 0)
    const second = reg.attach('layer-a', variant, [entry], 0)
    expect(second).toBe(first)
    expect(reg.size).toBe(1)
  })

  it('two distinct keys → two distinct handles', () => {
    const { dispatcher } = makeFakeContext()
    const reg = new ComputeLayerRegistry(dispatcher)
    const e1 = makeMatchEntry('class', 0)
    const e2 = makeMatchEntry('rank', 1)
    reg.attach('layer-a', mergedVariantFor([e1]), [e1], 0)
    reg.attach('layer-b', mergedVariantFor([e2]), [e2], 1)
    expect(reg.size).toBe(2)
    expect(reg.keys()).toEqual(['layer-a', 'layer-b'])
  })

  it('empty computeBindings array → null (treated same as legacy)', () => {
    const { dispatcher } = makeFakeContext()
    const reg = new ComputeLayerRegistry(dispatcher)
    const v: ShaderVariant = { ...legacyVariant(), computeBindings: [] }
    const handle = reg.attach('layer-a', v, [], 0)
    expect(handle).toBeNull()
    expect(reg.size).toBe(0)
  })

  it('drift between plan + computeBindings → propagates throw', () => {
    const { dispatcher } = makeFakeContext()
    const reg = new ComputeLayerRegistry(dispatcher)
    const entry = makeMatchEntry('class', 0)
    const variant = mergedVariantFor([entry])
    // Plan empty but variant says one binding — must throw.
    expect(() => reg.attach('layer-a', variant, [], 0)).toThrow(
      /plan entries.*don't match.*computeBindings/,
    )
    // Registry left unchanged.
    expect(reg.size).toBe(0)
  })
})

describe('ComputeLayerRegistry — getHandle', () => {
  it('returns the handle for a known key', () => {
    const { dispatcher } = makeFakeContext()
    const reg = new ComputeLayerRegistry(dispatcher)
    const entry = makeMatchEntry('class', 0)
    const handle = reg.attach('layer-a', mergedVariantFor([entry]), [entry], 0)
    expect(reg.getHandle('layer-a')).toBe(handle)
  })

  it('returns null for an unknown key', () => {
    const { dispatcher } = makeFakeContext()
    const reg = new ComputeLayerRegistry(dispatcher)
    expect(reg.getHandle('nope')).toBeNull()
  })
})

describe('ComputeLayerRegistry — dispatchAll', () => {
  it('empty registry → no-op', () => {
    const { dispatcher, encoder, dispatches } = makeFakeContext()
    const reg = new ComputeLayerRegistry(dispatcher)
    reg.dispatchAll(encoder)
    expect(dispatches).toHaveLength(0)
  })

  it('one attached handle → one dispatch per kernel', () => {
    const { dispatcher, encoder, dispatches } = makeFakeContext()
    const reg = new ComputeLayerRegistry(dispatcher)
    const entry = makeMatchEntry('class', 0)
    const handle = reg.attach('layer-a', mergedVariantFor([entry]), [entry], 0)
    handle!.uploadFromProps(() => ({ class: 'a' }), 100)
    reg.dispatchAll(encoder)
    expect(dispatches).toHaveLength(1)
    expect(dispatches[0]!.entryPoint).toBe('eval_match')
  })

  it('two attached handles → fires both', () => {
    const { dispatcher, encoder, dispatches } = makeFakeContext()
    const reg = new ComputeLayerRegistry(dispatcher)
    const e1 = makeMatchEntry('class', 0)
    const e2 = makeMatchEntry('rank', 1)
    const h1 = reg.attach('layer-a', mergedVariantFor([e1]), [e1], 0)
    const h2 = reg.attach('layer-b', mergedVariantFor([e2]), [e2], 1)
    h1!.uploadFromProps(() => ({ class: 'a' }), 10)
    h2!.uploadFromProps(() => ({ rank: 1 }), 10)
    reg.dispatchAll(encoder)
    expect(dispatches).toHaveLength(2)
  })

  it('handle without uploadFromProps (featureCount=0) → skipped, others fire', () => {
    const { dispatcher, encoder, dispatches } = makeFakeContext()
    const reg = new ComputeLayerRegistry(dispatcher)
    const e1 = makeMatchEntry('class', 0)
    const e2 = makeMatchEntry('rank', 1)
    reg.attach('layer-a', mergedVariantFor([e1]), [e1], 0)
    const h2 = reg.attach('layer-b', mergedVariantFor([e2]), [e2], 1)
    h2!.uploadFromProps(() => ({ rank: 1 }), 10)
    reg.dispatchAll(encoder)
    expect(dispatches).toHaveLength(1) // only the uploaded one fires
  })
})

describe('ComputeLayerRegistry — detach', () => {
  it('detach existing key → true + handle destroyed + size shrinks', () => {
    const { dispatcher, destroyedCountRef } = makeFakeContext()
    const reg = new ComputeLayerRegistry(dispatcher)
    const entry = makeMatchEntry('class', 0)
    reg.attach('layer-a', mergedVariantFor([entry]), [entry], 0)
    const beforeDestroy = destroyedCountRef()
    const removed = reg.detach('layer-a')
    expect(removed).toBe(true)
    expect(reg.size).toBe(0)
    // 3 buffers (feat/out/count) freed.
    expect(destroyedCountRef()).toBeGreaterThanOrEqual(beforeDestroy + 3)
  })

  it('detach unknown key → false, no-op', () => {
    const { dispatcher } = makeFakeContext()
    const reg = new ComputeLayerRegistry(dispatcher)
    expect(reg.detach('nope')).toBe(false)
  })
})

describe('ComputeLayerRegistry — destroyAll', () => {
  it('frees every handle + clears the map', () => {
    const { dispatcher, destroyedCountRef } = makeFakeContext()
    const reg = new ComputeLayerRegistry(dispatcher)
    const e1 = makeMatchEntry('class', 0)
    const e2 = makeMatchEntry('rank', 1)
    reg.attach('layer-a', mergedVariantFor([e1]), [e1], 0)
    reg.attach('layer-b', mergedVariantFor([e2]), [e2], 1)
    const beforeDestroy = destroyedCountRef()
    reg.destroyAll()
    expect(reg.size).toBe(0)
    // 2 layers × 3 buffers = 6 destroy() calls.
    expect(destroyedCountRef()).toBeGreaterThanOrEqual(beforeDestroy + 6)
  })

  it('empty registry → no-op', () => {
    const { dispatcher } = makeFakeContext()
    const reg = new ComputeLayerRegistry(dispatcher)
    expect(() => reg.destroyAll()).not.toThrow()
  })
})
