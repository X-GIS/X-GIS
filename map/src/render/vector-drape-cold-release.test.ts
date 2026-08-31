// ═══ #2093 — the bake cache goes permanently cold, so it must be RELEASED ═══
//
// THE BUG: `VectorDrapeRenderer.beginFrame` frees bakes only through
// `planBakeEvictions`, which returns [] whenever `baked.size <= cap`
// (vector-drape-cache.ts:19) — it TRIMS an over-full cache, it never DRAINS an
// unused one. Before the #2093 LOD ceiling that was enough: on the globe the
// drape ran at every camera, so the cache was always being re-sampled. Past
// `GLOBE_DIRECT_MIN_SELECTION_Z` the direct arm renders every vector layer, so
// nothing re-enters the cache and NOTHING in it can ever be sampled again — yet
// it stays resident at its high-water mark, up to
// `maxCachedEntriesFor(BAKE_BYTES)` = 384 desktop / 96 mobile 512²×4 textures
// (~384 MiB / ~96 MiB of dead VRAM), until `VectorTileRenderer.destroy()`.
//
// THE FIX: `visibleKeys` — already the per-frame record of which bakes were
// draped, and already the eviction skip-set — doubles as the cold signal. An
// empty set at beginFrame means the frame that just ended draped nothing;
// COLD_RELEASE_FRAMES consecutive such frames drop the whole cache through the
// SAME `_retiredBakes` queue the cap eviction uses, so every texture is destroyed
// one frame later (the post-submit safe window), never inside the frame that may
// still reference it.
//
// ORACLE — the real `VectorDrapeRenderer` against the WebGPU stub with synthetic
// cache entries injected through the private surface (same harness as
// `vector-drape-bake-budget.test.ts`; TS `private` is not a runtime barrier, and
// the point is to drive the REAL beginFrame loop). `rhi.destroyTexture` /
// `draper.dropTexture` are spied so the synthetic handles survive and so the
// deferred-destroy ORDER is observable.
//
// ANTI-VACUITY: a release that fired unconditionally would pass the drain
// assertions and destroy a live cache every frame, so the second test drives the
// same number of frames with the drape ACTIVE and requires that nothing is freed.

import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import {
  installWebGPUStub,
  type StubInstallation,
} from '../../../rhi-webgpu/src/__test-support__/webgpu-stub'
import { initGPU, type GPUContext } from '@xgis/rhi-webgpu'
import type { RhiTexture } from '@xgis/engine'
import { VectorDrapeRenderer, COLD_RELEASE_FRAMES } from './vector-drape-renderer'
import { maxCachedEntriesFor } from './raster-cache-budget'

