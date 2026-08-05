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
import { RasterRenderer } from '@xgis/map'

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
    // The single authority those five bodies depend on. If it is renamed or removed, the
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
