// ═══ #1153 P1 — run()/runBinary() lifecycle: epoch, parse-first, crash isolation ═══
//
// First end-to-end map.run('xgis 1') tests, driven under installWebGPUStub. The
// stub patches navigator.gpu + canvas.getContext('webgpu') globally, so run()
// reaches a real GPUContext (freshDevices → one counted device per requestDevice,
// each with a per-device destroyed flag). rAF is shimmed to a no-op handle so
// renderLoop can't recurse, and renderFrame is instance-stubbed so an unstubbed
// GPU surface can't trip the 3-strike halt and flip `running` mid-assertion (A11).

import { describe, it, expect, vi, afterEach } from 'vitest'
import { XGISMap } from '@xgis/map'
import { serializeXGB } from '@xgis/compiler'
import { CoverageRenderer } from './render/coverage-renderer'
import { SYNTHETIC_EARTH_SURFACE_SOURCE } from './synthetic-earth-surface-show'
import {
  installWebGPUStub,
  type StubInstallation,
} from '../../rhi-webgpu/src/__test-support__/webgpu-stub'

// Node ships no HTMLCanvasElement; define a minimal one so the stub can patch
// getContext('webgpu') on its prototype (webgpu-stub.test.ts idiom).
function ensureCanvasCtor(): void {
  if (typeof HTMLCanvasElement === 'undefined') {
    ;(globalThis as { HTMLCanvasElement?: unknown }).HTMLCanvasElement = class {
      width = 256
      height = 256
      getContext(_t: string): unknown {
        return null
      }
    } as never
  }
}

function stubCanvas(): HTMLCanvasElement {
  const c = {
    width: 256,
    height: 256,
    clientWidth: 256,
    clientHeight: 256,
    style: {} as CSSStyleDeclaration,
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 256, bottom: 256, width: 256, height: 256 }
    },
    setPointerCapture() {},
    releasePointerCapture() {},
  } as unknown as HTMLCanvasElement
  // The stub patches HTMLCanvasElement.prototype.getContext; set the prototype so
  // getContext resolves to the patched method.
  Object.setPrototypeOf(c, HTMLCanvasElement.prototype)
  return c
}

interface Seam {
  running: boolean
  renderFrame: () => void
  renderLoop: () => void
  _runEpoch: number
  _ctxOwned: boolean
  _loaded: boolean
  ctx: unknown
  vtSources: Map<string, unknown>
  lineRenderer: unknown
  shapeRegistry: unknown
  rawDatasets: Map<string, unknown>
  underOccluder: unknown
}
const seam = (map: XGISMap) => map as unknown as Seam

function makeMap(): XGISMap {
  const map = new XGISMap(stubCanvas())
  seam(map).renderFrame = () => undefined
  return map
}

// Node has no Worker; the geojson tiling pool (data/) spawns one on the attach
// path. A no-op stub lets attach proceed without a real worker — tiles never
// arrive, which is fine (the lifecycle tests assert device/registry accounting,
// not pixels), and A7's stale attach is skipped before any tile matters.
class StubWorker {
  addEventListener(): void {}
  removeEventListener(): void {}
  postMessage(): void {}
  terminate(): void {}
}

let active: StubInstallation | null = null
function install(opts?: Parameters<typeof installWebGPUStub>[0]): StubInstallation {
  ensureCanvasCtor()
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  vi.stubGlobal('Worker', StubWorker)
  active = installWebGPUStub(opts)
  return active
}

afterEach(() => {
  active?.uninstall()
  active = null
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** A deferred device gate: requestDevice(index) parks until release(index). */
function makeGate() {
  const releasers = new Map<number, () => void>()
  const gate = (index: number): Promise<void> =>
    new Promise<void>((resolve) => releasers.set(index, resolve))
  const release = (index: number): void => releasers.get(index)?.()
  return { gate, release }
}

/** Yield a macrotask — drains all pending microtasks (device chain, recovery). */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
async function waitFor(cond: () => boolean, max = 200): Promise<void> {
  for (let i = 0; i < max && !cond(); i++) await tick()
}

const live = (s: StubInstallation): number => s.createdDevices.filter((d) => !d.destroyed).length

/** Count renderLoop entries (the winner boots once; losers never reach it). */
function countRenderLoop(map: XGISMap): () => number {
  let n = 0
  const s = map as unknown as { renderLoop: () => void }
  const orig = s.renderLoop
  s.renderLoop = () => {
    n++
    orig()
  }
  return () => n
}

function geojsonResponse(fc: unknown): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(fc))
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    type: 'basic',
    headers: { get: () => null },
    body: null,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response
}

