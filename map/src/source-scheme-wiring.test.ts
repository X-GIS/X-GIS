// #1985 (ADR-0012 Phase B4) — a source-level `scheme: tms` DECLARED in an `.xgis`
// source block must reach the raster / raster-dem request path and actually flip the
// row that goes into the URL.
//
// The hops, mirroring #1983's maxzoom and #1984's bounds:
//   1. `SourceManager._attachOneSource` puts `scheme` on BOTH tile markers.
//   2. `map.ts` hands the raster marker's scheme to `RasterRenderer.setUrlTemplate`;
//      the DEM marker's goes through `armHillshadeSource` → `setUrlTemplate`.
//   3. Both `render()` bodies pass it to the ONE builder, `tileUrl`.
//
// WHY IT RIDES `setUrlTemplate` rather than a setter of its own: the scheme is a
// property OF the template — it decides what `{y}` means in THAT url. Re-arming a
// different source without a scheme must therefore CLEAR it. A separate setter (the
// shape `setSourceBounds` / `setSourceMaxzoom` take) would leave the previous source's
// flip standing on the new URL, and `map.ts` line 3661's `setUrlTemplate('')` reset
// would not undo it. That stale-flip case is pinned below in both renderers.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  installWebGPUStub,
  type StubInstallation,
} from '../../rhi-webgpu/src/__test-support__/webgpu-stub'
import { wrapWebGpuPass, initGPU, type GPUContext } from '@xgis/rhi-webgpu'
import { SourceManager } from './source-manager'
import { InputStore } from './render/input-store'
import { HillshadeRenderer, armHillshadeSource } from './render/hillshade-renderer'
import { RasterRenderer } from './render/raster-renderer'
import { Camera } from './camera'
import type { RawDataset } from './map-types'
import type { SceneCommands } from './interpreter'
import type { GeoJSONFeatureCollection, CapPoles } from '@xgis/data'

// ─────────────────────────────────────────────────────────────────────────────
// Hop 1 — the source-manager markers carry the declared scheme
// ─────────────────────────────────────────────────────────────────────────────

function makeManager() {
  const rawDatasets = new Map<string, RawDataset>()
  const mgr = new SourceManager({
    rawDatasets,
    inputs: new InputStore(),
    registerVtSource: () => {},
    sourceCRS: new Map<string, string>(),
    geojsonCapPoles: new Map<string, CapPoles>(),
    heatmapPointData: new Map<string, GeoJSONFeatureCollection>(),
    camera: {} as never,
    getCanvas: () => ({ width: 800 }) as never,
    getCtx: () => ({}) as never,
    getRenderer: () => ({}) as never,
    getLineRenderer: () => null,
    invalidate: () => {},
    fitZoomToLonSpan: () => 0,
    runBoundsFitGate: () => false,
    rebuildLayers: () => {},
    teardownSource: () => {},
    fireError: () => {},
    getVtSource: () => null,
    hasVariantSources: () => false,
    deleteFeatureIndex: () => {},
    beginCoverageLoad: () => Promise.resolve(),
  })
  return { mgr, rawDatasets }
}

const load = (over: Partial<SceneCommands['loads'][0]>): SceneCommands['loads'][0] => ({
  name: 'src',
  url: 'https://x/{z}/{x}/{y}.png',
  ...over,
})

const attach = async (l: SceneCommands['loads'][0]) => {
  const { mgr, rawDatasets } = makeManager()
  await mgr._attachOneSource(l, '', {} as never, { fit: false })
  return rawDatasets.get(l.name)
}

