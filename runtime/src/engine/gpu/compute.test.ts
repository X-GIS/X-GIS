// ═══════════════════════════════════════════════════════════════════
// ComputeDispatcher.dispatchKernel — unit tests with fake GPUDevice
// ═══════════════════════════════════════════════════════════════════
//
// Asserts the wire-up of the new ComputeKernel-aware dispatch path:
//   - Pipeline is created with the kernel's entryPoint (not 'main')
//   - Pipeline cache hits on second call with the same kernel
//   - Two kernels with the SAME wgsl but DIFFERENT entryPoint share
//     no pipeline cache entry
//   - Bind group has 3 entries (input + output + count)
//   - dispatchWorkgroups is called with kernel.dispatchSize(N)
//   - featureCount === 0 → early return, no pass started
//
// No real GPUDevice — every WebGPU object is a recording sentinel.

import { describe, expect, it } from 'vitest'
import { ComputeDispatcher } from './compute'
import {
  emitMatchComputeKernel,
  type ComputeKernel,
} from '@xgis/compiler'

interface RecordedPass {
  label: string
  pipeline: unknown
  bindGroups: { index: number; group: unknown }[]
  workgroups: number
  ended: boolean
}

interface RecordedPipelineCreate {
  entryPoint: string
  moduleLabel: string
}

interface RecordedBindGroupCreate {
  label: string
  entries: GPUBindGroupEntry[]
}

function makeFakeContext() {
  const passes: RecordedPass[] = []
  const pipelineCreates: RecordedPipelineCreate[] = []
  const bindGroupCreates: RecordedBindGroupCreate[] = []

  const fakePipeline = (entryPoint: string): GPUComputePipeline => ({
    _entryPoint: entryPoint,
    getBindGroupLayout(_index: number): GPUBindGroupLayout {
      return { _layoutFor: entryPoint } as unknown as GPUBindGroupLayout
    },
  } as unknown as GPUComputePipeline)

  const device = {
    createShaderModule(desc: { code: string; label?: string }): GPUShaderModule {
      return { _label: desc.label ?? '<unlabeled>', _code: desc.code } as unknown as GPUShaderModule
    },
    createComputePipeline(desc: GPUComputePipelineDescriptor): GPUComputePipeline {
      const ep = (desc.compute as { entryPoint: string }).entryPoint
      pipelineCreates.push({
        entryPoint: ep,
        moduleLabel: (desc.compute.module as unknown as { _label: string })._label,
      })
      return fakePipeline(ep)
    },
    createBindGroup(desc: GPUBindGroupDescriptor): GPUBindGroup {
      bindGroupCreates.push({
        label: desc.label ?? '<unlabeled>',
        entries: [...(desc.entries as GPUBindGroupEntry[])],
      })
      return { _label: desc.label } as unknown as GPUBindGroup
    },
    createBuffer(_desc: GPUBufferDescriptor): GPUBuffer {
      return { _stub: true } as unknown as GPUBuffer
    },
    queue: {
      writeBuffer() { /* no-op */ },
    },
  } as unknown as GPUDevice

  const encoder = {
    beginComputePass(desc: GPUComputePassDescriptor): GPUComputePassEncoder {
      const rec: RecordedPass = {
        label: desc?.label ?? '<unlabeled>',
        pipeline: null,
        bindGroups: [],
        workgroups: 0,
        ended: false,
      }
      passes.push(rec)
      return {
        setPipeline(p: GPUComputePipeline) { rec.pipeline = p },
        setBindGroup(i: number, g: GPUBindGroup) {
          rec.bindGroups.push({ index: i, group: g })
        },
        dispatchWorkgroups(x: number) { rec.workgroups = x },
        end() { rec.ended = true },
      } as unknown as GPUComputePassEncoder
    },
  } as unknown as GPUCommandEncoder

  const ctx = { device } as { device: GPUDevice }
  return {
    dispatcher: new ComputeDispatcher(ctx as never),
    encoder,
    passes,
    pipelineCreates,
    bindGroupCreates,
    fakeBuffer: () => ({ _stub: true } as unknown as GPUBuffer),
  }
}

function makeKernel(): ComputeKernel {
  return emitMatchComputeKernel({
    fieldName: 'class',
    arms: [
      { pattern: 'a', colorHex: '#ff0000' },
      { pattern: 'b', colorHex: '#00ff00' },
    ],
    defaultColorHex: '#000000',
  })
}

