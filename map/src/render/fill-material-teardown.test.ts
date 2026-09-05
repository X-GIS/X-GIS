// ═══ Every fill Material an owner builds is released when the owner dies (#2325) ═══
//
// The #2266 DEV owner-leak detector reported 63 `[XGIS LEAK] Material` lines from a
// single CI render shard, all from the arms that rebuild through `__xgisRunSource`.
// #2286 gave the PipelineFactory chain a destroy but shipped no vitest witness for
// it, and left one `polygon-fill-material.ts` consumer out. This file covers both
// (the third gap, VectorTileRenderer's bake twin, is in
// `vtr-destroy-resource-release.test.ts`, next to that owner's existing suite):
//
//   - `PipelineFactory` ALIASES one Material under several pipeline keys
//     (`_fillPerStyle` holds flat under 2 keys and ground under 2), so a teardown
//     that walks the maps calls `destroy()` on the same object repeatedly. The
//     de-dupe is `Material.destroy()`'s own `_destroyed` latch (material.ts), NOT a
//     Set at the call site — this asserts the latch actually holds end-to-end, so
//     the release count equals the CREATE count with no handle released twice.
//   - `GraticuleRenderer` (the `buildGraticuleLineMaterial` product) had no teardown
//     API at all; `renderer.ts`'s destroy documented it as a known gap.
//
// Driven over a counting RHI stub through the REAL seams: the factory half runs
// `getOrCreateVariantPipelines -> registerFillMaterials -> new Material`, the same
// entry `pipeline-factory-compute-layout-authority.test.ts` drives (its `makeFactory`
// shape is reused here, with the inert `createPipeline` swapped for a counting one).
//
// Fail-before: with `dropMaterials()` removed from `destroy()` the release arm reports
// 0 of 12 pipelines. The CONTROLs below make that non-vacuous in both directions —
// nothing is released BEFORE the destroy call, and the aliasing the de-dupe exists for
// is asserted to be real rather than assumed.

import { describe, it, expect, vi } from 'vitest'
import { Material } from '@xgis/engine'
import type { RhiDevice } from '@xgis/engine'
import { PipelineFactory } from './pipeline-factory'
import { GraticuleRenderer } from './graticule-renderer'
import type { ShaderVariantInfo } from './renderer-types'

/** An RHI stub that COUNTS creates and records releases by handle identity. The only
 *  modelled facts are that every create yields a distinct handle and that a release
 *  names the handle that was made. */
function countingRhi() {
  const destroyedPipelines: unknown[] = []
  const destroyedBuffers: unknown[] = []
  let pipelines = 0
  let buffers = 0
  return {
    destroyedPipelines,
    destroyedBuffers,
    counts: () => ({ pipelines, buffers }),
    rhi: {
      backend: 'webgpu' as const,
      caps: { shaderLanguage: 'wgsl' },
      createPipeline: vi.fn(() => ({ __pipeline: ++pipelines })),
      createBindGroupLayout: vi.fn((x: unknown) => x),
      createBindGroup: vi.fn(() => ({ __bg: true })),
      createBuffer: vi.fn(() => ({ __buf: ++buffers })),
      writeBuffer: vi.fn(),
      destroyPipeline: (p: unknown) => destroyedPipelines.push(p),
      destroyBuffer: (b: unknown) => destroyedBuffers.push(b),
    },
  }
}

const BASE = { label: 'base-sentinel' } as unknown as GPUBindGroupLayout
const BASE_FEATURE = { label: 'base-feature-sentinel' } as unknown as GPUBindGroupLayout

/** A factory WITHOUT its ctor (build() needs a real device) — only the state the
 *  `getOrCreateVariantPipelines -> registerFillMaterials` path touches, exactly as
 *  `pipeline-factory-compute-layout-authority.test.ts` builds it, plus the two maps
 *  `dropMaterials()` walks. */
