// ═══ Catalogue-driven coverage residency — the engine decides, from the viewport (#1453) ═══
//
// `type: raster` has always taken a URL and let the ENGINE resolve the viewport into what to
// fetch. `type: coverage` read one cell at attach and never looked at the camera again, so the
// S-111 demo carried 860 lines re-implementing that job in app code and S-102, which never got
// them, hard-coded one cell.
//
// These gates drive the real composition — the real probe, the real STAC parse, the real
// CoverageRenderer with its real byte budget, wired through the real `onRegionDropped` — over
// a range-capable stub server. What is NOT stubbed is the part that has bitten before: the
// budget is the renderer's, and this suite never tells it what to evict.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as shared from '@xgis/shared'
import { setLogSink } from '@xgis/shared'
import type { Bbox, CoverageHandle } from '@xgis/data'
import { CoverageRenderer, DEFAULT_REGION } from './render/coverage-renderer'
import {
  loadDeclaredCoverage,
  onCoverageRegionDropped,
  syncCoverageResidency,
  coverageRegions,
  type CoverageSourceDeps,
} from './coverage-source'
import type { RawDataset } from './map-types'

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'data',
  'src',
  'hdf5',
  '__fixtures__',
  'asym_southflip.h5',
)
const CELL = readFileSync(FIXTURE)

const CATALOGUE_URL = 'https://example.com/s111/catalog.json'

/** The NOAA domains the S-111 demo's registry carried, as a STAC ItemCollection. */
const ITEMS: Array<[string, Bbox]> = [
  ['cbofs', [-77.3, 36.0, -74.9, 39.6]],
  ['dbofs', [-75.9, 38.0, -74.2, 40.5]],
  ['sfbofs', [-123.2, 36.9, -121.3, 38.5]],
]
function catalogueDoc(items: Array<[string, Bbox]> = ITEMS): unknown {
  return {
    type: 'FeatureCollection',
    stac_version: '1.0.0',
    features: items.map(([id, bbox]) => ({
      type: 'Feature',
      id,
      bbox,
      geometry: null,
      properties: { datetime: '2026-07-28T00:00:00Z' },
      assets: { data: { href: `cells/${id}.h5`, roles: ['data'] } },
    })),
  }
}

/** Serves bytes per URL, honouring Range (the coverage read path range-streams, and the
 *  cell/catalogue probe reads exactly 8 bytes). `unreachable` 404s. */
function stubServer(opts: { doc?: unknown; unreachable?: Set<string>; hold?: string } = {}) {
  const doc = opts.doc ?? catalogueDoc()
  const body = (url: string): Uint8Array | null => {
    if (opts.unreachable?.has(url)) return null
    if (url === CATALOGUE_URL) return new TextEncoder().encode(JSON.stringify(doc))
    if (url.endsWith('.h5')) return CELL
    return null
  }
  const calls: string[] = []
  // `hold` blocks the first read of one cell until `release()`, so a test can interleave a
  // camera move with a fetch that is genuinely in flight — the only way the stale-arm race
  // reproduces (an instant stub completes the whole loop before anything can move).
  let releaseHold = (): void => {}
  const held = new Promise<void>((r) => (releaseHold = r))
  let holdArmed = opts.hold !== undefined
  const spy = vi.spyOn(shared, 'safeFetch').mockImplementation(async (u, init) => {
    const url = String(u)
    calls.push(url)
    if (holdArmed && opts.hold !== undefined && url.endsWith(opts.hold)) {
      holdArmed = false
      await held
    }
    const bytes = body(url)
    if (!bytes) return new Response('nope', { status: 404 }) as never
    const range = (init?.headers as Record<string, string> | undefined)?.['Range']
    const m = range ? /bytes=(\d+)-(\d*)/.exec(range) : null
    if (!m) return new Response(bytes, { status: 200 }) as never
    const start = Number(m[1])
    const end = m[2] ? Math.min(Number(m[2]), bytes.length - 1) : bytes.length - 1
    const slice = bytes.slice(start, end + 1)
    return new Response(slice, {
      status: 206,
      headers: { 'content-range': `bytes ${start}-${start + slice.length - 1}/${bytes.length}` },
    }) as never
  })
  return { spy, calls, release: () => releaseHold() }
}

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