/** A globalThis.fetch stub whose response is caller-released (deferred load). */
function deferredFetch(fc: unknown = { type: 'FeatureCollection', features: [] }) {
  let resolveFetch!: (r: Response) => void
  const p = new Promise<Response>((res) => {
    resolveFetch = res
  })
  const calls = { n: 0 }
  const fn = vi.fn(async () => {
    calls.n++
    return p
  })
  vi.stubGlobal('fetch', fn)
  return { calls, release: () => resolveFetch(geojsonResponse(fc)) }
}

// A geojson-URL source referenced by a filled layer — this is what actually
// emits a `load` (lowering drops sources with no rendered show), so the attach
// path runs and its safeFetch can be deferred.
const GEOJSON_SRC =
  'xgis 1\nsource s { type: geojson, url: "https://example.com/s.geojson" }\nlayer l { source: s, fill: #ff0000 }'
// Unclosed brace → Parser throws synchronously.
const BAD_SRC =
  'xgis 1\nsource world { type: geojson, url: "w.geojson" }\nlayer land { source: world'
// #1577 — PARSES cleanly, then `lower()` throws (`data:` must be an object literal —
// compiler/src/ir/lower.ts:155). This is the exact shape the leak needed: the parse guard
// that D2/A1 put above the gpuInit kickoff lets it through, so a device IS minted and the
// throw lands in the window between the kickoff and its await.
const LOWER_THROWS_SRC =
  'xgis 1\nsource world { type: geojson, data: "not-an-object" }\nlayer land { source: world, fill: #ff0000 }'

describe('#1153 P1 — boot + soak (T7)', () => {
  it('run("xgis 1") boots to running with exactly one live device; destroy() frees it', async () => {
    const stub = install({ freshDevices: true })
    const map = makeMap()
    await map.run('xgis 1')
    expect(map.loaded()).toBe(true)
    expect(seam(map).running).toBe(true)
    expect(stub.createdDevices).toHaveLength(1)
    expect(live(stub)).toBe(1)
    map.destroy()
    expect(live(stub)).toBe(0)
  })

  // Explicit per-test budget. 20 stubbed boot+destroy cycles run ~13s on this
  // machine; the repo vitest.config sets testTimeout: 30_000 (so the CI/merge-gate
  // invocation — `./node_modules/.bin/vitest run` from the repo root — passes with
  // margin), but a package-scoped `vitest run` launched from runtime/ picks up
  // runtime/vite.config.ts, which carries NO test block and falls back to vitest's
  // 5s default — under which this soak would flake. 60s pins it green regardless of
  // which config is in effect, with generous headroom on a loaded runner.
  it(
    'T7 — ×20 run/destroy soak: every created device destroyed, ≤1 live at the end',
    { timeout: 60_000 },
    async () => {
      const stub = install({ freshDevices: true })
      for (let i = 0; i < 20; i++) {
        const map = makeMap()
        await map.run('xgis 1')
        map.destroy()
      }
      expect(stub.createdDevices).toHaveLength(20)
      expect(stub.createdDevices.every((d) => d.destroyed)).toBe(true)
      expect(live(stub)).toBeLessThanOrEqual(1)
      expect(live(stub)).toBe(0)
    },
  )
})

