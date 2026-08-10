// ═══ CoverageRenderer multi-region residency (#1333) ═══
//
// The renderer used to hold ONE `state: CoverageState | null`, and `setCoverage` began with an
// unconditional `releaseTextures()` — so a viewport spanning two NOAA operational-forecast
// domains could only ever show one, and swapping regions destroyed the previous one's textures.
// These gates pin the keyed replacement:
//   • the DEFAULT (unkeyed) path is unchanged — one resident region, replaced on each arm;
//   • distinct keys accumulate and ALL draw in one frame (the actual multi-region capability);
//   • the LRU byte budget bounds accumulation, never evicting the region just armed;
//   • every released region's textures are destroyed exactly once (no GPU leak);
//   • rebuildForQuality re-arms EVERY resident region, not just the last.

import { describe, it, expect } from 'vitest'
import { coverageFromGrids, type CoverageInput } from '@xgis/data/coverage'
import { CoverageRenderer, DEFAULT_REGION } from './coverage-renderer'
import { COVERAGE_NODE_STRIDE } from './material/coverage-material'
import { coverageNodeCount } from '../shaders/dsl/coverage-ramp'

interface MockTex {
  __tex: true
  id: number
  label: string
}

function makeMockCtx(): {
  ctx: { rhi: unknown; format: string }
  created: MockTex[]
  destroyed: MockTex[]
} {
  let id = 0
  const created: MockTex[] = []
  const destroyed: MockTex[] = []
  const rhi = {
    backend: 'webgl2' as const, // skips wrapWebGpuPass — the pass is passed through as-is
    caps: { maxSampleCount: 1 },
    createBindGroupLayout: () => ({ __layout: true }),
    createPipeline: () => ({ __pipe: true }),
    createShaderModule: () => ({ __mod: true }),
    createSampler: () => ({ __sampler: true }),
    createBuffer: () => ({ __buf: true }),
    createBindGroup: () => ({ __bg: true }),
    createView: () => ({ __view: true }),
    createTexture: (d: { label?: string }) => {
      const t: MockTex = { __tex: true, id: ++id, label: d.label ?? '' }
      created.push(t)
      return t
    },
    writeTexture: () => {},
    writeBuffer: () => {},
    destroyTexture: (t: MockTex) => void destroyed.push(t),
    // #1578 — `rebuildForQuality` now RELEASES each draper before dropping it, and
    // `Material.destroy()` routes its pipelines through this. A stub missing it throws.
    destroyPipeline: () => {},
    destroySampler: () => {},
    // #1366 INC-3 — the drape mesh became an indexed vertex buffer (per-arm node
    // positions + one shared topology buffer), so the double has to free buffers too.
    destroyBuffer: () => {},
  }
  return { ctx: { rhi, format: 'bgra8unorm' }, created, destroyed }
}

/** A tiny but REAL CoverageHandle — `nCells` drives the byte accounting the budget uses. */
function handleOf(
  nLon: number,
  nLat: number,
  originLon = 10,
): ReturnType<typeof coverageFromGrids> {
  const input: CoverageInput = {
    product: 's111',
    origin: [originLon, 50],
    spacing: [1, 1],
    size: [nLon, nLat],
    vertical: { datumCode: null, sign: 'up' },
    bands: [
      {
        name: 'surfaceCurrentSpeed',
        unit: 'knots',
        kind: 'f32',
        nodata: -9999,
        values: Float32Array.from(Array.from({ length: nLon * nLat }, (_, i) => (i % 5) + 1)),
      },
    ],
  }
  return coverageFromGrids(input)
}

const RAMP = { ramp: 's111-speed' }

// The renderer's draw path needs a built draper; `ensureDraper` constructs a real
// CoverageDraper against the mock RHI. Where a test only needs residency bookkeeping (not a
// draw), that is exercised through the public surface without touching render().
function makeRenderer(budgetBytes?: number): {
  r: CoverageRenderer
  created: MockTex[]
  destroyed: MockTex[]
} {
  const { ctx, created, destroyed } = makeMockCtx()
  const r = new CoverageRenderer(
    ctx as unknown as ConstructorParameters<typeof CoverageRenderer>[0],
    budgetBytes === undefined ? undefined : { budgetBytes },
  )
  return { r, created, destroyed }
}

describe('CoverageRenderer — single-region default path is UNCHANGED (#1333)', () => {
  it('an unkeyed arm leaves exactly ONE resident region, on the default key', () => {
    const { r } = makeRenderer()
    expect(r.hasCoverage()).toBe(false)
    r.setCoverage(handleOf(4, 4), RAMP)
    expect(r.hasCoverage()).toBe(true)
    expect(r.residentRegions()).toEqual([DEFAULT_REGION])
  })

  it('re-arming unkeyed REPLACES (never accumulates) and destroys the prior textures', () => {
    const { r, created, destroyed } = makeRenderer()
    r.setCoverage(handleOf(4, 4), RAMP)
    const firstBatch = created.length // value + valid + lut
    expect(firstBatch).toBe(3)
    r.setCoverage(handleOf(4, 4), RAMP)
    expect(r.residentRegions()).toEqual([DEFAULT_REGION]) // still ONE
    expect(destroyed).toHaveLength(3) // the first arm's three textures, released
  })

  it('clear() releases the default region and reports no coverage', () => {
    const { r, destroyed } = makeRenderer()
    r.setCoverage(handleOf(4, 4), RAMP)
    r.clear()
    expect(r.hasCoverage()).toBe(false)
    expect(r.residentRegions()).toEqual([])
    expect(destroyed).toHaveLength(3)
  })
})