describe('ComputeDispatcher.dispatchKernel', () => {
  it('creates a pipeline with the kernel.entryPoint (not "main")', () => {
    const { dispatcher, encoder, pipelineCreates, fakeBuffer } = makeFakeContext()
    const kernel = makeKernel()
    dispatcher.dispatchKernel(encoder, kernel, fakeBuffer(), fakeBuffer(), fakeBuffer(), 10)
    expect(pipelineCreates).toHaveLength(1)
    expect(pipelineCreates[0]!.entryPoint).toBe('eval_match')
  })

  it('reuses cached pipeline on second dispatch of the same kernel', () => {
    const { dispatcher, encoder, pipelineCreates, fakeBuffer } = makeFakeContext()
    const kernel = makeKernel()
    dispatcher.dispatchKernel(encoder, kernel, fakeBuffer(), fakeBuffer(), fakeBuffer(), 10)
    dispatcher.dispatchKernel(encoder, kernel, fakeBuffer(), fakeBuffer(), fakeBuffer(), 20)
    // Pipeline cache hit: createComputePipeline only fired once total.
    expect(pipelineCreates).toHaveLength(1)
  })

  it('treats same wgsl + different entryPoint as different pipelines', () => {
    // Synthesise two kernels with identical bodies but distinct
    // entry-point metadata to verify the cache key separates them.
    const k1: ComputeKernel = {
      wgsl: '@compute @workgroup_size(64) fn entry_a() {}',
      entryPoint: 'entry_a',
      featureStrideF32: 1,
      fieldOrder: [],
      dispatchSize: (n) => Math.ceil(n / 64),
    }
    const k2: ComputeKernel = {
      wgsl: '@compute @workgroup_size(64) fn entry_a() {}',
      entryPoint: 'entry_b',
      featureStrideF32: 1,
      fieldOrder: [],
      dispatchSize: (n) => Math.ceil(n / 64),
    }
    const { dispatcher, encoder, pipelineCreates, fakeBuffer } = makeFakeContext()
    dispatcher.dispatchKernel(encoder, k1, fakeBuffer(), fakeBuffer(), fakeBuffer(), 1)
    dispatcher.dispatchKernel(encoder, k2, fakeBuffer(), fakeBuffer(), fakeBuffer(), 1)
    expect(pipelineCreates).toHaveLength(2)
    expect(pipelineCreates.map(p => p.entryPoint).sort()).toEqual(['entry_a', 'entry_b'])
  })

  it('binds three resources at indices 0/1/2 (feat_data / out_color / u_count)', () => {
    const { dispatcher, encoder, bindGroupCreates, fakeBuffer } = makeFakeContext()
    const input = fakeBuffer(), output = fakeBuffer(), count = fakeBuffer()
    dispatcher.dispatchKernel(encoder, makeKernel(), input, output, count, 10)
    expect(bindGroupCreates).toHaveLength(1)
    const entries = bindGroupCreates[0]!.entries
    expect(entries).toHaveLength(3)
    expect(entries.map(e => e.binding)).toEqual([0, 1, 2])
    expect((entries[0]!.resource as GPUBufferBinding).buffer).toBe(input)
    expect((entries[1]!.resource as GPUBufferBinding).buffer).toBe(output)
    expect((entries[2]!.resource as GPUBufferBinding).buffer).toBe(count)
  })

  it('dispatchWorkgroups gets kernel.dispatchSize(featureCount), not raw count', () => {
    const { dispatcher, encoder, passes, fakeBuffer } = makeFakeContext()
    const kernel = makeKernel()
    // 200 features / workgroup_size 64 = 4 workgroups (ceil(200/64) = 4).
    dispatcher.dispatchKernel(encoder, kernel, fakeBuffer(), fakeBuffer(), fakeBuffer(), 200)
    expect(passes).toHaveLength(1)
    expect(passes[0]!.workgroups).toBe(4)
  })

  it('ends the compute pass after dispatch (no leaked encoder state)', () => {
    const { dispatcher, encoder, passes, fakeBuffer } = makeFakeContext()
    dispatcher.dispatchKernel(encoder, makeKernel(), fakeBuffer(), fakeBuffer(), fakeBuffer(), 1)
    expect(passes[0]!.ended).toBe(true)
  })

  it('featureCount === 0 → no pass started (early return)', () => {
    const { dispatcher, encoder, passes, pipelineCreates, bindGroupCreates, fakeBuffer } = makeFakeContext()
    dispatcher.dispatchKernel(encoder, makeKernel(), fakeBuffer(), fakeBuffer(), fakeBuffer(), 0)
    expect(passes).toHaveLength(0)
    expect(pipelineCreates).toHaveLength(0)
    expect(bindGroupCreates).toHaveLength(0)
  })

  it('negative featureCount also early-returns (defensive)', () => {
    const { dispatcher, encoder, passes, fakeBuffer } = makeFakeContext()
    dispatcher.dispatchKernel(encoder, makeKernel(), fakeBuffer(), fakeBuffer(), fakeBuffer(), -5)
    expect(passes).toHaveLength(0)
  })

  it('pass label includes the kernel entryPoint (debug breadcrumb)', () => {
    const { dispatcher, encoder, passes, fakeBuffer } = makeFakeContext()
    dispatcher.dispatchKernel(encoder, makeKernel(), fakeBuffer(), fakeBuffer(), fakeBuffer(), 1)
    expect(passes[0]!.label).toContain('eval_match')
  })

  it('getOrCreateKernelPipeline returns the cached instance on repeat call', () => {
    const { dispatcher } = makeFakeContext()
    const kernel = makeKernel()
    const p1 = dispatcher.getOrCreateKernelPipeline(kernel)
    const p2 = dispatcher.getOrCreateKernelPipeline(kernel)
    expect(p1).toBe(p2)
  })
})