describe('#1153 P1 — re-entry race (T1) + no double boot (T14)', () => {
  it('T1 — two overlapping run()s, loser resolves FIRST: exactly one live device, loser disposed', async () => {
    const { gate, release } = makeGate()
    const stub = install({ freshDevices: true, requestDeviceGate: gate })
    const map = makeMap()
    const rl = countRenderLoop(map)
    const runA = map.run('xgis 1') // epoch 1 — superseded (loser)
    const runB = map.run('xgis 1') // epoch 2 — winner
    await waitFor(() => stub.createdDevices.length === 2)
    release(0) // loser A resolves first → stale at G2 → disposes its own device
    await waitFor(() => stub.createdDevices[0]!.destroyed)
    release(1) // winner B publishes
    await Promise.all([runA, runB])
    expect(stub.createdDevices[0]!.destroyed).toBe(true) // loser disposed
    expect(stub.createdDevices[1]!.destroyed).toBe(false) // winner alive == map.ctx
    expect(live(stub)).toBe(1)
    expect(seam(map).running).toBe(true)
    expect(rl()).toBe(1) // only the winner entered renderLoop
  })

  it('T14 — loser resolves LAST: disposes own device, no re-publish/renderLoop, no extra load/error', async () => {
    const { gate, release } = makeGate()
    const stub = install({ freshDevices: true, requestDeviceGate: gate })
    const map = makeMap()
    const rl = countRenderLoop(map)
    const events: string[] = []
    map.on('load', () => events.push('load'))
    map.on('error', () => events.push('error'))
    const runA = map.run('xgis 1') // epoch 1 — loser
    const runB = map.run('xgis 1') // epoch 2 — winner
    await waitFor(() => stub.createdDevices.length === 2)
    release(1) // winner resolves first, fully boots
    await waitFor(() => seam(map).running === true)
    const loadsAfterWinner = events.filter((e) => e === 'load').length
    release(0) // loser resolves LAST
    await Promise.all([runA, runB])
    expect(stub.createdDevices[0]!.destroyed).toBe(true) // loser disposed its OWN device
    expect(live(stub)).toBe(1)
    expect(rl()).toBe(1) // loser never re-entered renderLoop
    expect(loadsAfterWinner).toBe(1)
    expect(events.filter((e) => e === 'load')).toHaveLength(1) // no extra load after winner
    expect(events.filter((e) => e === 'error')).toHaveLength(0)
  })
})

describe('#1153 P1 — stop()/destroy() mid-boot (T2/T3)', () => {
  it('T2 — stop() while requestDevice held: no resurrection; destroy() frees every device (A12)', async () => {
    const { gate, release } = makeGate()
    const stub = install({ freshDevices: true, requestDeviceGate: gate })
    const map = makeMap()
    const rl = countRenderLoop(map)
    const run = map.run('xgis 1')
    await waitFor(() => stub.createdDevices.length === 1) // parked at gate(0)
    map.stop() // bumps epoch → in-flight run dies at its next stale check
    release(0)
    await run
    expect(seam(map).running).toBe(false) // no resurrection
    expect(rl()).toBe(0) // renderLoop never re-entered
    map.destroy() // A12 — the in-flight device is reclaimed here (stop() is not a release API)
    expect(stub.createdDevices.every((d) => d.destroyed)).toBe(true)
    expect(live(stub)).toBe(0)
  })

  it('T3 — destroy() while requestDevice held: device destroyed on resolve, map inert', async () => {
    const { gate, release } = makeGate()
    const stub = install({ freshDevices: true, requestDeviceGate: gate })
    const map = makeMap()
    const rl = countRenderLoop(map)
    const run = map.run('xgis 1')
    await waitFor(() => stub.createdDevices.length === 1)
    map.destroy()
    release(0)
    await run
    expect(rl()).toBe(0)
    expect(seam(map).running).toBe(false)
    expect(live(stub)).toBe(0) // freshly-minted device disposed at the stale guard
  })
})

