import { describe, it, expect } from 'vitest'
import { coverageFromGrids, type CoverageInput } from '@xgis/data/coverage'
import { CoverageRenderer } from './coverage-renderer'

// The vector half of the coverage upload (#1333). The load-bearing gate is the S-102 one: a
// scalar coverage must allocate NOTHING extra, because that is the boundary where the shared
// HDF5 → coverage → drape spine stops being shared and the portrayal becomes per-family.

interface MockTex {
  __tex: true
  id: number
  label: string
}

function makeRenderer(budgetBytes?: number) {
  let id = 0
  const created: MockTex[] = []
  const destroyed: MockTex[] = []
  const rhi = {
    backend: 'webgl2' as const,
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
    // #1366 INC-3 — a region also owns its drape-mesh node buffer, which releaseRegion /
    // dispose now free. Without this the mock throws where the renderer frees, so a leak
    // gate would fail for a reason that has nothing to do with leaks.
    destroyBuffer: () => {},
    destroySampler: () => {},
  }
  const r = new CoverageRenderer(
    { rhi, format: 'bgra8unorm' } as unknown as ConstructorParameters<typeof CoverageRenderer>[0],
    budgetBytes === undefined ? undefined : { budgetBytes },
  )
  return { r, created, destroyed }
}

const cells = (n: number, f: (i: number) => number) =>
  Float32Array.from({ length: n }, (_, i) => f(i))

/** An S-111-shaped VECTOR coverage: speed + direction. */
function vectorHandle(nLon = 4, nLat = 4) {
  const n = nLon * nLat
  const input: CoverageInput = {
    product: 's111',
    origin: [10, 50],
    spacing: [1, 1],
    size: [nLon, nLat],
    vertical: { datumCode: null, sign: 'up' },
    bands: [
      {
        name: 'surfaceCurrentSpeed',
        unit: 'knots',
        kind: 'f32',
        nodata: -9999,
        values: cells(n, (i) => (i % 5) + 1),
      },
      {
        name: 'surfaceCurrentDirection',
        unit: 'arc-degrees',
        kind: 'f32',
        nodata: -9999,
        values: cells(n, (i) => (i * 23) % 360),
      },
    ],
  }
  return coverageFromGrids(input)
}

/** An S-102-shaped SCALAR coverage: depth + uncertainty, both metres. */
function bathymetryHandle(nLon = 4, nLat = 4) {
  const n = nLon * nLat
  const input: CoverageInput = {
    product: 's102',
    origin: [10, 50],
    spacing: [1, 1],
    size: [nLon, nLat],
    vertical: { datumCode: null, sign: 'down' },
    bands: [
      { name: 'depth', unit: 'metres', kind: 'f32', nodata: -9999, values: cells(n, (i) => 5 + i) },
      {
        name: 'uncertainty',
        unit: 'metres',
        kind: 'f32',
        nodata: -9999,
        values: cells(n, () => 0.5),
      },
    ],
  }
  return coverageFromGrids(input)
}

const RAMP = { ramp: 's111-speed' }
const flowTex = (created: MockTex[]) => created.filter((t) => t.label.startsWith('coverage-flow-'))