function makeFactory() {
  const c = countingRhi()
  const device = {
    createShaderModule: (d: { label?: string }) => ({ label: d.label }),
    createPipelineLayout: (d: GPUPipelineLayoutDescriptor) => ({
      __layouts: d.bindGroupLayouts,
    }),
    createRenderPipeline: (d: { label?: string }) => ({ label: d.label }),
  }
  const f = Object.create(PipelineFactory.prototype) as PipelineFactory
  const anyF = f as unknown as Record<string, unknown>
  anyF.ctx = { device, format: 'bgra8unorm', rhi: c.rhi }
  anyF.shaderCache = new Map()
  anyF._fillPerStyle = new Map()
  anyF._fillPerStyleExtrude = new Map()
  // #2309 — the label indexes the two setters write through. Object.create skips
  // class field initializers, so every field the factory's write path touches has
  // to be injected here by hand; a missing one surfaces as `undefined.get(...)`.
  anyF._fillPerStyleByLabel = new Map()
  anyF._fillPerStyleExtrudeByLabel = new Map()
  anyF._fillPerStyleInfo = new Map()
  // #2042 INC-4d — walked (and cleared) by dropMaterials; nothing here builds a
  // split twin, so it stays empty.
  anyF._fillPerStyleSplit = new Map()
  anyF.featureBindGroupLayout = BASE_FEATURE
  anyF.bindGroupLayout = BASE
  f.setLayoutResolver(() => BASE_FEATURE)
  return { f, anyF, ...c }
}

const variant = {
  key: 'fill-teardown-test',
  needsFeatureBuffer: true,
  featureFields: ['kind'],
} as unknown as ShaderVariantInfo

type MatEntry = { mat: Material; variant: number }
const distinctMats = (m: Map<unknown, MatEntry>): Set<Material> =>
  new Set([...m.values()].map((e) => e.mat))

describe('PipelineFactory.destroy() releases every fill Material it owns (#2325)', () => {
  it('releases each created pipeline exactly once, despite the per-style aliasing', () => {
    const { f, anyF, counts, destroyedPipelines, destroyedBuffers } = makeFactory()
    f.getOrCreateVariantPipelines(variant)

    const created = counts().pipelines
    // The twins really were built through the Material seam — 12 today (flat 2
    // variants + ground 2 + the #1252 data-driven extrude's 8). Asserted as "some",
    // not as 12: the release/create equality below is the invariant, and pinning the
    // literal would redden this gate for an unrelated variant being added.
    expect(created, 'the fill Material twins must have been built').toBeGreaterThan(0)

    // PREMISE of the de-dupe, asserted rather than assumed: the maps alias. If a
    // refactor ever made them 1:1 this test would silently stop testing de-duping.
    const perStyle = anyF._fillPerStyle as Map<unknown, MatEntry>
    const perStyleExtrude = anyF._fillPerStyleExtrude as Map<unknown, MatEntry>
    expect(perStyle.size).toBeGreaterThan(distinctMats(perStyle).size)
    expect(perStyleExtrude.size).toBeGreaterThan(distinctMats(perStyleExtrude).size)

    // CONTROL — nothing is released until destroy() runs. Without this the
    // assertion below could pass on a factory that released eagerly (or on a stub
    // that recorded creates as releases).
    expect(destroyedPipelines).toEqual([])

    f.destroy()

    expect(destroyedPipelines.length, 'every created pipeline is released').toBe(created)
    expect(
      new Set(destroyedPipelines).size,
      'no pipeline is released twice — Material.destroy() latches on _destroyed',
    ).toBe(created)
    // These twins declare no globalUniform and no pool, so the buffer arm is
    // structurally zero on both sides; asserted so a future twin that DOES take a
    // globalUniform cannot land unreleased without reddening here.
    expect(destroyedBuffers.length).toBe(counts().buffers)

    // The maps are emptied, so a second teardown (or a rebuild) cannot resurrect a
    // dead Material through them.
    expect(perStyle.size).toBe(0)
    expect(perStyleExtrude.size).toBe(0)
    expect(anyF._fillPerStyleInfo).toEqual(new Map())
  })

  it('CONTROL — a second destroy() is inert (no double release)', () => {
    const { f, counts, destroyedPipelines } = makeFactory()
    f.getOrCreateVariantPipelines(variant)
    f.destroy()
    const afterFirst = destroyedPipelines.length
    f.destroy()
    expect(destroyedPipelines.length).toBe(afterFirst)
    expect(afterFirst).toBe(counts().pipelines)
  })
})