describe('#1153 P1 — parse-first crash isolation (T4/T12)', () => {
  it('T4/T12 — run(badSource) on a live map: no teardown, no device requested, one boot error', async () => {
    const stub = install({ freshDevices: true })
    const map = makeMap()
    const rhiDestroy = vi.fn()
    // Simulate a live, published scene.
    seam(map).ctx = {
      rhi: { destroy: rhiDestroy, backend: 'webgpu' },
      device: {},
      format: 'bgra8unorm',
    }
    seam(map)._loaded = true
    seam(map)._ctxOwned = true
    const errs: Array<{ phase?: string; fatal?: boolean }> = []
    map.on('error', (e) => errs.push(e))
    await expect(map.run(BAD_SRC)).rejects.toThrow()
    expect(rhiDestroy).not.toHaveBeenCalled() // old scene NOT torn down (parse threw first)
    expect(map.loaded()).toBe(true) // _loaded intact
    expect(stub.createdDevices).toHaveLength(0) // T12 — parse precedes the gpuInit kickoff: no orphan device
    expect(errs).toHaveLength(1)
    expect(errs[0]!.phase).toBe('boot')
    expect(errs[0]!.fatal).toBe(false)
  })

  // ═══ #1577 — a style error AFTER the gpuInit kickoff must not orphan the device ═══
  //
  // T12 above gates the PARSE route, which D2/A1 fixed by moving lex/parse above the
  // kickoff. The route between the kickoff and its await ~300 lines later had no
  // equivalent: that window is linear, with no try/catch/finally, and a resolved
  // GPUContext is reachable ONLY through the promise it holds. A semantically invalid
  // style — parses fine, throws in `lower()` — exited through it, and `ctx` was never set
  // and `_ctxOwned` was false, so the next run's teardown gate skipped the device and
  // `destroy()` freed only the published ctx. One live GPUDevice per failed run, on
  // exactly the workload that produces failed runs: a style editor or live-reload loop.
  it('T12b — a style that parses but fails to LOWER destroys its in-flight device', async () => {
    const stub = install({ freshDevices: true })
    const map = makeMap()

    await expect(map.run(LOWER_THROWS_SRC)).rejects.toThrow(/object literal/)

    // The device really was minted — otherwise this gate proves nothing about disposal.
    await waitFor(() => stub.createdDevices.length === 1)
    expect(stub.createdDevices, 'the kickoff ran before the throw').toHaveLength(1)
    await waitFor(() => live(stub) === 0)
    expect(live(stub), 'and the orphan is destroyed, not leaked').toBe(0)
  })

  it('T12c — the orphan is gone before the NEXT run, and a successful run keeps its own', async () => {
    const stub = install({ freshDevices: true })
    const map = makeMap()

    await expect(map.run(LOWER_THROWS_SRC)).rejects.toThrow()
    await waitFor(() => stub.createdDevices.length === 1)
    await map.run('xgis 1')
    await waitFor(() => stub.createdDevices.length === 2)

    // The point of the identity check in `disposeOrphanedBoot`: device 0 is the orphan and
    // must be dead; device 1 IS `map.ctx` and must be alive. A disposal that destroyed on
    // every error path without comparing identity would kill the running map instead.
    expect(stub.createdDevices[0]!.destroyed, 'the failed run left nothing behind').toBe(true)
    expect(stub.createdDevices[1]!.destroyed, 'the successful run keeps its device').toBe(false)
    expect(live(stub)).toBe(1)

    map.destroy()
    await waitFor(() => live(stub) === 0)
    expect(live(stub), 'destroy() then frees the live one').toBe(0)
  })

  it('T4 (runBinary mirror) — runBinary(corrupt) on a live map: no teardown, no device, one boot error', async () => {
    const stub = install({ freshDevices: true })
    const map = makeMap()
    const rhiDestroy = vi.fn()
    seam(map).ctx = {
      rhi: { destroy: rhiDestroy, backend: 'webgpu' },
      device: {},
      format: 'bgra8unorm',
    }
    seam(map)._loaded = true
    seam(map)._ctxOwned = true
    const errs: Array<{ phase?: string; fatal?: boolean }> = []
    map.on('error', (e) => errs.push(e))
    const corrupt = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer // bad magic
    await expect(map.runBinary(corrupt)).rejects.toThrow()
    expect(rhiDestroy).not.toHaveBeenCalled()
    expect(map.loaded()).toBe(true)
    expect(stub.createdDevices).toHaveLength(0)
    expect(errs).toHaveLength(1)
    expect(errs[0]!.phase).toBe('boot')
    expect(errs[0]!.fatal).toBe(false)
  })
})

describe('#1153 P1 — published-then-stale reclaim (T10) + stale load isolation (T9)', () => {
  it('T10 — stop() after publish then run() again: first device reclaimed by the 2nd run’s teardown', async () => {
    const stub = install({ freshDevices: true })
    const deferred = deferredFetch()
    const map = makeMap()
    const runA = map.run(GEOJSON_SRC) // publishes device 0, then parks at the deferred load
    await waitFor(() => seam(map)._ctxOwned === true && deferred.calls.n >= 1)
    expect(stub.createdDevices).toHaveLength(1)
    map.stop() // post-publication stop: device 0 stays _ctxOwned, running/_loaded stay false
    deferred.release()
    await runA
    // A returned via a post-publication stale guard: never set running/_loaded.
    expect(seam(map).running).toBe(false)
    expect(map.loaded()).toBe(false)
    expect(live(stub)).toBe(1) // device 0 still live — only _ctxOwned can reclaim it
    vi.unstubAllGlobals() // drop the deferred fetch; the 2nd run has no loads
    vi.stubGlobal('requestAnimationFrame', () => 1)
    await map.run('xgis 1') // entry teardown fires via _ctxOwned → destroys device 0
    expect(stub.createdDevices[0]!.destroyed).toBe(true) // reclaimed by the 2nd run
    expect(stub.createdDevices).toHaveLength(2)
    expect(live(stub)).toBe(1) // only device 1
  })

  it('T9 — a superseded run’s load-attach writes nothing into the winner’s vtSources', async () => {
    const stub = install({ freshDevices: true })
    const deferred = deferredFetch()
    const map = makeMap()
    const runA = map.run(GEOJSON_SRC) // publishes, parks at its deferred load
    await waitFor(() => deferred.calls.n >= 1)
    const runB = map.run('xgis 1') // supersedes A while A is parked in its loads
    await runB
    expect(seam(map).running).toBe(true) // winner booted
    deferred.release() // A’s attach settles AFTER the winner’s teardown
    await runA
    expect(seam(map).vtSources.has('s')).toBe(false) // A7 — A’s dead entry never registered
    expect(map.loaded()).toBe(true) // winner scene intact
    expect(live(stub)).toBe(1)
  })
})

