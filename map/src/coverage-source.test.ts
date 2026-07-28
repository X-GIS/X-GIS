import { describe, it, expect, vi } from 'vitest'
import { dropCoverageRegion, pushCoverageRegion, type CoverageSourceDeps } from './coverage-source'
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
    armFromShow: () => false,
    clearArrows: () => {},
    invalidate: () => {},
    // Live-refresh deps (#1158): inert here. These gates exercise residency only, and the
    // refresh policy has its own suite (coverage-refresh.test.ts) — stubbing them keeps this
    // file about the ONE contract it is for.
    refresh: { stopAll: () => {} } as unknown as CoverageSourceDeps['refresh'],
    guardedFetch: () => fetch,
    destroyed: () => false,
    catalogues: new Map(),
    view: () => null,
    watchViewport: () => {},
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

// `pushCoverageRegion` decodes the pushed bytes; the decode is not what these gates are about.
vi.mock('@xgis/data', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('@xgis/data')),
  readCoverage: async () => ({ meta: {} }),
}))

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

// ─── THE FIRST PUSH BEATS THE LATCH (#1449) ──────────────────────────────────────────────
//
// `fieldArmed()` is a latch set by `rebuildLayers`, and the rebuild only reaches its coverage
// branch once the source HAS data. The very first push is what puts the data there, so it
// ALWAYS finds the latch false — and used to fall through to a raw `setCoverage`, bypassing
// `armCoverageDrape`: no `hidden`, no `flowOnly`, no arrows. Under the S-111 arrows portrayal
// a first-loaded region therefore showed the ramp drape it was meant to hide and none of its
// glyphs, until some later interaction re-armed it. A viewport mosaic pushes several regions
// in that first batch, which is where it showed up worst.
describe('armRegion — a FIRST push arms from the SHOWS, not from the latch (#1449)', () => {
  const bytes = new ArrayBuffer(8)

  it('latch false + a layer declaring a field → armed from the shows, NOT the raw fill arm', async () => {
    const armed: string[] = []
    const { deps, rawDatasets, setRenderer } = makeDeps({
      fieldArmed: () => false, // the real state of a first push
      armFromShow: (_id, _h, region) => {
        armed.push(region)
        return true // a `| arrow` / `| flow` layer claims this source
      },
    })
    const r = stubRenderer()
    setRenderer(r)
    rawDatasets.set('currents', { _coverage: new Map() })
    await pushCoverageRegion(deps, 'currents', bytes, { region: 'cbofs' })
    expect(armed, 'the show authority arms the region').toEqual(['cbofs'])
    expect(
      r.setCoverage,
      'and the bypass that loses `hidden` / the arrows never runs',
    ).not.toHaveBeenCalled()
  })

  it('no field declared → still the plain fill arm, unchanged', async () => {
    const { deps, rawDatasets, setRenderer } = makeDeps({
      fieldArmed: () => false,
      armFromShow: () => false, // ramp-only coverage: no show claims a field
    })
    const r = stubRenderer()
    setRenderer(r)
    rawDatasets.set('currents', { _coverage: new Map() })
    await pushCoverageRegion(deps, 'currents', bytes, { region: 'cbofs' })
    expect(r.setCoverage).toHaveBeenCalled()
  })

  it('an imperative ramp override still wins — it is the caller naming the paint', async () => {
    // The override is the one case that must NOT be re-derived from the layer's declaration.
    const armed: string[] = []
    const { deps, rawDatasets, setRenderer } = makeDeps({
      fieldArmed: () => false,
      armFromShow: (_id, _h, region) => {
        armed.push(region)
        return true
      },
    })
    const r = stubRenderer()
    setRenderer(r)
    rawDatasets.set('currents', { _coverage: new Map() })
    await pushCoverageRegion(deps, 'currents', bytes, { region: 'cbofs', ramp: 'magma' })
    expect(armed).toEqual([])
    expect(r.setCoverage).toHaveBeenCalled()
  })

  it('once the latch IS set, the steady-state path is unchanged', async () => {
    // A forecast step / host frame push keeps re-deriving from the LIVE display opts.
    const fields: string[] = []
    const { deps, rawDatasets, setRenderer } = makeDeps({
      fieldArmed: () => true,
      armFields: (_h, region) => void fields.push(region),
      armFromShow: () => {
        throw new Error('the latch owns this case — the show path must not run')
      },
    })
    setRenderer(stubRenderer())
    rawDatasets.set('currents', { _coverage: new Map() })
    await pushCoverageRegion(deps, 'currents', bytes, { region: 'cbofs' })
    expect(fields).toEqual(['cbofs'])
  })
})