describe('CoverageRenderer — keyed multi-region residency (#1333)', () => {
  it('distinct keys accumulate — BOTH regions stay resident (the capability that was missing)', () => {
    const { r, destroyed } = makeRenderer()
    r.setCoverage(handleOf(4, 4, 10), RAMP, 'cbofs')
    r.setCoverage(handleOf(4, 4, 20), RAMP, 'dbofs')
    expect(r.residentRegions()).toEqual(['cbofs', 'dbofs'])
    expect(destroyed).toHaveLength(0) // arming a SECOND region destroys nothing
  })

  it('re-arming ONE key (a time-step) leaves the other region untouched', () => {
    const { r, created, destroyed } = makeRenderer()
    r.setCoverage(handleOf(4, 4, 10), RAMP, 'cbofs')
    const cbofsTextures = created.slice(0, 3) // the 1st arm's three
    r.setCoverage(handleOf(4, 4, 20), RAMP, 'dbofs')
    const dbofsTextures = created.slice(3, 6) // the 2nd arm's three
    expect(destroyed).toHaveLength(0)

    r.setCoverage(handleOf(4, 4, 10), RAMP, 'cbofs') // step cbofs' forecast hour
    expect(r.residentRegions()).toHaveLength(2)
    expect(r.residentRegions()).toContain('dbofs')
    // EXACTLY cbofs' old textures were freed — dbofs' were not touched. (The pre-fix
    // single-slot renderer would have destroyed dbofs' here, since setCoverage began with an
    // unconditional releaseTextures().)
    expect(destroyed).toEqual(cbofsTextures)
    for (const t of dbofsTextures) expect(destroyed).not.toContain(t)
  })

  it('re-arming refreshes LRU recency — the re-armed key moves to the BACK', () => {
    const { r } = makeRenderer()
    r.setCoverage(handleOf(4, 4), RAMP, 'a')
    r.setCoverage(handleOf(4, 4), RAMP, 'b')
    expect(r.residentRegions()).toEqual(['a', 'b'])
    r.setCoverage(handleOf(4, 4), RAMP, 'a') // touch 'a'
    expect(r.residentRegions()).toEqual(['b', 'a']) // 'a' is now most-recent
  })

  it('clearRegion drops ONE region (and its textures), leaving the rest', () => {
    const { r, destroyed } = makeRenderer()
    r.setCoverage(handleOf(4, 4), RAMP, 'a')
    r.setCoverage(handleOf(4, 4), RAMP, 'b')
    r.clearRegion('a')
    expect(r.residentRegions()).toEqual(['b'])
    expect(destroyed).toHaveLength(3) // exactly 'a' textures
    r.clearRegion('nonexistent') // idempotent / unknown key is a no-op
    expect(r.residentRegions()).toEqual(['b'])
    expect(destroyed).toHaveLength(3)
  })

  it('clear() releases EVERY resident region', () => {
    const { r, destroyed } = makeRenderer()
    r.setCoverage(handleOf(4, 4), RAMP, 'a')
    r.setCoverage(handleOf(4, 4), RAMP, 'b')
    r.setCoverage(handleOf(4, 4), RAMP, 'c')
    r.clear()
    expect(r.residentRegions()).toEqual([])
    expect(destroyed).toHaveLength(9) // 3 regions × 3 textures
  })
})