describe('#1153 P1 — device-lost recovery vs user run race (T11)', () => {
  it('T11 — a genuine loss then run(newSource): the old-source recovery closure no-ops (arm-epoch)', async () => {
    const stub = install({ freshDevices: true })
    const map = makeMap()
    await map.run('xgis 1') // device 0, armed recovery armEpoch = 1
    const ctx0 = seam(map).ctx as { onDeviceLostInternal?: (i: unknown) => void }
    // Fire a genuine loss (reason != 'destroyed') → queues the recovery microtask.
    ctx0.onDeviceLostInternal!({ reason: 'unknown', message: 'gpu gone' })
    const runB = map.run('xgis 1') // supersede BEFORE the recovery microtask drains
    await runB
    await tick() // drain the queued recover() — must no-op under A6
    expect(stub.createdDevices).toHaveLength(2) // NO 3rd device from a resurrected old-source run
    expect(live(stub)).toBe(1) // only the newer run’s device
    expect(seam(map).running).toBe(true)
  })
})

describe('#1153 P1 — runBinary renderer regeneration (T5, #7)', () => {
  it('runBinary builds lineRenderer + shapeRegistry (previously missing / stale)', async () => {
    install({ freshDevices: true })
    const map = makeMap()
    await map.runBinary(serializeXGB({ loads: [], shows: [] }))
    expect(seam(map).lineRenderer).toBeTruthy() // #7 — runBinary now builds it
    expect(seam(map).shapeRegistry).toBeTruthy()
    map.destroy()
  })

  it('run() → runBinary(): lineRenderer/shapeRegistry are FRESH, not the stale run() instances', async () => {
    install({ freshDevices: true })
    const map = makeMap()
    await map.run('xgis 1')
    const line1 = seam(map).lineRenderer
    const shapes1 = seam(map).shapeRegistry
    expect(line1).toBeTruthy()
    await map.runBinary(serializeXGB({ loads: [], shows: [] }))
    expect(seam(map).lineRenderer).toBeTruthy()
    // Pre-fix runBinary never rebuilt these, so they'd stay the run() instances
    // bound to the now-destroyed run() device.
    expect(seam(map).lineRenderer).not.toBe(line1)
    expect(seam(map).shapeRegistry).not.toBe(shapes1)
    map.destroy()
  })
})

describe("#1153 P1 — runBinary mid-loop staleness (T15, G3')", () => {
  it('a supersession after the first fetch stops the loop before the 2nd set + rebuildLayers', async () => {
    install({ freshDevices: true })
    vi.stubGlobal('fetch', async () => geojsonResponse({ type: 'FeatureCollection', features: [] }))
    const map = makeMap()
    const xgb = serializeXGB({
      loads: [
        { name: 'a', url: 'https://example.com/a.geojson' },
        { name: 'b', url: 'https://example.com/b.geojson' },
      ],
      shows: [],
    })
    const rd = seam(map).rawDatasets
    const origSet = Map.prototype.set.bind(rd)
    let bumped = false
    ;(rd as unknown as { set: (k: string, v: unknown) => unknown }).set = (k, v) => {
      const r = origSet(k, v)
      if (!bumped) {
        bumped = true
        map.stop() // supersede mid-loop (bumps the epoch)
      }
      return r
    }
    const rebuild = vi.spyOn(map as unknown as { rebuildLayers: () => void }, 'rebuildLayers')
    await map.runBinary(xgb)
    expect(rd.has('a')).toBe(true) // first load stored
    expect(rd.has('b')).toBe(false) // G3' stopped the loop before the 2nd rawDatasets.set
    expect(rebuild).not.toHaveBeenCalled() // stale run returned before rebuildLayers
  })
})

