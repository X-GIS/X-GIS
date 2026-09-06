// ═══ #1578 — a quality flip must RELEASE the drapers it discards ═══
//
// `map.setQuality({msaa})` / `{picking}` fans out to six `rebuildForQuality()` calls, each
// of which dropped its draper by nulling the reference. Every dropped draper owned a
// `Material` (pipelines + a global uniform + pool buffers) and, for three of them, samplers
// — and nothing released any of it. `RhiDevice.destroyPipeline` had zero production callers
// repo-wide; its siblings `destroyBuffer` / `destroySampler` are called from text, icon and
// heatmap, so this was an omission rather than a policy.
//
// Two gates, each on ONE mechanism:
//
//   1. behavioural — a real `RasterRenderer` really calls `destroy()` on the draper it
//      drops, and really builds a fresh one afterwards (a release that also broke the
//      rebuild would be a worse bug than the leak).
//   2. structural — every `rebuildForQuality()` in the render layer releases before it
//      drops. This is the one that catches the NEXT draper someone adds, which is the
//      failure mode `destroyPipeline` having zero callers was a symptom of.
//
// The structural gate is path-keyed, so it carries the companion assertion CLAUDE.md §12
// requires: the file set it walks must be non-empty and must still contain every renderer
// named, or a rename leaves it vacuously green.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  installWebGPUStub,
  type StubInstallation,
} from '../../../rhi-webgpu/src/__test-support__/webgpu-stub'
import { initGPU, type GPUContext } from '@xgis/rhi-webgpu'
import { QUALITY, updateQuality, getSampleCount } from '@xgis/engine'
import { RasterRenderer, VectorTileRenderer } from '@xgis/map'
import { XGISMap } from '../map'
import { VectorDrapeRenderer } from './vector-drape-renderer'
import { UnderOccluderRenderer } from './under-occluder-renderer'

const HERE = dirname(fileURLToPath(import.meta.url))

let stub: StubInstallation

beforeEach(() => {
  if (typeof HTMLCanvasElement === 'undefined') {
    ;(globalThis as { HTMLCanvasElement?: unknown }).HTMLCanvasElement = class {
      width = 800
      height = 600
      getContext(): unknown {
        return null
      }
    } as never
  }
  stub = installWebGPUStub()
})
afterEach(() => {
  stub.uninstall()
  vi.restoreAllMocks()
})

async function makeCtx(): Promise<GPUContext> {
  const canvas = { width: 1280, height: 720 } as unknown as HTMLCanvasElement
  Object.setPrototypeOf(canvas, HTMLCanvasElement.prototype)
  return initGPU(canvas) as unknown as Promise<GPUContext>
}

/** The lazy draper accessor + the field it caches into, both private in TS. */
interface RasterSeam {
  ensureRasterDraper(): { destroy(): void }
  _rasterDraper?: object
}

describe('#1578 — rebuildForQuality releases the draper it drops', () => {
  it('calls destroy() on the discarded draper, and still rebuilds a fresh one', async () => {
    const ctx = await makeCtx()
    const renderer = new RasterRenderer(ctx)
    const seam = renderer as unknown as RasterSeam

    const draper = seam.ensureRasterDraper()
    const destroy = vi.spyOn(draper, 'destroy')
    expect(seam._rasterDraper, 'the draper is cached before the flip').toBeDefined()

    renderer.rebuildForQuality()

    // Before the fix the reference was simply nulled — the Material's pipelines, global
    // uniform and pool buffers went unreferenced with nothing to reclaim them, and on
    // WebGL2 that is a linked GL program that is NOT GC-collected.
    expect(destroy, 'the dropped draper must be released').toHaveBeenCalledTimes(1)
    expect(seam._rasterDraper, 'and the reference is dropped').toBeUndefined()

    // CONTROL — the flip still works. A `rebuildForQuality` that destroyed the draper and
    // kept the reference (or failed to rebuild) would satisfy the assertion above while
    // leaving the next frame drawing through freed GPU objects.
    const rebuilt = seam.ensureRasterDraper()
    expect(rebuilt, 'a fresh draper is built at the new quality').not.toBe(draper)
  })
})