/** The real deps, with the real renderer behind `armFromShow` — so an arm really does put a
 *  region under the real GPU byte budget, and an eviction really does travel back through
 *  `onRegionDropped`. `budgetBytes: 1` makes the budget fit exactly one region (the renderer
 *  never evicts the region just armed), with no dependence on its accounting constants. */
function makeDeps(view: Bbox | null, budgetBytes?: number) {
  const rawDatasets = new Map<string, RawDataset>([['currents', { _coverage: new Map() }]])
  const renderer = new CoverageRenderer(
    mockCtx() as unknown as ConstructorParameters<typeof CoverageRenderer>[0],
    budgetBytes === undefined ? undefined : { budgetBytes },
  )
  const armed: string[] = []
  const watching: boolean[] = []
  let currentView = view
  const deps: CoverageSourceDeps = {
    rawDatasets,
    renderer: () => renderer,
    time: {
      nextEpoch: () => 1,
      isCurrent: () => true,
    } as unknown as CoverageSourceDeps['time'],
    fieldArmed: () => false,
    armFields: () => {},
    // Stands in for the real show-derived arm (#1449): a layer claims the source, so it
    // returns true and puts the region under the renderer's real byte budget.
    armFromShow: (_id: string, handle: CoverageHandle, region: string) => {
      armed.push(region)
      renderer.setCoverage(handle, { ramp: 's111-speed' }, region)
      return true
    },
    clearArrows: () => {},
    invalidate: () => {},
    refresh: { stopAll: () => {} } as unknown as CoverageSourceDeps['refresh'],
    guardedFetch: (label) => (u, init) => shared.safeFetch(String(u), init, label),
    destroyed: () => false,
    runEpoch: () => 0,
    catalogues: new Map(),
    view: () => currentView,
    watchViewport: () => void watching.push(true),
  }
  renderer.onRegionDropped = (r) => onCoverageRegionDropped(deps, r)
  return {
    deps,
    renderer,
    armed,
    pan: (v: Bbox | null) => (currentView = v),
    watching,
    cpuRegions: () => [...(coverageRegions(deps, 'currents') ?? new Map()).keys()],
  }
}

/** Capture engine logs so an expected failure does not spam the run. */
async function withCapturedLog<T>(fn: () => Promise<T>): Promise<{ value: T; logs: string[] }> {
  const logs: string[] = []
  setLogSink((_l, message) => void logs.push(message))
  try {
    return { value: await fn(), logs }
  } finally {
    setLogSink(null)
  }
}

const MID_ATLANTIC: Bbox = [-76.5, 37.5, -74.5, 39.5] // spans cbofs + dbofs
const SF_BAY: Bbox = [-122.6, 37.5, -122.1, 38.0] // sfbofs only
const MID_PACIFIC: Bbox = [-160, 10, -150, 20] // no cell at all

describe('a coverage `url:` that names a CATALOGUE (#1453)', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('reads it as STAC and arms every cell the viewport covers, most-relevant first', async () => {
    stubServer()
    const { deps, armed, cpuRegions } = makeDeps(MID_ATLANTIC)

    await loadDeclaredCoverage(deps, 'currents', CATALOGUE_URL)

    // BOTH domains — that is the mosaic. A most-overlap contest with one winner is what the
    // demo did before multi-region residency existed.
    expect(armed).toEqual(['cbofs', 'dbofs'])
    expect(cpuRegions()).toEqual(['cbofs', 'dbofs'])
  })

  it('arms the cells under their STAC ITEM IDS, so the region API still addresses them', async () => {
    stubServer()
    const { deps, cpuRegions } = makeDeps(SF_BAY)
    await loadDeclaredCoverage(deps, 'currents', CATALOGUE_URL)
    expect(cpuRegions()).toEqual(['sfbofs'])
    expect(cpuRegions()).not.toContain(DEFAULT_REGION)
  })

  it('resolves each item href against the CATALOGUE url, not the page', async () => {
    const { calls } = stubServer()
    const { deps } = makeDeps(SF_BAY)
    await loadDeclaredCoverage(deps, 'currents', CATALOGUE_URL)
    expect(calls).toContain('https://example.com/s111/cells/sfbofs.h5')
  })

  it('a viewport over no cell arms nothing, and is not an error', async () => {
    stubServer()
    const { deps, armed, cpuRegions } = makeDeps(MID_PACIFIC)
    await loadDeclaredCoverage(deps, 'currents', CATALOGUE_URL)
    expect(armed).toEqual([])
    expect(cpuRegions()).toEqual([])
  })

  it('a null viewport (camera cannot answer yet) defers to the first move-end', async () => {
    stubServer()
    const { deps, armed, pan } = makeDeps(null)
    await loadDeclaredCoverage(deps, 'currents', CATALOGUE_URL)
    expect(armed).toEqual([])
    pan(SF_BAY)
    await syncCoverageResidency(deps, 'currents')
    expect(armed).toEqual(['sfbofs'])
  })
})

