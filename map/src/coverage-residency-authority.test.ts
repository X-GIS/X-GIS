// ═══ Coverage residency has ONE authority: the renderer's GPU byte budget (#1453) ═══
//
// A `coverage` source's residency was tracked in two places that could disagree.
//
//  • `rawDatasets._coverage` — the CPU-side region map. `map-types.ts` calls it "the ONLY
//    authority … deliberately not paired with a separate current-handle field, which is
//    precisely the second authority that would drift from it."
//  • `CoverageRenderer.states` + its GPU byte budget, which evicts the least-recently-armed
//    region on its own (`evictOverBudget`) with no involvement from anything above it.
//
// The second one is exactly the authority that comment warns about. `evictOverBudget` →
// `clearRegion` → `onRegionDropped`, and that callback cleaned up the dropped region's arrows
// (#1419) and nothing else — so a region the GPU budget evicted stayed listed on the CPU
// side forever. `getCoverage()` kept answering with a handle for a region that had no GPU
// state, and a viewport driver that trusts the CPU map (the S-111 mosaic's `resident[]`,
// which mirrors it) would never re-push the region, because it still believed it was there.
//
// These gates pin the two maps to each other. The renderer is REAL — a stub firing the
// callback would only prove the callback runs, not that the renderer evicts silently, which
// is the half that made this invisible.

import { describe, it, expect, vi } from 'vitest'
import { coverageFromGrids, type CoverageInput } from '@xgis/data/coverage'
import { CoverageRenderer } from './render/coverage-renderer'
import {
  coverageRegions,
  onCoverageRegionDropped,
  type CoverageSourceDeps,
} from './coverage-source'
import type { RawDataset } from './map-types'

/** Enough RHI for `setCoverage` to build a region's textures + node buffer. */
function mockCtx(): { rhi: unknown; format: string } {
  const rhi = {
    backend: 'webgl2' as const,
    caps: { maxSampleCount: 1 },
    createBindGroupLayout: () => ({}),
    createPipeline: () => ({}),
    createShaderModule: () => ({}),
    createSampler: () => ({}),
    createBuffer: () => ({}),
    createBindGroup: () => ({}),
    createView: () => ({}),
    createTexture: () => ({}),
    writeTexture: () => {},
    writeBuffer: () => {},
    destroyTexture: () => {},
    destroySampler: () => {},
    destroyBuffer: () => {},
  }
  return { rhi, format: 'bgra8unorm' }
}

function handleOf(originLon: number): ReturnType<typeof coverageFromGrids> {
  const input: CoverageInput = {
    product: 's111',
    origin: [originLon, 50],
    spacing: [1, 1],
    size: [4, 4],
    vertical: { datumCode: null, sign: 'up' },
    bands: [
      {
        name: 'surfaceCurrentSpeed',
        unit: 'knots',
        kind: 'f32',
        nodata: -9999,
        values: Float32Array.from(Array.from({ length: 16 }, (_, i) => (i % 5) + 1)),
      },
    ],
  }
  return coverageFromGrids(input)
}

/** A source holding `regions`, wired to a REAL renderer whose budget fits exactly one region
 *  (`evictOverBudget` never evicts the region just armed, so a 1-byte budget makes every arm
 *  evict its predecessor — no dependence on the byte-accounting constants). */
function setup(regions: string[]): {
  renderer: CoverageRenderer
  deps: CoverageSourceDeps
  cpuRegions: () => string[]
  clearedArrows: string[]
} {
  const rawDatasets = new Map<string, RawDataset>()
  rawDatasets.set('currents', {
    _coverage: new Map(regions.map((r) => [r, { handle: handleOf(10) }])),
  })
  const clearedArrows: string[] = []
  const renderer = new CoverageRenderer(
    mockCtx() as unknown as ConstructorParameters<typeof CoverageRenderer>[0],
    { budgetBytes: 1 },
  )
  const deps: CoverageSourceDeps = {
    rawDatasets,
    renderer: () => renderer,
    time: { nextEpoch: () => 1, isCurrent: () => true } as unknown as CoverageSourceDeps['time'],
    fieldArmed: () => false,
    armFields: () => {},
    // No show claims the source here (#1449's contract): these gates arm the renderer
    // directly, so nothing should route through the show-derived drape.
    armFromShow: () => false,
    clearArrows: (r) => void clearedArrows.push(r),
    invalidate: vi.fn(),
    refresh: { stopAll: () => {} } as unknown as CoverageSourceDeps['refresh'],
    guardedFetch: () => fetch,
    destroyed: () => false,
    // No catalogue here: these gates are about the GPU budget's authority over residency,
    // whatever put the regions there. The catalogue driver has its own suite.
    catalogues: new Map(),
    view: () => null,
    watchViewport: () => {},
  }
  // The production wiring, verbatim — map.ts assigns exactly this closure.
  renderer.onRegionDropped = (r) => onCoverageRegionDropped(deps, r)
  return {
    renderer,
    deps,
    cpuRegions: () => [...(coverageRegions(deps, 'currents') ?? new Map()).keys()],
    clearedArrows,
  }
}

const RAMP = { ramp: 's111-speed' }

describe('coverage residency: the CPU region map follows the GPU budget (#1453)', () => {
  it('THE DIVERGENCE: a region the GPU budget evicts is dropped from the CPU map too', () => {
    const { renderer, cpuRegions } = setup(['cbofs', 'dbofs'])

    renderer.setCoverage(handleOf(10), RAMP, 'cbofs')
    expect(renderer.residentRegions()).toEqual(['cbofs'])

    // Arming the neighbour pushes the budget over, so the renderer silently evicts cbofs.
    renderer.setCoverage(handleOf(20), RAMP, 'dbofs')
    expect(renderer.residentRegions(), 'the renderer evicted cbofs on its own').toEqual(['dbofs'])

    // …and that eviction must reach the CPU map. Before #1453 it did not: cbofs stayed
    // listed here forever, so `getCoverage` answered for a region with no GPU state and a
    // viewport driver reading this map would never re-push it.
    expect(cpuRegions()).toEqual(['dbofs'])
  })

  it('the two maps agree at every step of a pan, never only at the end', () => {
    // Write-then-arm per region, which is `pushCoverageRegion`'s order — the CPU entry exists
    // before the arm that may evict a neighbour, so any drift shows up on the step it happens.
    const { renderer, deps, cpuRegions } = setup([])
    for (const [key, lon] of [
      ['a', 10],
      ['b', 20],
      ['c', 30],
    ] as const) {
      const cur = coverageRegions(deps, 'currents')!
      deps.rawDatasets.set('currents', {
        _coverage: new Map([...cur, [key, { handle: handleOf(lon) }]]),
      })
      renderer.setCoverage(handleOf(lon), RAMP, key)
      expect(cpuRegions(), `after arming ${key}`).toEqual(renderer.residentRegions())
    }
  })

  it('a drop still takes the region ARROWS with it (#1419 must not regress)', () => {
    const { renderer, clearedArrows } = setup(['cbofs', 'dbofs'])
    renderer.setCoverage(handleOf(10), RAMP, 'cbofs')
    renderer.setCoverage(handleOf(20), RAMP, 'dbofs')
    expect(clearedArrows).toEqual(['cbofs'])
  })

  it('a dropped region unknown to any coverage source is a no-op, not a throw', () => {
    const { deps, cpuRegions } = setup(['cbofs'])
    expect(() => onCoverageRegionDropped(deps, 'sfbofs')).not.toThrow()
    expect(cpuRegions()).toEqual(['cbofs'])
  })
})
