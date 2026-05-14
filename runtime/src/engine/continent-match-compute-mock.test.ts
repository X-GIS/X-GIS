// ═══════════════════════════════════════════════════════════════════
// continent-match.xgis end-to-end compute path smoke (no real GPU)
// ═══════════════════════════════════════════════════════════════════
//
// Loads the actual playground xgis fixture, runs the full compiler
// pipeline with enableComputePath: true, then exercises the renderer-
// side wire-up against a fake GPU device. This is the last stop
// before flipping a real WebGPU device into the loop — every assertion
// here would also need to hold under WebGPU validation.
//
// Verifies the cross-boundary contract on a REAL fixture (not a
// synthetic Scene built in-test):
//   - emitCommands produces computePlan + variant.computeBindings
//   - the merged variant's fillExpr references the compute output buf
//   - ComputeLayerRegistry attaches a handle without throwing
//   - upload + dispatch produce the expected one compute pass
//   - bind-group entries land at the binding indices the compiler chose

import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  Lexer, Parser, lower, emitCommands,
  type ComputePlanEntry,
} from '@xgis/compiler'
import { ComputeDispatcher } from './gpu/compute'
import { ComputeLayerRegistry } from './render/compute-layer-registry'
import { extendBindGroupLayoutEntriesForCompute } from './render/compute-bind-layout'

beforeAll(() => {
  if (typeof globalThis.GPUBufferUsage === 'undefined') {
    ;(globalThis as { GPUBufferUsage: Record<string, number> }).GPUBufferUsage = {
      MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8,
      INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128,
      INDIRECT: 256, QUERY_RESOLVE: 512,
    }
  }
})

const FIXTURE_PATH = resolve(
  process.cwd(),
  'playground/src/examples/continent-match.xgis',
)

function compileFixture(enableComputePath: boolean) {
  const src = readFileSync(FIXTURE_PATH, 'utf8')
  const tokens = new Lexer(src).tokenize()
  const program = new Parser(tokens).parse()
  const scene = lower(program)
  return emitCommands(scene, {
    enablePaletteSampling: true,
    enableComputePath,
  })
}

function makeFakeContext() {
  const buffers: { label: string; size: number; destroyed: boolean }[] = []
  const dispatches: { entryPoint: string; workgroups: number }[] = []
  const bindGroupsCreated: { entryBindings: number[] }[] = []

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
      bindGroupsCreated.push({ entryBindings: entries.map(e => e.binding) })
      return { _stub: true } as unknown as GPUBindGroup
    },
    createBindGroupLayout(_d: GPUBindGroupLayoutDescriptor) {
      return { _stub: true } as unknown as GPUBindGroupLayout
    },
    createBuffer(d: GPUBufferDescriptor) {
      const rec = { label: d.label ?? '<unlabeled>', size: d.size, destroyed: false }
      buffers.push(rec)
      return {
        get size() { return rec.size },
        destroy() { rec.destroyed = true },
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
    device,
    dispatcher: new ComputeDispatcher({ device } as never),
    encoder, buffers, dispatches, bindGroupsCreated,
  }
}

describe('continent-match.xgis — compute path opt-in', () => {
  it('compiles without enableComputePath → no compute artefacts', () => {
    const cmds = compileFixture(false)
    expect(cmds.shows.length).toBeGreaterThan(0)
    // computePlan may be present (advisory) but variants must NOT carry
    // computeBindings — that's the signal that activates the GPU path.
    for (const show of cmds.shows) {
      expect(show.shaderVariant?.computeBindings).toBeUndefined()
    }
  })

  it('compiles with enableComputePath: true → variant has computeBindings', () => {
    const cmds = compileFixture(true)
    expect(cmds.shows.length).toBeGreaterThan(0)
    // The continents layer's fill is `match(.CONTINENT) { 7 arms + default }`
    // → router classifies as compute-feature → variant gets a binding.
    const continents = cmds.shows.find(s => s.layerName === 'continents')
    expect(continents).toBeDefined()
    const variant = continents!.shaderVariant!
    expect(variant.computeBindings).toBeDefined()
    expect(variant.computeBindings!.length).toBe(1)
    expect(variant.computeBindings![0]!.paintAxis).toBe('fill')
  })

  it('merged variant fillExpr reads from compute_out_fill', () => {
    const cmds = compileFixture(true)
    const continents = cmds.shows.find(s => s.layerName === 'continents')!
    const v = continents.shaderVariant!
    expect(v.preamble).toContain('compute_out_fill')
    expect(v.fillExpr).toContain('compute_out_fill')
    expect(v.fillExpr).toContain('unpack4x8unorm')
  })

  it('computePlan has the match() entry with the 7 continent + default arms', () => {
    const cmds = compileFixture(true)
    expect(cmds.computePlan).toBeDefined()
    const entry = cmds.computePlan![0]!
    expect(entry.paintAxis).toBe('fill')
    expect(entry.fieldOrder).toEqual(['CONTINENT'])
    // 7 named arms (default is the fallback, not in categoryOrder).
    expect(entry.categoryOrder['CONTINENT']).toBeDefined()
    expect(entry.categoryOrder['CONTINENT']!.length).toBe(7)
    expect(entry.categoryOrder['CONTINENT']).toContain('Africa')
    expect(entry.categoryOrder['CONTINENT']).toContain('Asia')
    expect(entry.categoryOrder['CONTINENT']).toContain('Antarctica')
  })

  it('kernel WGSL has 7 comparisons + a default branch', () => {
    const cmds = compileFixture(true)
    const kernel = cmds.computePlan![0]!.kernel
    expect(kernel.entryPoint).toBe('eval_match')
    // One `==` comparison per arm — alphabetical IDs 0..6.
    const compareCount = (kernel.wgsl.match(/v_CONTINENT == /g) ?? []).length
    expect(compareCount).toBe(7)
  })
})