describe('a coverage `url:` that names ONE CELL is unchanged (#1453 must not regress #1426)', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('still arms exactly one region, on the default key, with no catalogue registered', async () => {
    stubServer()
    const { deps, cpuRegions } = makeDeps(MID_ATLANTIC)
    await loadDeclaredCoverage(deps, 'currents', 'https://example.com/cells/one.h5')
    expect(cpuRegions()).toEqual([DEFAULT_REGION])
    expect(deps.catalogues.size).toBe(0)
  })

  it('a move-end over a single-cell source is inert', async () => {
    stubServer()
    const { deps, armed } = makeDeps(MID_ATLANTIC)
    await loadDeclaredCoverage(deps, 'currents', 'https://example.com/cells/one.h5')
    await syncCoverageResidency(deps, 'currents')
    expect(armed).toEqual([DEFAULT_REGION]) // the attach arm, and nothing more
  })

  it('and never subscribes to the camera — only a CATALOGUE arms the viewport watch', async () => {
    // A map that declares no catalogue must not gain a `moveend` listener: the map-event
    // registry is observable (`map.on`/`off` round-trips are gated on it), so a listener
    // installed for a feature the scene does not use is a contract change, not an optimisation.
    stubServer()
    const cell = makeDeps(MID_ATLANTIC)
    await loadDeclaredCoverage(cell.deps, 'currents', 'https://example.com/cells/one.h5')
    expect(cell.watching).toEqual([])

    const cat = makeDeps(MID_ATLANTIC)
    await loadDeclaredCoverage(cat.deps, 'currents', CATALOGUE_URL)
    expect(cat.watching).toEqual([true])
  })
})

describe('the viewport drives residency on every move (#1453)', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('drops what left the view and arms what entered', async () => {
    stubServer()
    const { deps, cpuRegions, pan } = makeDeps(MID_ATLANTIC)
    await loadDeclaredCoverage(deps, 'currents', CATALOGUE_URL)
    expect(cpuRegions()).toEqual(['cbofs', 'dbofs'])

    pan(SF_BAY)
    await syncCoverageResidency(deps, 'currents')
    expect(cpuRegions()).toEqual(['sfbofs'])
  })

  it('a cell already resident is not re-fetched when the view merely shifts', async () => {
    const { calls } = stubServer()
    const { deps, pan } = makeDeps(MID_ATLANTIC)
    await loadDeclaredCoverage(deps, 'currents', CATALOGUE_URL)
    const before = calls.filter((u) => u.endsWith('cbofs.h5')).length
    expect(before).toBeGreaterThan(0)

    pan([-76.4, 37.6, -74.6, 39.4]) // same two domains, slightly moved
    await syncCoverageResidency(deps, 'currents')
    expect(calls.filter((u) => u.endsWith('cbofs.h5')).length).toBe(before)
  })

  it('an unreachable cell does not cost its neighbours — a later move retries it', async () => {
    stubServer({ unreachable: new Set(['https://example.com/s111/cells/cbofs.h5']) })
    const { deps, cpuRegions } = makeDeps(MID_ATLANTIC)

    const { logs } = await withCapturedLog(() =>
      loadDeclaredCoverage(deps, 'currents', CATALOGUE_URL),
    )
    expect(cpuRegions()).toEqual(['dbofs']) // the neighbour still drew
    expect(logs.some((l) => l.includes('cbofs'))).toBe(true)
  })
})