// ═══ #1569 — the coverage renderer is released on teardown ═════════════════
//
// `CoverageRenderer.dispose()` existed and had ZERO callers: repo-wide the only
// non-test `.dispose()` in map/src was `flowRenderer`'s. `rhi.destroy()` reclaims
// the GPU half, but not `arms` — a plain JS Map whose CoverageHandle.bands carry
// the full DECODED grid (an S-102 cell at 1201x1201 f32 is ~5.8 MB per band, one
// handle per resident mosaic region). A host that kept the map object after
// destroy() kept all of it. This drives the real boot path so the assertion is
// about the wiring, not about a hand-built renderer.
describe('#1569 destroy() releases the coverage renderer', () => {
  it('calls coverageRenderer.dispose() exactly once, and again on a scene re-run', async () => {
    const stub = install({ freshDevices: true })
    const spy = vi.spyOn(CoverageRenderer.prototype, 'dispose')
    const map = makeMap()
    await map.run('xgis 1')
    spy.mockClear() // ignore anything the boot itself did

    // A scene swap goes through _teardownForReinit -> _releaseGpuResources, the
    // same shared body destroy() uses — so the release must happen on BOTH paths,
    // which is the whole point of the shared body.
    await map.run('xgis 1')
    expect(spy, 'a re-run releases the previous scene-s coverage renderer').toHaveBeenCalledTimes(1)

    map.destroy()
    expect(spy).toHaveBeenCalledTimes(2)
    expect(live(stub)).toBe(0)
  })
})

// ═══ hunt 2026-09-02 — a re-run() must rebuild the style background on the new device ═══
//
// `_releaseGpuResources()` tore down the synthetic earth-surface catalog + VTR
// (via the vtSources loop) and destroyed the device, but left `_syntheticBackend`
// and `underOccluder` pointing at the dead run. `_installSyntheticEarthSurfaceSource`
// then short-circuited on the stale non-null backend, so run #2 never re-registered
// the source (globe background lost) and kept dispatching the run-#1 occluder
// against the destroyed device.
describe('hunt 2026-09-02 — re-run() keeps a `background { fill }` alive', () => {
  it('second run() re-registers the synthetic earth-surface source + rebuilds the under-occluder', async () => {
    const stub = install({ freshDevices: true })
    const map = new XGISMap(stubCanvas(), { projection: 'globe' })
    seam(map).renderFrame = () => undefined
    const src = 'xgis 1\nbackground { fill: sky-900 }'

    await map.run(src)
    const s = seam(map)
    expect(s.vtSources.has(SYNTHETIC_EARTH_SURFACE_SOURCE)).toBe(true)
    expect(s.rawDatasets.has(SYNTHETIC_EARTH_SURFACE_SOURCE)).toBe(true)
    const occ1 = s.underOccluder
    const rhi1 = (s.ctx as { rhi: unknown }).rhi
    expect(occ1).not.toBeNull()
    // The "not the run-#1 instance" assertion below cannot tell a real teardown
    // from a LEAK: an implementation that only nulls `_syntheticBackend` also
    // builds a second occluder, and the first one's buffers are never released
    // through the RHI. Spy on the run-#1 instance so `_releaseGpuResources`'
    // `underOccluder?.destroy()` is the only implementation that greens this.
    const occ1Destroy = vi.spyOn(occ1 as unknown as { destroy(): void }, 'destroy')

    await map.run(src)
    expect(
      occ1Destroy,
      "the run-#1 under-occluder must be destroyed, not left holding the dead device's buffers",
    ).toHaveBeenCalledTimes(1)
    expect(stub.createdDevices).toHaveLength(2)
    expect(stub.createdDevices[0]!.destroyed).toBe(true)
    expect((s.ctx as { rhi: unknown }).rhi).not.toBe(rhi1) // run #2 owns a fresh device

    expect(
      s.vtSources.has(SYNTHETIC_EARTH_SURFACE_SOURCE),
      'a re-run must re-register the earth-surface source (vtSources)',
    ).toBe(true)
    expect(
      s.rawDatasets.has(SYNTHETIC_EARTH_SURFACE_SOURCE),
      'a re-run must re-seed the earth-surface source (rawDatasets)',
    ).toBe(true)
    expect(
      s.underOccluder,
      'the under-occluder must be rebuilt on the new device, not the run-#1 instance',
    ).not.toBe(occ1)

    map.destroy()
  })
})