describe('continent-match.xgis — renderer wire-up against fake GPU', () => {
  it('Registry attach → handle dispatches one eval_match pass per frame', () => {
    const cmds = compileFixture(true)
    const continents = cmds.shows.find(s => s.layerName === 'continents')!
    const variant = continents.shaderVariant!
    const plan: readonly ComputePlanEntry[] = cmds.computePlan!

    const { dispatcher, encoder, dispatches, buffers, bindGroupsCreated, device } = makeFakeContext()
    const registry = new ComputeLayerRegistry(dispatcher)
    const handle = registry.attach(
      continents.targetName, variant, plan, continents.renderNodeIndex ?? 0,
    )
    expect(handle).not.toBeNull()
    // 1 kernel × (feat / out / count) = 3 buffers.
    expect(buffers).toHaveLength(3)

    // Simulate per-tile property upload. continent-match's source is
    // ne_110m_countries.geojson — ~177 countries; mock as 200 features.
    handle!.uploadFromProps(
      (fid) => ({ CONTINENT: ['Africa', 'Asia', 'Europe', 'North America', 'South America', 'Oceania', 'Antarctica'][fid % 7] }),
      200,
    )

    // Per-frame dispatch.
    registry.dispatchAll(encoder)
    expect(dispatches).toHaveLength(1)
    expect(dispatches[0]!.entryPoint).toBe('eval_match')
    // 200 / 64 = 4 workgroups.
    expect(dispatches[0]!.workgroups).toBe(4)

    // Bind-group construction with extended layout.
    const LEGACY: readonly GPUBindGroupLayoutEntry[] = [
      { binding: 0, visibility: 3, buffer: { type: 'uniform', hasDynamicOffset: true } },
      { binding: 1, visibility: 2, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
      { binding: 4, visibility: 2, sampler: { type: 'filtering' } },
    ]
    const extended = extendBindGroupLayoutEntriesForCompute(variant, LEGACY, /* FRAGMENT */ 2)
    // 4 legacy + 1 compute = 5 entries; compute lands at binding 16
    // (default computePathBaseBinding).
    expect(extended.length).toBe(5)
    expect(extended[4]!.binding).toBe(16)

    const layout = device.createBindGroupLayout({
      label: 'e2e', entries: extended as GPUBindGroupLayoutEntry[],
    })
    const compEntries = handle!.getBindGroupEntries()
    expect(compEntries).not.toBeNull()
    device.createBindGroup({
      label: 'e2e-bg', layout,
      entries: [
        { binding: 0, resource: { buffer: {} as GPUBuffer, offset: 0, size: 192 } },
        { binding: 1, resource: { buffer: {} as GPUBuffer } },
        { binding: 2, resource: {} as GPUTextureView },
        { binding: 4, resource: {} as GPUSampler },
        ...compEntries!,
      ],
    })
    const finalBg = bindGroupsCreated.at(-1)!
    expect(finalBg.entryBindings).toEqual([0, 1, 2, 4, 16])

    // Cleanup.
    registry.detach(continents.targetName)
    expect(buffers.filter(b => !b.destroyed)).toHaveLength(0)
  })
})