describe('#1985 hop 1 — the source-manager markers carry the declared scheme', () => {
  it('raster: the `{ _tileUrl }` marker carries scheme alongside tileSize/maxzoom', async () => {
    const marker = await attach(load({ type: 'raster', tileSize: 256, scheme: 'tms' }))
    expect(marker).toMatchObject({ _tileUrl: 'https://x/{z}/{x}/{y}.png', scheme: 'tms' })
  })

  it('raster-dem: the `_dem` marker carries scheme alongside the DEM decode', async () => {
    const marker = await attach(
      load({ name: 'dem', type: 'raster-dem', encoding: 'terrarium', scheme: 'tms' }),
    )
    expect(marker).toMatchObject({ _dem: true, encoding: 'terrarium', scheme: 'tms' })
  })

  it('the sibling props the same destructure carries are unharmed', async () => {
    // `tileSize` moved into the destructure to keep the raster marker on one line; a
    // typo there would silently un-wire #1983's cover-zoom bias.
    const marker = await attach(load({ type: 'raster', tileSize: 256, maxzoom: 6 }))
    expect(marker).toMatchObject({ tileSize: 256, maxzoom: 6 })
  })

  it('a source that declares no scheme leaves it undefined — xyz, as before', async () => {
    const marker = (await attach(load({ type: 'raster' }))) as { scheme?: string }
    expect(marker.scheme).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Hops 2+3 — the renderers spend it on the real request URL
// ─────────────────────────────────────────────────────────────────────────────
//
// Driven exactly like the #1984 bounds gate: a real RasterRenderer / HillshadeRenderer
// on the WebGPU stub, one `render()` call, and the private `loadTileTexture` replaced by
// a recorder that frees the in-flight slot synchronously so MAX_CONCURRENT_LOADS cannot
// truncate the list under assertion.
//
// WHAT IS ASSERTED, and why it is not the obvious thing. Comparing the SET of requested
// rows between an xyz and a tms render is VACUOUS at this camera: the frustum selects
// the whole z2 grid, and a full grid is its own mirror, so a severed scheme wire fails
// identically to a working one (the §12 "assertion that failed either way"). Instead the
// template carries BOTH tokens — `…/{z}/{x}/{y}-{-y}.png` — and each individual request
// is checked:
//
//   • `{-y}` is the flip of the ORIGINAL row, by definition and independent of scheme;
//   • so under xyz, `y + (-y) === 2^z − 1` and the two are NEVER equal for z ≥ 1
//     (equality needs 2y = 2^z − 1, and the right side is odd);
//   • and under tms, `{y}` substitutes that same flipped row, so the two ARE equal.
//
// That is a per-request property, so it cannot be laundered by which tiles happened to
// be selected, and each half fails with its own message: cutting the scheme wire makes
// the tms arm report "not equal", cutting the `{-y}` substitution leaves a literal brace
// in the URL and reds the "every request substituted" guard.

let stub: StubInstallation

beforeEach(() => {
  if (typeof HTMLCanvasElement === 'undefined') {
    ;(globalThis as { HTMLCanvasElement?: unknown }).HTMLCanvasElement = class {
      width = 800
      height = 600
      getContext(_t: string): unknown {
        return null
      }
    } as never
  }
  stub = installWebGPUStub()
})
afterEach(() => stub.uninstall())

async function makeCtx(): Promise<GPUContext> {
  const canvas = { width: 2000, height: 800 } as unknown as HTMLCanvasElement
  Object.setPrototypeOf(canvas, HTMLCanvasElement.prototype)
  return initGPU(canvas) as unknown as Promise<GPUContext>
}

const W = 2000
const H = 800
const DPR = 1
const ZOOM = 1 // → rasterCoverZoom(1, 256) = 2, so the leaves sit on the z2 grid
const PROJ_TYPE = 0

/** Record every URL a render() actually requests. */
function recorderOn(renderer: { render: unknown }): string[] {
  const seen: string[] = []
  // Raster still owns the load path; hillshade's moved to its DemTileStore
  // (#2268 / D5 INC-0). Resolve whichever object actually owns it — recording the
  // decoy on the wrong object would leave the oracle empty and the assertion
  // vacuous rather than red, which is the failure this comment exists to prevent.
  const priv = ((renderer as unknown as { dem?: unknown }).dem ?? renderer) as {
    loadTileTexture: (url: string, signal: AbortSignal) => Promise<unknown>
    loadingTiles: Map<string, unknown>
  }
  priv.loadTileTexture = (url: string) => {
    seen.push(url)
    priv.loadingTiles.clear()
    return new Promise<unknown>(() => {})
  }
  return seen
}

/** The template both arms request through: `{y}` and `{-y}` side by side, so one URL
 *  carries the whole answer. */
const BOTH = '/{z}/{x}/{y}-{-y}.png'

interface Req {
  z: number
  x: number
  /** what `{y}` substituted */ y: number
  /** what `{-y}` substituted */ negY: number
}

/** Parse the recorded URLs, asserting every placeholder actually substituted. */
function parse(urls: string[]): Req[] {
  expect(urls.length, 'the render requested nothing — the oracle is empty').toBeGreaterThan(0)
  return urls.map((u) => {
    expect(u, 'an unsubstituted placeholder reached the request').not.toContain('{')
    const m = /\/(\d+)\/(\d+)\/(\d+)-(\d+)\.png$/.exec(u)
    expect(m, `unparsable request URL: ${u}`).not.toBeNull()
    return { z: +m![1], x: +m![2], y: +m![3], negY: +m![4] }
  })
}

/** The LEAF request level (z2 at this camera) and the PARENT-FALLBACK level (z1) come
 *  from two SEPARATE `tileUrl` call sites in each renderer. They are asserted apart so a
 *  cut to either site reds its own test instead of both sharing one verdict. */
const LEAF_Z = 2
const PARENT_Z = 1

/** Requests at exactly one pyramid level, with a vacuity guard: a level that produced no
 *  request proves nothing about the call site that would have produced it. */
function atLevel(reqs: Req[], z: number): Req[] {
  const out = reqs.filter((r) => r.z === z)
  expect(
    out.length,
    `no z${z} request — that call site never ran, so nothing is proved`,
  ).toBeGreaterThan(0)
  return out
}

/** `{-y}` is the flip of the ORIGINAL row under BOTH schemes (Leaflet's rule; pinned
 *  exhaustively in data/src/tile-url-row-scheme.test.ts). So per request:
 *
 *    xyz ⇒ `{y}` is the original row       ⇒ y + negY === 2^z − 1  (and y ≠ negY)
 *    tms ⇒ `{y}` is that same flipped row  ⇒ y === negY
 *
 *  For z ≥ 1 the two verdicts are mutually exclusive: y === negY would need
 *  2y = 2^z − 1, and the right side is odd. The xyz arm is what proves `{-y}` really
 *  flips, so the tms arm's equality cannot be satisfied by both tokens being wrong in
 *  the same direction. */
function expectRows(reqs: Req[], scheme: 'xyz' | 'tms'): void {
  for (const r of reqs) {
    const at = `z${r.z}/x${r.x}: {y}=${r.y} {-y}=${r.negY}`
    if (scheme === 'tms') {
      expect(r.y, `${at} — tms did NOT put the bottom-origin row in {y}`).toBe(r.negY)
    } else {
      expect(r.y + r.negY, `${at} — {-y} is not the flip of the {y} row`).toBe(Math.pow(2, r.z) - 1)
      expect(r.y, `${at} — xyz flipped the row substituted for {y}`).not.toBe(r.negY)
    }
  }
}

function drive(ctx: GPUContext, renderer: { render: (...a: never[]) => void }): void {
  const camera = new Camera(0, 0, ZOOM)
  camera.projType = PROJ_TYPE
  const encoder = (
    ctx.device as unknown as {
      createCommandEncoder: () => { beginRenderPass: () => GPURenderPassEncoder }
    }
  ).createCommandEncoder()
  ;(renderer.render as (...a: unknown[]) => void)(
    wrapWebGpuPass(encoder.beginRenderPass()),
    camera,
    PROJ_TYPE,
    0,
    0,
    W,
    H,
    0,
    DPR,
  )
}

function rasterReqs(ctx: GPUContext, scheme?: 'xyz' | 'tms'): Req[] {
  const renderer = new RasterRenderer(ctx)
  renderer.setUrlTemplate(`https://tiles.example.com${BOTH}`, scheme)
  const seen = recorderOn(renderer)
  drive(ctx, renderer)
  return parse(seen)
}

function demReqs(ctx: GPUContext, scheme?: 'xyz' | 'tms'): Req[] {
  const renderer = new HillshadeRenderer(ctx)
  armHillshadeSource(renderer, {
    _tileUrl: `https://dem.example.com${BOTH}`,
    encoding: 'terrarium',
    scheme,
  })
  renderer.setParams({ tileSize: 256 }) // put the DEM on the SAME z2 grid as raster
  const seen = recorderOn(renderer)
  drive(ctx, renderer)
  return parse(seen)
}

describe('#1985 hop 2/3 (raster) — RasterRenderer.render() spends the scheme on the URL', () => {
  it('the xyz arm leaves {y} at the top-origin row (the decoy that makes tms informative)', async () => {
    const reqs = rasterReqs(await makeCtx())
    expectRows(atLevel(reqs, LEAF_Z), 'xyz')
    expectRows(atLevel(reqs, PARENT_Z), 'xyz')
  })

  it('the tms arm flips the row at the LEAF request site', async () => {
    expectRows(atLevel(rasterReqs(await makeCtx(), 'tms'), LEAF_Z), 'tms')
  })

  it('the tms arm flips the row at the PARENT-FALLBACK site too', async () => {
    // Its own test, not a clause of the leaf one: a flip applied only in the leaf loop
    // would draw a MIRRORED coarse tile under a correct leaf while the pyramid streams.
    expectRows(atLevel(rasterReqs(await makeCtx(), 'tms'), PARENT_Z), 'tms')
  })

  it('an omitted scheme is byte-identical to an explicit xyz (the pre-#1985 request set)', async () => {
    const a = rasterReqs(await makeCtx())
      .map((r) => `${r.z}/${r.x}/${r.y}`)
      .sort()
    const b = rasterReqs(await makeCtx(), 'xyz')
      .map((r) => `${r.z}/${r.x}/${r.y}`)
      .sort()
    expect(a).toEqual(b)
  })

  it('re-arming WITHOUT a scheme clears the previous flip (the stale-flip guard)', async () => {
    const ctx = await makeCtx()
    const renderer = new RasterRenderer(ctx)
    renderer.setUrlTemplate(`https://a.example.com${BOTH}`, 'tms')
    renderer.setUrlTemplate(`https://b.example.com${BOTH}`)
    const seen = recorderOn(renderer)
    drive(ctx, renderer)
    expectRows(atLevel(parse(seen), LEAF_Z), 'xyz')
  })
})

describe('#1985 hop 2/3 (raster-dem) — the hillshade twin spends it too', () => {
  it('the xyz DEM arm leaves {y} at the top-origin row (the decoy)', async () => {
    const reqs = demReqs(await makeCtx())
    expectRows(atLevel(reqs, LEAF_Z), 'xyz')
    expectRows(atLevel(reqs, PARENT_Z), 'xyz')
  })

  it('armHillshadeSource threads the marker scheme into the LEAF DEM request', async () => {
    expectRows(atLevel(demReqs(await makeCtx(), 'tms'), LEAF_Z), 'tms')
  })

  it("the DEM PARENT-FALLBACK site flips too (hillshade's own second call site)", async () => {
    expectRows(atLevel(demReqs(await makeCtx(), 'tms'), PARENT_Z), 'tms')
  })

  it('re-arming a DEM without a scheme clears the previous flip', async () => {
    const ctx = await makeCtx()
    const renderer = new HillshadeRenderer(ctx)
    armHillshadeSource(renderer, { _tileUrl: `https://a.example.com${BOTH}`, scheme: 'tms' })
    armHillshadeSource(renderer, { _tileUrl: `https://dem.example.com${BOTH}` })
    renderer.setParams({ tileSize: 256 })
    const seen = recorderOn(renderer)
    drive(ctx, renderer)
    expectRows(atLevel(parse(seen), LEAF_Z), 'xyz')
  })
})