describe('CoverageRenderer — LRU byte budget bounds accumulation (#1333)', () => {
  // Per-region GPU bytes, DERIVED from the same terms the renderer accounts rather than
  // hardcoded, so the budget arithmetic cannot drift from it again: the two r16float
  // grids + the 256×1 LUT + the drape-mesh node buffer. The node buffer (#1366 INC-3) is
  // a per-region constant that dwarfs a tiny test grid — including it is correct, since
  // it IS memory the region holds and bounding accumulation is the budget's whole job.
  const REGION_BYTES = 4 * 4 * 2 * 2 + 256 * 4 + coverageNodeCount() * COVERAGE_NODE_STRIDE

  it('evicts the LEAST-recently-armed region when the budget is exceeded', () => {
    const { r } = makeRenderer(REGION_BYTES * 2 + 1)
    r.setCoverage(handleOf(4, 4), RAMP, 'a')
    r.setCoverage(handleOf(4, 4), RAMP, 'b')
    expect(r.residentRegions()).toEqual(['a', 'b'])
    r.setCoverage(handleOf(4, 4), RAMP, 'c') // over budget → evict 'a' (oldest)
    expect(r.residentRegions()).toEqual(['b', 'c'])
  })

  it('NEVER evicts the region just armed, even if it alone exceeds the budget', () => {
    const { r } = makeRenderer(1) // absurdly small — everything "exceeds" it
    r.setCoverage(handleOf(4, 4), RAMP, 'solo')
    expect(r.residentRegions()).toEqual(['solo']) // still resident, still drawable
    expect(r.hasCoverage()).toBe(true)
  })

  it('an evicted region has its textures destroyed (the budget frees GPU memory, not just bookkeeping)', () => {
    const { r, destroyed } = makeRenderer(REGION_BYTES * 2 + 1)
    r.setCoverage(handleOf(4, 4), RAMP, 'a')
    r.setCoverage(handleOf(4, 4), RAMP, 'b')
    expect(destroyed).toHaveLength(0)
    r.setCoverage(handleOf(4, 4), RAMP, 'c')
    expect(destroyed).toHaveLength(3) // 'a' was evicted AND its 3 textures freed
  })

  it('an eviction is ANNOUNCED — nothing else can observe the LRU dropping a region (#1419)', () => {
    // An explicit `removeCoverageRegion` clears that region's compiled arrows on the way out.
    // The LRU drop had no such path: the region's textures were freed while its advected arrow
    // batch stayed resident and kept drawing — one more batch per eviction, binding a velocity
    // pair that no longer exists. Reported from S-111 Live as
    //   "destroyed texture coverage-flow-v used in a submit"
    // after zooming out and panning to another domain.
    const { r } = makeRenderer(REGION_BYTES * 2 + 1)
    const dropped: string[] = []
    r.onRegionDropped = (region) => void dropped.push(region)
    r.setCoverage(handleOf(4, 4), RAMP, 'a')
    r.setCoverage(handleOf(4, 4), RAMP, 'b')
    expect(dropped, 'arming announces nothing — only a DROP does').toEqual([])
    r.setCoverage(handleOf(4, 4), RAMP, 'c')
    expect(dropped).toEqual(['a'])
  })

  it('a RE-ARM is not a drop — the region is coming straight back, glyphs and all', () => {
    // The hook fires from `clearRegion`, not `releaseRegion`, precisely so a forecast step (or
    // an MSAA rebuild) cannot wipe the arrows it is about to re-add.
    const { r } = makeRenderer()
    const dropped: string[] = []
    r.onRegionDropped = (region) => void dropped.push(region)
    r.setCoverage(handleOf(4, 4), RAMP, 'a')
    r.setCoverage(handleOf(4, 4), RAMP, 'a') // same key: release + re-arm
    r.rebuildForQuality()
    expect(dropped).toEqual([])
  })

  it('a generous budget evicts nothing', () => {
    const { r, destroyed } = makeRenderer(REGION_BYTES * 100)
    for (const k of ['a', 'b', 'c', 'd', 'e']) r.setCoverage(handleOf(4, 4), RAMP, k)
    expect(r.residentRegions()).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(destroyed).toHaveLength(0)
  })
})

describe('CoverageRenderer — rebuildForQuality re-arms EVERY region (#1333)', () => {
  it('all resident regions survive an MSAA rebuild (not just the last-armed one)', () => {
    const { r } = makeRenderer()
    r.setCoverage(handleOf(4, 4, 10), RAMP, 'cbofs')
    r.setCoverage(handleOf(4, 4, 20), RAMP, 'dbofs')
    r.rebuildForQuality()
    expect(r.residentRegions()).toEqual(['cbofs', 'dbofs'])
    expect(r.hasCoverage()).toBe(true)
  })

  it('the rebuild releases the old textures for every region (no leak across a quality change)', () => {
    const { r, destroyed } = makeRenderer()
    r.setCoverage(handleOf(4, 4), RAMP, 'a')
    r.setCoverage(handleOf(4, 4), RAMP, 'b')
    r.rebuildForQuality()
    expect(destroyed).toHaveLength(6) // both regions' pre-rebuild textures
  })

  it('a rebuild with nothing armed stays empty (no phantom default region)', () => {
    const { r } = makeRenderer()
    r.rebuildForQuality()
    expect(r.hasCoverage()).toBe(false)
    expect(r.residentRegions()).toEqual([])
  })
})

describe('CoverageRenderer — displayOpts stays a single global notion (#1333)', () => {
  it('reports the most recently armed display, across regions', () => {
    const { r } = makeRenderer()
    expect(r.displayOpts().ramp).toBe('viridis') // unarmed default
    r.setCoverage(handleOf(4, 4), { ramp: 's111-speed', rangeLo: 0, rangeHi: 13 }, 'a')
    expect(r.displayOpts()).toMatchObject({ ramp: 's111-speed', rangeLo: 0, rangeHi: 13 })
    r.setCoverage(handleOf(4, 4), { ramp: 'viridis', opacity: 0.5 }, 'b')
    expect(r.displayOpts()).toMatchObject({ ramp: 'viridis', opacity: 0.5 })
  })

  it('clear() resets it to the unarmed default', () => {
    const { r } = makeRenderer()
    r.setCoverage(handleOf(4, 4), { ramp: 's111-speed' }, 'a')
    r.clear()
    expect(r.displayOpts().ramp).toBe('viridis')
  })
})