describe('#1578 — every renderer that rebuilds for quality also releases', () => {
  const RENDERERS = [
    'raster-renderer.ts',
    'hillshade-renderer.ts',
    'point-renderer.ts',
    'line-renderer.ts',
    'coverage-renderer.ts',
    // hunt 2026-09-02 (#2292): the VTR's globe VectorDrapeRenderer is the sixth
    // sample-count-baked draper and was the one the fan-out never reached.
    'vector-tile-renderer.ts',
  ]

  it('each rebuildForQuality body destroys before it drops', () => {
    let checked = 0
    for (const file of RENDERERS) {
      const src = readFileSync(join(HERE, file), 'utf8')
      const start = src.indexOf('rebuildForQuality(): void {')
      // The companion assertion §12 requires: a path-keyed gate must prove its keys still
      // resolve, or a rename turns it vacuously green.
      expect(
        start,
        `${file} has no rebuildForQuality — renamed? repoint this gate`,
      ).toBeGreaterThan(-1)
      const body = src.slice(start, src.indexOf('\n  }', start))
      expect(body, `${file}: rebuildForQuality must release before dropping`).toMatch(
        /\.destroy\(\)/,
      )
      checked++
    }
    expect(checked, 'no renderer file was skipped').toBe(RENDERERS.length)
  })

  it('and Material still exposes the destroy() they all call', () => {
    // The single authority those six bodies depend on. If it is renamed or removed, the
    // gate above keeps passing against a `.destroy()` that means something else.
    const src = readFileSync(
      join(HERE, '..', '..', '..', 'engine', 'src', 'render', 'material.ts'),
      'utf8',
    )
    expect(src).toMatch(/^ {2}destroy\(\): void \{$/m)
    expect(src, 'and it releases pipelines through the RHI primitive').toContain(
      'this.rhi.destroyPipeline(p)',
    )
  })
})

// ═══ #2292 — the quality flip must also reach the VTR's globe drape ═══
//
// hunt 2026-09-02: `VectorTileRenderer` lazily builds a `VectorDrapeRenderer` with the
// sample count read AT THAT MOMENT (`new VectorDrapeRenderer(rhi, format, getSampleCount())`),
// and that count is BAKED into the RasterDraper's Material pipelines (material.ts →
// `multisample.count`). `setQuality({msaa})` / `{picking}` re-allocates the opaque pass at the
// NEW count (frame-context.ts) but the per-VTR loop in `setQuality` only re-wired bind-group
// layouts and pipelines — the drape survived with 4x pipelines against a 1x pass, which WebGPU
// rejects on `setPipeline`, invalidating the whole opaque pass (a black globe every frame).
describe('#2292 — setQuality releases the VTR globe drape built at the old sample count', () => {
  let msaaBefore: (typeof QUALITY)['msaa']
  let pickingBefore: boolean
  beforeEach(() => {
    msaaBefore = QUALITY.msaa
    pickingBefore = QUALITY.picking
  })
  afterEach(() => {
    updateQuality({ msaa: msaaBefore, picking: pickingBefore })
  })

  /** The VTR's lazily-built drape and the sample count its draper baked. */
  interface VtrSeam {
    _drape: VectorDrapeRenderer | null
  }
  interface DrapeSeam {
    draper: { sampleCount: number; destroy(): void }
  }
  /** The sibling renderers `setQuality` fans out to, stubbed so the real body can run
   *  without a live GPU — the same private-seam pattern the map's own quality tests use. */
  interface MapSeam {
    renderer: unknown
    rasterRenderer: unknown
    hillshadeRenderer: unknown
    coverageRenderer: unknown
    vectorTileShows: unknown[]
    vtSources: Map<string, { source: unknown; renderer: unknown }>
  }

  it('after an msaa 4->1 flip the drape is released, not left at 4x', async () => {
    updateQuality({ picking: false, msaa: 4 })
    expect(getSampleCount()).toBe(4)

    const ctx = await makeCtx()
    const vtr = new VectorTileRenderer(ctx)
    // Exactly what the first globe-drape frame does (vector-tile-renderer.ts `_drape ??=`).
    const drape = new VectorDrapeRenderer(ctx.rhi, ctx.format, getSampleCount())
    ;(vtr as unknown as VtrSeam)._drape = drape
    expect((drape as unknown as DrapeSeam).draper.sampleCount).toBe(4)
    const drapeDestroy = vi.spyOn(drape, 'destroy')

    const map = new XGISMap({ width: 1200, height: 800 } as unknown as HTMLCanvasElement)
    const seam = map as unknown as MapSeam
    const rebuilds = vi.fn()
    seam.renderer = { rebuildForQuality: rebuilds, bindGroupLayout: {} }
    seam.rasterRenderer = { rebuildForQuality: rebuilds }
    seam.hillshadeRenderer = { rebuildForQuality: rebuilds }
    seam.coverageRenderer = { rebuildForQuality: rebuilds }
    seam.vectorTileShows = []
    seam.vtSources.set('globe', { source: {}, renderer: vtr })

    map.setQuality({ msaa: 1 })

    // CONTROL — the flip path really ran (the sibling renderers were rebuilt).
    expect(rebuilds, 'the msaa flip must reach the rebuild fan-out').toHaveBeenCalledTimes(4)
    expect(getSampleCount()).toBe(1)

    // THE CLAIM — the drape must not survive the flip carrying 4x pipelines.
    const after = (vtr as unknown as VtrSeam)._drape
    if (after === drape) {
      expect(
        drapeDestroy,
        'the VTR drape was neither released nor rebuilt by setQuality',
      ).toHaveBeenCalled()
    }
    if (after) {
      expect(
        (after as unknown as DrapeSeam).draper.sampleCount,
        'a drape kept across the flip still carries the OLD sampleCount (its pipelines mismatch the re-allocated pass)',
      ).toBe(getSampleCount())
    }
  })

  it('and the released drape frees its RasterDraper, not just the bake textures', async () => {
    const ctx = await makeCtx()
    const drape = new VectorDrapeRenderer(ctx.rhi, ctx.format, 1)
    const draperDestroy = vi.spyOn((drape as unknown as DrapeSeam).draper, 'destroy')

    drape.destroy()

    // A quality flip is live-session churn, not teardown: the dropped draper's Materials
    // (pipelines + global uniform + pool buffers) and its two samplers must be reclaimed,
    // which is the whole point of #1578's `RasterDraper.destroy()`.
    expect(draperDestroy, 'the drape must release its RasterDraper').toHaveBeenCalledTimes(1)
  })
})

// ═══ #2411 — the seventh baked owner: the under-occluder ═══
//
// Found by the #2292 §5 arm, not by a reader: with the VTR drape fixed, the real
// device still rejected a pipeline after a flip — `Attachment state of
// [RenderPipeline "under-occluder-rhi"] is not compatible with [RenderPassEncoder]`.
// `UnderOccluderRenderer` takes the sample count as a CONSTRUCTOR argument
// (under-occluder-renderer.ts:113) and bakes it into its Material at :156, and its
// ONLY build site is `setBackgroundFill` — so unlike the six renderers above it has
// no `rebuildForQuality()` for the fan-out to reach, and nothing rebuilt it. Present
// on main before this branch: `setQuality` there names `underOccluder` zero times.
describe('#2411 — setQuality rebuilds the under-occluder built at the old sample count', () => {
  let msaaBefore: (typeof QUALITY)['msaa']
  let pickingBefore: boolean
  beforeEach(() => {
    msaaBefore = QUALITY.msaa
    pickingBefore = QUALITY.picking
  })
  afterEach(() => {
    updateQuality({ msaa: msaaBefore, picking: pickingBefore })
  })

  interface OccluderSeam {
    sampleCount: number
    color: [number, number, number, number]
  }
  interface MapOccluderSeam {
    ctx: unknown
    renderer: unknown
    rasterRenderer: unknown
    hillshadeRenderer: unknown
    coverageRenderer: unknown
    vectorTileShows: unknown[]
    underOccluder: UnderOccluderRenderer | null
    _backgroundColor: [number, number, number, number] | null
  }

  it('after an msaa 4->1 flip it carries the LIVE sample count, not the old one', async () => {
    updateQuality({ picking: false, msaa: 4 })
    expect(getSampleCount()).toBe(4)

    const ctx = await makeCtx()
    const map = new XGISMap({ width: 1200, height: 800 } as unknown as HTMLCanvasElement)
    const seam = map as unknown as MapOccluderSeam
    const rebuilds = vi.fn()
    seam.ctx = ctx
    seam.renderer = { rebuildForQuality: rebuilds, bindGroupLayout: {} }
    seam.rasterRenderer = { rebuildForQuality: rebuilds }
    seam.hillshadeRenderer = { rebuildForQuality: rebuilds }
    seam.coverageRenderer = { rebuildForQuality: rebuilds }
    seam.vectorTileShows = []

    // Exactly what setBackgroundFill builds (map.ts:1189).
    const before = new UnderOccluderRenderer(ctx.rhi, ctx.format, getSampleCount())
    before.setColor([0.1, 0.2, 0.3, 1])
    seam.underOccluder = before
    seam._backgroundColor = [0.1, 0.2, 0.3, 1]
    const destroy = vi.spyOn(before, 'destroy')
    expect((before as unknown as OccluderSeam).sampleCount).toBe(4)

    map.setQuality({ msaa: 1 })

    // CONTROL — the flip path really ran, so a green below cannot come from the
    // whole block being skipped.
    expect(rebuilds, 'the msaa flip must reach the rebuild fan-out').toHaveBeenCalledTimes(4)
    expect(getSampleCount()).toBe(1)

    // THE CLAIM.
    expect(destroy, 'the stale under-occluder must be released, not leaked').toHaveBeenCalledTimes(
      1,
    )
    const after = seam.underOccluder
    expect(after, 'and a fresh one must exist for the next frame').not.toBeNull()
    expect(after).not.toBe(before)
    expect(
      (after as unknown as OccluderSeam).sampleCount,
      'an under-occluder kept across the flip binds a pipeline the re-allocated pass rejects',
    ).toBe(getSampleCount())

    // CONTROL — and it is still the background colour, not a default. A rebuild that
    // dropped the colour would satisfy every assertion above and paint the wrong globe.
    expect((after as unknown as OccluderSeam).color).toEqual([0.1, 0.2, 0.3, 1])
  })

  it('does nothing when no background fill is installed', () => {
    // setBackgroundFill(null) leaves both null; the rebuild must not resurrect an
    // occluder the style asked to be gone.
    const map = new XGISMap({ width: 1200, height: 800 } as unknown as HTMLCanvasElement)
    const seam = map as unknown as MapOccluderSeam
    const rebuilds = vi.fn()
    seam.renderer = { rebuildForQuality: rebuilds, bindGroupLayout: {} }
    seam.rasterRenderer = { rebuildForQuality: rebuilds }
    seam.hillshadeRenderer = { rebuildForQuality: rebuilds }
    seam.coverageRenderer = { rebuildForQuality: rebuilds }
    seam.vectorTileShows = []
    seam.underOccluder = null
    seam._backgroundColor = null

    updateQuality({ picking: false, msaa: 4 })
    map.setQuality({ msaa: 1 })

    expect(seam.underOccluder, 'no background fill, no occluder').toBeNull()
  })
})