// ── GraticuleRenderer: the last builder product with no owner teardown ───────

/** A one-variant Material with a global uniform, so both release arms (pipeline +
 *  buffer) carry a real handle. */
function makeMaterial(rhi: RhiDevice): Material {
  return new Material(rhi, {
    shader: 'stub',
    vsEntry: 'vs_main',
    fsEntry: 'fs_stroke',
    format: 'bgra8unorm',
    sampleCount: 1,
    groups: [{ __layout: true } as never],
    colorTargets: [{ format: 'bgra8unorm', blend: 'alpha' }],
    globalUniformSize: 64,
    variants: [{ label: 'graticule-line-rhi' }],
  })
}

describe('GraticuleRenderer.destroy() releases Material, ring and bucket buffers (#2325)', () => {
  function makeGraticule() {
    const c = countingRhi()
    const g = new GraticuleRenderer({
      rhi: c.rhi,
      device: {},
      format: 'bgra8unorm',
    } as never)
    const anyG = g as unknown as Record<string, unknown>
    const mat = makeMaterial(c.rhi as unknown as RhiDevice)
    const ring = { destroy: vi.fn() }
    // Two zoom buckets on each arm — the point of the Map-not-WeakMap swap is that
    // the buckets the last frame did NOT draw are reachable at teardown.
    const nativeBufs = [{ destroy: vi.fn() }, { destroy: vi.fn() }]
    const rhiBufs = [{ __rhiBuf: 1 }, { __rhiBuf: 2 }]
    const bucketed = (bufs: unknown[]): Map<object, unknown> =>
      new Map(bufs.map((buf, i): [object, unknown] => [{ bucket: i }, { buf, count: 1 }]))
    anyG._lineMatRhi = mat
    anyG._rhiRing = ring
    anyG._rhiBindGroup = { buf: rhiBufs[0], bg: {} }
    anyG.graticuleBufferCache = bucketed(nativeBufs)
    anyG.graticuleRhiBufferCache = bucketed(rhiBufs)
    anyG.graticuleBuffer = nativeBufs[0]
    anyG.graticuleRhiBuffer = rhiBufs[0]
    return { g, anyG, mat, ring, nativeBufs, rhiBufs, ...c }
  }

  it('destroys EVERY cached bucket buffer, not just the live one', () => {
    const { g, anyG, ring, nativeBufs, rhiBufs, destroyedPipelines, destroyedBuffers } =
      makeGraticule()

    // CONTROL — untouched before the teardown call.
    expect(nativeBufs.map((b) => b.destroy.mock.calls.length)).toEqual([0, 0])
    expect(destroyedPipelines).toEqual([])

    g.destroy()

    // The Material seam: its pipeline AND its global uniform are released.
    expect(destroyedPipelines.length).toBe(1)
    expect(destroyedBuffers.length).toBe(1 + rhiBufs.length)
    for (const b of rhiBufs) expect(destroyedBuffers).toContain(b)
    // Both native buckets — the second is the one a WeakMap could not have reached.
    expect(nativeBufs.map((b) => b.destroy.mock.calls.length)).toEqual([1, 1])
    expect(ring.destroy).toHaveBeenCalledTimes(1)

    // Nothing is left pointing at a dead handle, so a `_teardownForReinit` reuse
    // rebuilds lazily instead of drawing through freed GPU objects.
    expect(anyG._lineMatRhi).toBeNull()
    expect(anyG._rhiRing).toBeNull()
    expect(anyG._rhiBindGroup).toBeNull()
    expect(anyG.graticuleBuffer).toBeNull()
    expect(anyG.graticuleRhiBuffer).toBeNull()
    expect((anyG.graticuleBufferCache as Map<unknown, unknown>).size).toBe(0)
    expect((anyG.graticuleRhiBufferCache as Map<unknown, unknown>).size).toBe(0)
  })

  it('CONTROL — a second destroy() releases nothing further', () => {
    const { g, nativeBufs, destroyedBuffers } = makeGraticule()
    g.destroy()
    const after = destroyedBuffers.length
    g.destroy()
    expect(destroyedBuffers.length).toBe(after)
    expect(nativeBufs.map((b) => b.destroy.mock.calls.length)).toEqual([1, 1])
  })
})