describe('ONE residency authority: the renderer’s GPU byte budget (#1453)', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('the budget bounds the resident set, and the CPU map follows it exactly', async () => {
    stubServer()
    // A budget that fits one region: arming dbofs evicts cbofs, which the driver hears.
    const { deps, renderer, cpuRegions } = makeDeps(MID_ATLANTIC, 1)
    await loadDeclaredCoverage(deps, 'currents', CATALOGUE_URL)

    // cbofs, not dbofs. This expectation used to read `['dbofs']` — whichever was armed LAST
    // — which was the bug the live render gate found: the LRU evicts least-recently-armed,
    // and arms go most-relevant-first, so the cell the viewport most wants was the one thrown
    // out. The overflowing arm is backed out now, so the survivor is the most relevant cell.
    expect(renderer.residentRegions()).toEqual(['cbofs'])
    expect(cpuRegions()).toEqual(renderer.residentRegions())
  })

  it('THE PREFIX INVARIANT: the budget evicting the MOST relevant cell is backed out', async () => {
    // Found by the live render gate: over San Francisco the resident set came back as
    // `["wcofs"]` — the basin-wide cell — with `sfbofs`, the local one the viewport actually
    // wanted, evicted. Recency and relevance run in OPPOSITE directions: arms go
    // most-relevant-first, so the most relevant cell is the least-recently-armed and is
    // exactly what the LRU throws out. The frame went from 45% painted to 2%.
    const { calls } = stubServer({
      doc: catalogueDoc([
        ['sfbofs', [-123.2, 36.9, -121.3, 38.5]], // local — smaller bbox wins the tie
        ['wcofs', [-134.0, 30.0, -117.0, 49.0]], // basin-wide, same overlap over SF
      ]),
    })
    const { deps, renderer, cpuRegions } = makeDeps(SF_BAY, 1) // budget fits exactly one
    await loadDeclaredCoverage(deps, 'currents', CATALOGUE_URL)

    // The LOCAL cell must be what survives, not whichever was armed last.
    expect(cpuRegions()).toEqual(['sfbofs'])
    expect(renderer.residentRegions()).toEqual(['sfbofs'])
    // wcofs was tried (that is how the budget spoke) and then backed out.
    expect(calls.some((u) => u.endsWith('wcofs.h5'))).toBe(true)
  })

  it('the driver STOPS arming once the budget evicts something it still wants', async () => {
    const { calls } = stubServer({
      doc: catalogueDoc([
        ['cbofs', [-77.3, 36.0, -74.9, 39.6]], // overlap 3.2 deg² — most relevant
        ['dbofs', [-75.9, 38.0, -74.2, 40.5]], // overlap 2.1 deg²
        ['sliver', [-74.6, 37.5, -74.5, 37.6]], // overlap 0.01 deg² — least relevant
      ]),
    })
    const { deps } = makeDeps(MID_ATLANTIC, 1)
    await loadDeclaredCoverage(deps, 'currents', CATALOGUE_URL)

    // cbofs armed, dbofs armed → cbofs evicted → the budget has spoken, so the third and
    // least relevant cell is never requested. Predicting this with a byte budget up here
    // would mean counting FILE bytes against the renderer's GPU bytes.
    expect(calls.some((u) => u.endsWith('cbofs.h5'))).toBe(true)
    expect(calls.some((u) => u.endsWith('dbofs.h5'))).toBe(true)
    expect(calls.some((u) => u.endsWith('sliver.h5'))).toBe(false)
  })

  it('a re-resolve over the SAME cells fetches NOTHING more — no thrash', async () => {
    const { calls } = stubServer()
    const { deps, cpuRegions } = makeDeps(MID_ATLANTIC, 1)
    await loadDeclaredCoverage(deps, 'currents', CATALOGUE_URL)
    const settled = cpuRegions()
    const before = calls.filter((u) => u.endsWith('.h5')).length

    // Counting EVERY cell fetch, not just cbofs': the back-out re-arms the victim, so a
    // per-cell count moves for a legitimate reason. What must not move is the total across a
    // second resolve of the SAME viewport — that would be the budget-boundary thrash.
    await syncCoverageResidency(deps, 'currents')
    expect(calls.filter((u) => u.endsWith('.h5')).length).toBe(before)
    expect(cpuRegions()).toEqual(settled)
  })

  it('a CHANGED wanted set lifts the suppression — that is the only event that makes room', async () => {
    const { calls } = stubServer()
    const { deps, pan } = makeDeps(MID_ATLANTIC, 1)
    await loadDeclaredCoverage(deps, 'currents', CATALOGUE_URL)
    const before = calls.filter((u) => u.endsWith('cbofs.h5')).length

    pan(SF_BAY) // different set entirely
    await syncCoverageResidency(deps, 'currents')
    pan(MID_ATLANTIC) // and back
    await syncCoverageResidency(deps, 'currents')
    expect(calls.filter((u) => u.endsWith('cbofs.h5')).length).toBeGreaterThan(before)
  })
})

