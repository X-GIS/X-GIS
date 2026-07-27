import { describe, it, expect, vi } from 'vitest'
import { dropCoverageRegion, type CoverageSourceDeps } from './coverage-source'
import type { CoverageRenderer } from './render/coverage-renderer'
import type { RawDataset } from './map-types'

// The region machinery's dependency contract (#1272 E-④).
//
// THE BUG THIS EXISTS FOR: `XGISMap.coverageRenderer` is declared with a definite-assignment
// `!` and is only assigned once the GPU boots — and reassigned again on a backend switch. The
// deps record is built as a FIELD INITIALISER, so `renderer: this.coverageRenderer` captured
// `undefined` permanently. Nothing typed caught it (the `!` is exactly a promise to tsc that
// it is assigned), no unit test caught it (they inject their own deps), and the arrow/flow
// paths hid it (they route through `armFields` and never touch the renderer). It surfaced
// only when a ramp-only coverage was actually RENDERED: `deps.renderer.displayOpts()` threw
// "Cannot read properties of undefined".
//
// So the contract is pinned here: `renderer` is a THUNK, resolved at call time, and these
// gates fail if anyone converts it back to a captured value.

function makeDeps(overrides: Partial<CoverageSourceDeps> = {}): {
  deps: CoverageSourceDeps
  rawDatasets: Map<string, RawDataset>
  setRenderer: (r: CoverageRenderer) => void
  renderer: () => CoverageRenderer | null
} {
  const rawDatasets = new Map<string, RawDataset>()
  // Deliberately null at deps-construction time — the map's real state before GPU boot.
  let late: CoverageRenderer | null = null
  const deps: CoverageSourceDeps = {
    rawDatasets,
    renderer: () => late as CoverageRenderer,
    time: { nextEpoch: () => 1, isCurrent: () => true } as unknown as CoverageSourceDeps['time'],
    fieldArmed: () => false,
    armFields: () => {},
    clearArrows: () => {},
    invalidate: () => {},
    ...overrides,
  }
  return { deps, rawDatasets, setRenderer: (r) => (late = r), renderer: () => late }
}

function stubRenderer(): CoverageRenderer & { clearRegion: ReturnType<typeof vi.fn> } {
  return {
    clearRegion: vi.fn(),
    displayOpts: () => ({ ramp: 'viridis', rangeLo: 0, rangeHi: 1, opacity: 1 }),
    setCoverage: vi.fn(),
  } as unknown as CoverageRenderer & { clearRegion: ReturnType<typeof vi.fn> }
}

const handle = { meta: {} } as never

describe('coverage-source deps contract (#1272 E-④)', () => {
  it('THE REGRESSION: the renderer is resolved at CALL time, not at deps-construction time', () => {
    const { deps, rawDatasets, setRenderer } = makeDeps()
    rawDatasets.set('currents', { _coverage: new Map([['west', { handle }]]) })

    // The renderer does not exist yet — exactly the state a field initialiser sees.
    expect(deps.renderer()).toBeNull()

    // …it arrives later (GPU boot), and the machinery must pick THAT one up.
    const r = stubRenderer()
    setRenderer(r)
    dropCoverageRegion(deps, 'currents', 'west')
    expect(r.clearRegion).toHaveBeenCalledWith('west')
  })

  it('a LATER renderer (backend switch reassigns it) is the one that gets driven', () => {
    // `coverageRenderer` is reassigned on a backend switch, so even a capture taken at the
    // right moment goes stale. Only a thunk survives this.
    const { deps, rawDatasets, setRenderer } = makeDeps()
    rawDatasets.set('currents', {
      _coverage: new Map([
        ['a', { handle }],
        ['b', { handle }],
      ]),
    })
    const first = stubRenderer()
    setRenderer(first)
    dropCoverageRegion(deps, 'currents', 'a')
    expect(first.clearRegion).toHaveBeenCalledWith('a')

    const second = stubRenderer()
    setRenderer(second)
    dropCoverageRegion(deps, 'currents', 'b')
    expect(second.clearRegion).toHaveBeenCalledWith('b')
    expect(first.clearRegion, 'the stale renderer must not be driven').toHaveBeenCalledTimes(1)
  })

  it('dropping a region removes exactly that key and leaves its neighbours resident', () => {
    const { deps, rawDatasets, setRenderer } = makeDeps()
    setRenderer(stubRenderer())
    rawDatasets.set('currents', {
      _coverage: new Map([
        ['cbofs', { handle }],
        ['dbofs', { handle }],
      ]),
    })
    dropCoverageRegion(deps, 'currents', 'cbofs')
    const left = rawDatasets.get('currents') as { _coverage: ReadonlyMap<string, unknown> }
    expect([...left._coverage.keys()]).toEqual(['dbofs'])
  })

  it('dropping an unknown region is a no-op — it must not touch the renderer', () => {
    const { deps, rawDatasets, setRenderer } = makeDeps()
    const r = stubRenderer()
    setRenderer(r)
    rawDatasets.set('currents', { _coverage: new Map([['cbofs', { handle }]]) })
    dropCoverageRegion(deps, 'currents', 'sfbofs')
    expect(r.clearRegion).not.toHaveBeenCalled()
    const left = rawDatasets.get('currents') as { _coverage: ReadonlyMap<string, unknown> }
    expect([...left._coverage.keys()]).toEqual(['cbofs'])
  })
})