describe('CoverageRenderer — vector-field upload (#1333)', () => {
  it('a VECTOR coverage uploads the u,v,valid triple and exposes it', () => {
    const { r, created } = makeRenderer()
    r.setCoverage(vectorHandle(4, 4), RAMP)
    expect(flowTex(created).map((t) => t.label)).toEqual([
      'coverage-flow-u',
      'coverage-flow-v',
      'coverage-flow-valid',
    ])
    const f = r.flowField()
    expect(f).not.toBeNull()
    expect([f!.width, f!.height]).toEqual([4, 4])
    expect(f!.scale).toBeGreaterThan(0) // the peak speed the components were normalized by
    expect(r.hasFlowField()).toBe(true)
  })

  it('THE S-102 GATE: a scalar coverage allocates NO flow textures at all', () => {
    // Not "allocates a pair of zeros" — allocates nothing. A bathymetry style must not pay
    // GPU memory for a current it does not have, and must not present one to the flow pass.
    const { r, created } = makeRenderer()
    r.setCoverage(bathymetryHandle(4, 4), RAMP)
    expect(flowTex(created)).toHaveLength(0)
    expect(r.flowField()).toBeNull()
    expect(r.hasFlowField()).toBe(false)
    // ...and the scalar draw is otherwise fully armed, so this is a narrowing, not a break.
    expect(r.hasCoverage()).toBe(true)
  })

  it('hasFlowField() is true when ANY region carries one, false when none do', () => {
    const { r } = makeRenderer()
    r.setCoverage(bathymetryHandle(), RAMP, 'bathy')
    expect(r.hasFlowField()).toBe(false)
    r.setCoverage(vectorHandle(), RAMP, 'currents')
    expect(r.hasFlowField()).toBe(true)
    // flowField() is per-region, so the scalar region still answers null while the vector
    // region answers a field — the pass must not run the bathymetry region through advection.
    expect(r.flowField('bathy')).toBeNull()
    expect(r.flowField('currents')).not.toBeNull()
  })

  it('re-arming a region DESTROYS its previous flow pair (no leak across a time step)', () => {
    // Stepping the forecast hour re-arms the same region every time; leaking two textures per
    // step would be a steady GPU leak for the whole playback.
    const { r, created, destroyed } = makeRenderer()
    r.setCoverage(vectorHandle(), RAMP)
    const first = flowTex(created)
    expect(first).toHaveLength(3)
    r.setCoverage(vectorHandle(), RAMP)
    expect(destroyed).toEqual(expect.arrayContaining(first))
    expect(flowTex(created)).toHaveLength(6)
  })

  it('a vector coverage is BUDGETED above a scalar one of the same grid', () => {
    // The flow TRIPLE (u, v, valid — #1565) is the same size as the value/valid pair, so a
    // vector region costs 2.5× a scalar one. If the accounting missed that, the LRU would evict
    // far too late and the GPU budget would be overshot by the whole flow field.
    //
    // The budget is chosen to DISCRIMINATE, which an obvious-looking one does not: at 4x4,
    //   scalar          = 4*4*2*2 + 1024 = 1088
    //   vector (correct)= 4*4*2*5 + 1024 = 1184
    //   vector (if the flow textures were dropped entirely) = 1088
    // A budget of 1088 evicts on the second region either way, so it would pass on the broken
    // accounting too. 2176 = scalar + vector-without-any-flow-textures is the value where the
    // two implementations disagree: correct → 2272 > 2176 → evict; broken → 2176 ≤ 2176 → keep.
    const { r } = makeRenderer(2176)
    r.setCoverage(bathymetryHandle(4, 4), RAMP, 'a')
    r.setCoverage(vectorHandle(4, 4), RAMP, 'b')
    expect(r.residentRegions()).toEqual(['b'])
  })

  it('activeFlowField() and hasFlowField() answer over the SAME regions', () => {
    // They are the two halves of one decision: hasFlowField gates the pass (and keeps the
    // on-demand loop warm), activeFlowField supplies what the pass steps. A true here with a
    // null there spins the render loop every frame on a pass that does nothing — an animation
    // that looks merely "slow" while it is actually dead.
    const { r } = makeRenderer()
    expect(r.hasFlowField()).toBe(false)
    expect(r.activeFlowField()).toBeNull()
    // The DEFAULT region is not where the field is: a mosaic keys its regions, so an accessor
    // hard-wired to DEFAULT_REGION would answer null here while hasFlowField answered true.
    r.setCoverage(bathymetryHandle(), RAMP, 'bathy')
    r.setCoverage(vectorHandle(), RAMP, 'currents')
    expect(r.hasFlowField()).toBe(true)
    expect(r.activeFlowField()).not.toBeNull()
  })

  it('the field carries the grid GEOMETRY the advection needs, from the same region', () => {
    // Pairing a field with another region's span would advect at the wrong rate and the wrong
    // angle — a plausible-looking animation over the wrong water. 4×4 cells of 1° from
    // origin (10, 50): span 4°×4°, outer edges 49.5..53.5, so the mid latitude is 51.5.
    const { r } = makeRenderer()
    r.setCoverage(vectorHandle(4, 4), RAMP)
    const f = r.activeFlowField()!
    expect([...f.spanDeg]).toEqual([4, 4])
    expect(f.midLatDeg).toBeCloseTo(51.5, 9)
  })

  it('dispose() frees the flow pair too', () => {
    const { r, created, destroyed } = makeRenderer()
    r.setCoverage(vectorHandle(), RAMP)
    const pair = flowTex(created)
    r.dispose()
    expect(destroyed).toEqual(expect.arrayContaining(pair))
  })
})