describe('a resolve whose viewport moved on must not land (#1453)', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('THE STALE ARM: a cell fetched for the OLD view is dropped, not armed', async () => {
    // Found by the LIVE RENDER GATE, not by a unit test: panning Chesapeake → San Francisco
    // left DELAWARE resident and the screen empty. The epoch guard cannot catch this — it is
    // per REGION, and dbofs' read was never superseded by another dbofs read. What changed is
    // that nobody WANTS dbofs any more, which is a different question entirely.
    //
    // The race needs a real gap in the cell fetch, which is why the ordinary stub (instant)
    // could not reproduce it: `hold` blocks cbofs' read until the pan has been resolved.
    const { release } = stubServer({ hold: 'cbofs.h5' })
    const { deps, pan, cpuRegions } = makeDeps(MID_ATLANTIC)

    // 1. Start the mid-Atlantic resolve. It reaches cbofs' fetch and blocks there.
    const inFlight = loadDeclaredCoverage(deps, 'currents', CATALOGUE_URL)
    await vi.waitFor(() => expect(deps.catalogues.get('currents')?.inFlight.size).toBe(1))

    // 2. The camera moves a continent away and that resolve completes.
    pan(SF_BAY)
    await syncCoverageResidency(deps, 'currents')

    // 3. Only now does the Chesapeake cell arrive.
    release()
    await inFlight

    // It must NOT be armed: an Atlantic domain over San Francisco draws nothing and costs a
    // GPU slot the wanted cell needs.
    expect(cpuRegions()).toEqual(['sfbofs'])
  })

  it('the stale loop STOPS rather than working through the old wanted list', async () => {
    const { calls, release } = stubServer({ hold: 'cbofs.h5' })
    const { deps, pan } = makeDeps(MID_ATLANTIC)
    const inFlight = loadDeclaredCoverage(deps, 'currents', CATALOGUE_URL)
    await vi.waitFor(() => expect(deps.catalogues.get('currents')?.inFlight.size).toBe(1))
    pan(SF_BAY)
    await syncCoverageResidency(deps, 'currents')
    release()
    await inFlight
    // cbofs' read had already started and cannot be recalled; dbofs' had not, and must never
    // start — the viewport it was wanted for is gone.
    expect(calls.some((u) => u.endsWith('dbofs.h5'))).toBe(false)
  })
})

describe('a `url:` that is neither a cell nor a catalogue fails LOUDLY (#1453)', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('names the source and arms nothing — never a silent empty coverage', async () => {
    stubServer({ doc: { hello: 'world' } })
    const { deps, cpuRegions } = makeDeps(MID_ATLANTIC)

    const { logs } = await withCapturedLog(() =>
      loadDeclaredCoverage(deps, 'currents', CATALOGUE_URL),
    )
    expect(cpuRegions()).toEqual([])
    expect(logs.join('\n')).toMatch(/coverage source "currents".*ItemCollection/s)
  })

  it('an unreachable URL is isolated, not fatal — the rest of the scene keeps drawing', async () => {
    stubServer({ unreachable: new Set([CATALOGUE_URL]) })
    const { deps, cpuRegions } = makeDeps(MID_ATLANTIC)
    const { logs } = await withCapturedLog(() =>
      loadDeclaredCoverage(deps, 'currents', CATALOGUE_URL),
    )
    expect(cpuRegions()).toEqual([])
    expect(logs.join('\n')).toMatch(/HTTP 404/)
  })
})