const BAKE_BYTES = 512 * 512 * 4
const RESIDENT = 40

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
  // Desktop viewport — RESIDENT must sit UNDER the byte cap, so the cap eviction
  // can never be what drains the cache (that would make the drain vacuous).
  vi.stubGlobal('window', { innerWidth: 1440 })
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: !q.includes('coarse'), media: q }))
})
afterEach(() => {
  stub.uninstall()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function makeCtx(): Promise<GPUContext> {
  const canvas = { width: 1280, height: 720 } as unknown as HTMLCanvasElement
  Object.setPrototypeOf(canvas, HTMLCanvasElement.prototype)
  return initGPU(canvas) as unknown as Promise<GPUContext>
}

/** The private cache surface `beginFrame()` reads. */
interface DrapePrivates {
  baked: Map<string, { tex: RhiTexture; lastCall: number }>
  visibleKeys: Set<string>
  draper: { dropTexture(tex: RhiTexture): void }
  rhi: { destroyTexture(tex: RhiTexture): void }
  beginFrame(): void
}

async function makeRenderer(resident: number): Promise<{
  r: DrapePrivates
  destroySpy: ReturnType<typeof vi.spyOn>
  dropSpy: ReturnType<typeof vi.spyOn>
}> {
  const ctx = await makeCtx()
  const r = new VectorDrapeRenderer(ctx.rhi, ctx.format, 1) as unknown as DrapePrivates
  for (let i = 0; i < resident; i++) {
    r.baked.set(`water:${i}`, { tex: { id: i } as unknown as RhiTexture, lastCall: i })
  }
  // The synthetic handles are not real GPUTextures; stub the frees (and get the
  // call counts the deferred-destroy assertions need).
  const destroySpy = vi.spyOn(r.rhi, 'destroyTexture').mockImplementation(() => {})
  const dropSpy = vi.spyOn(r.draper, 'dropTexture')
  return { r, destroySpy, dropSpy }
}

describe('#2093 — a cold vector-drape bake cache is released, not held to destroy()', () => {
  it('premise: the resident set sits UNDER the byte cap, so eviction alone frees nothing', () => {
    expect(RESIDENT).toBeLessThan(maxCachedEntriesFor(BAKE_BYTES))
  })

  it('drains to zero after COLD_RELEASE_FRAMES drape-free frames — and not before', async () => {
    const { r, dropSpy } = await makeRenderer(RESIDENT)

    // One frame short of the threshold the cache is still fully resident: the
    // release must not fire on the first stray drape-free frame.
    for (let f = 0; f < COLD_RELEASE_FRAMES - 1; f++) r.beginFrame()
    expect(
      r.baked.size,
      `the cache must survive ${COLD_RELEASE_FRAMES - 1} drape-free frames — a transient ` +
        `(every visible tile mid-reload) must not cost a full re-bake`,
    ).toBe(RESIDENT)

    r.beginFrame()

    expect(
      r.baked.size,
      'a cache nothing can sample any more must be released, not held until destroy()',
    ).toBe(0)
    // The draper's view / bind-group caches are keyed by texture object, so they
    // MUST be invalidated before the texture is freed (raster-material.dropTexture).
    expect(dropSpy).toHaveBeenCalledTimes(RESIDENT)
  })

  it('ANTI-VACUITY — a frame that DID drape evicts nothing, however long it runs', async () => {
    const { r, destroySpy, dropSpy } = await makeRenderer(RESIDENT)

    // Drive 3× the threshold with the drape ACTIVE: renderGlobeFills marks each
    // draped bake in `visibleKeys`, which beginFrame consumes and clears, so the
    // test re-marks one before every frame exactly as a live frame would.
    for (let f = 0; f < COLD_RELEASE_FRAMES * 3; f++) {
      r.visibleKeys.add(`water:${f % RESIDENT}`)
      r.beginFrame()
      expect(r.baked.size, `frame ${f}: an actively-draped cache must never be released`).toBe(
        RESIDENT,
      )
    }
    expect(
      dropSpy,
      'no bake may be dropped from the draper while the drape is live',
    ).not.toHaveBeenCalled()
    expect(
      destroySpy,
      'no bake texture may be destroyed while the drape is live',
    ).not.toHaveBeenCalled()
  })

  it('destruction is DEFERRED one frame — never inside the releasing frame', async () => {
    const { r, destroySpy } = await makeRenderer(RESIDENT)

    for (let f = 0; f < COLD_RELEASE_FRAMES; f++) r.beginFrame()

    expect(
      destroySpy,
      'the releasing frame may only RETIRE: the submit that referenced these bakes has ' +
        'not necessarily drained yet (queue.submit() returning ≠ the GPU being done)',
    ).not.toHaveBeenCalled()

    r.beginFrame()

    expect(destroySpy, 'the NEXT beginFrame drains the retire queue').toHaveBeenCalledTimes(
      RESIDENT,
    )
  })

  it('a drape that RESUMES resets the counter — the next cold frame does not re-release', async () => {
    const { r } = await makeRenderer(RESIDENT)

    // Go cold to one frame short of the release.
    for (let f = 0; f < COLD_RELEASE_FRAMES - 1; f++) r.beginFrame()
    // Draping resumes for one frame.
    r.visibleKeys.add('water:0')
    r.beginFrame()
    // …so the count restarts: this frame must NOT be the release.
    r.beginFrame()

    expect(
      r.baked.size,
      'the cold count must restart on any draped frame, not resume where it left off',
    ).toBe(RESIDENT)
  })
})
