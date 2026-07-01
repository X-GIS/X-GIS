import { describe, expect, it } from 'vitest'
import { XGISMap } from './map'

// CPU regression guard: after setQuality({picking: true}) (or any
// rebuildForQuality-triggering quality change), every vectorTileShows
// entry MUST satisfy
//
//    (entry.pipelines === null) ↔ (entry.layout === null)
//
// i.e. both null OR both non-null. The fixture_picking BGL bug
// (commit 6080a2f) was exactly this invariant getting violated: the
// old setQuality just nulled `entry.pipelines` and left `entry.layout`
// at the stale feature/compute reference, so the bucket-scheduler
// served `defaults.fillPipeline` (base-only) with `entry.layout`
// (feature) every frame and the data-driven match() polygons stopped
// painting. The re-resolve loop is extracted as
// `_reResolveVariantPipelines` so this test can hit it directly with
// a stub renderer — no GPU device, no e2e harness.

function mockCanvas(): HTMLCanvasElement {
  return { width: 1200, height: 800 } as unknown as HTMLCanvasElement
}

interface StubVariantPipelines { fillPipeline: object; linePipeline: object; fillPipelineNoPick: object }
interface StubRenderer {
  getOrCreateVariantPipelines(variant: unknown): StubVariantPipelines
  getOrBuildVariantLayout(variant: unknown): object
}

interface MapInternals {
  vectorTileShows: Array<{
    sourceName: string
    show: { shaderVariant?: unknown }
    pipelines: unknown | null
    layout: unknown | null
  }>
  renderer: StubRenderer
  _reResolveVariantPipelines(): void
}

function mountStubRenderer(map: XGISMap, onCall: (kind: 'pipelines' | 'layout', v: unknown) => void): {
  baseLayout: object; featureLayout: object
} {
  const baseLayout = { __label: 'base' }
  const featureLayout = { __label: 'feature' }
  const pipelines: StubVariantPipelines = {
    fillPipeline: { __label: 'fillPipeline-feature' },
    linePipeline: { __label: 'linePipeline-feature' },
    fillPipelineNoPick: { __label: 'fillPipelineNoPick-feature' },
  }
  ;(map as unknown as MapInternals).renderer = {
    getOrCreateVariantPipelines: (v: unknown) => { onCall('pipelines', v); return pipelines },
    getOrBuildVariantLayout: (v: unknown) => { onCall('layout', v); return featureLayout },
  }
  return { baseLayout, featureLayout }
}

describe('XGISMap._reResolveVariantPipelines invariant', () => {
  it('a variant-bearing show ends up with BOTH pipelines AND layout set', () => {
    const map = new XGISMap(mockCanvas())
    const calls: Array<{ kind: string; v: unknown }> = []
    mountStubRenderer(map, (kind, v) => calls.push({ kind, v }))
    const variant = { key: 'k', preamble: 'foo', needsFeatureBuffer: false }
    const internals = map as unknown as MapInternals
    internals.vectorTileShows = [
      { sourceName: 'a', show: { shaderVariant: variant }, pipelines: null, layout: null },
    ]
    internals._reResolveVariantPipelines()
    const e = internals.vectorTileShows[0]!
    expect(e.pipelines).not.toBeNull()
    expect(e.layout).not.toBeNull()
    // Both calls fired for the same variant.
    expect(calls).toHaveLength(2)
    expect(calls[0]!.v).toBe(variant)
    expect(calls[1]!.v).toBe(variant)
  })

  it('a no-variant show ends up with BOTH pipelines AND layout null', () => {
    const map = new XGISMap(mockCanvas())
    mountStubRenderer(map, () => {})
    const internals = map as unknown as MapInternals
    internals.vectorTileShows = [
      { sourceName: 'a', show: { shaderVariant: undefined }, pipelines: { stale: true }, layout: { stale: true } },
    ]
    internals._reResolveVariantPipelines()
    const e = internals.vectorTileShows[0]!
    expect(e.pipelines).toBeNull()
    expect(e.layout).toBeNull()
  })

  it('a present-but-empty variant (no preamble + no feature buffer) treats as no-variant', () => {
    const map = new XGISMap(mockCanvas())
    mountStubRenderer(map, () => {})
    const internals = map as unknown as MapInternals
    internals.vectorTileShows = [{
      sourceName: 'a',
      show: { shaderVariant: { key: 'k', preamble: '', needsFeatureBuffer: false } },
      pipelines: { stale: true }, layout: { stale: true },
    }]
    internals._reResolveVariantPipelines()
    const e = internals.vectorTileShows[0]!
    expect(e.pipelines).toBeNull()
    expect(e.layout).toBeNull()
  })

  it('if getOrCreateVariantPipelines throws, BOTH fields end up null (no half state)', () => {
    const map = new XGISMap(mockCanvas())
    const internals = map as unknown as MapInternals
    internals.renderer = {
      getOrCreateVariantPipelines: () => { throw new Error('boom') },
      getOrBuildVariantLayout: () => ({ __label: 'never' }),
    }
    internals.vectorTileShows = [{
      sourceName: 'a',
      show: { shaderVariant: { key: 'k', preamble: 'foo', needsFeatureBuffer: false } },
      pipelines: { stale: true }, layout: { stale: true },
    }]
    internals._reResolveVariantPipelines()
    const e = internals.vectorTileShows[0]!
    expect(e.pipelines).toBeNull()
    expect(e.layout).toBeNull()
  })

  it('mixed batch: each entry independently honours the invariant', () => {
    const map = new XGISMap(mockCanvas())
    mountStubRenderer(map, () => {})
    const internals = map as unknown as MapInternals
    internals.vectorTileShows = [
      // 0: variant w/ feature buffer → both set
      { sourceName: 'feat', show: { shaderVariant: { key: 'k1', needsFeatureBuffer: true } },
        pipelines: null, layout: null },
      // 1: no variant → both null
      { sourceName: 'plain', show: { shaderVariant: undefined },
        pipelines: { stale: true }, layout: { stale: true } },
      // 2: variant w/ preamble → both set
      { sourceName: 'pre', show: { shaderVariant: { key: 'k2', preamble: 'wgsl' } },
        pipelines: null, layout: null },
    ]
    internals._reResolveVariantPipelines()
    for (const e of internals.vectorTileShows) {
      // The invariant.
      expect((e.pipelines === null) === (e.layout === null),
        `${e.sourceName}: invariant violated (pipelines=${e.pipelines === null ? 'null' : 'set'}, ` +
        `layout=${e.layout === null ? 'null' : 'set'})`,
      ).toBe(true)
    }
  })
})
