// ═══ A pass that replaces a per-host entry must RELEASE the old one (#2337) ═══
//
// `AtmospherePass` and `SceneUpscalePass` keep per-host GPU state keyed on
// (format, sampleCount) — the Material bakes both, so `setQuality({msaa})` and every
// adaptive-ladder notch that changes the scene scale can invalidate an entry mid-session.
// Both replaced the entry by overwriting the map slot, dropping the outgoing Material
// (its pipelines) — and, for atmosphere, its uniform buffer, and for scene-upscale, its
// sampler — with no release call. On WebGL2 those are linked GL programs and GL buffers,
// which JS GC does not reclaim, so repeated quality toggles accumulate them.
//
// `oit-pass.ts:68` (`entry?.draper.destroy()`) is the same contract, in the same directory,
// already followed by the sibling per-host-entry pass. Neither of these two was in
// `quality-flip-releases-drapers.test.ts`'s RENDERERS array (#1578) — that gate covers
// renderers, and these are passes.
//
// This lives in its own file rather than extending that gate because the two are different
// subjects (a pass's entry replacement vs a renderer's `rebuildForQuality`), and the assertion
// here is about a SECOND execute at a different sampleCount, which the ratchet does not model.

import { describe, it, expect, vi } from 'vitest'
import { atmospherePass } from './atmosphere-pass'
import { sceneUpscalePass } from './scene-upscale-pass'
import { makeProjectionToken } from '../projection-token'
import type { FrameContext } from '../frame-context'
import type { SceneView } from '../scene-view'

/** A symmetric perspective matrix — non-degenerate, so `atmosphereCameraRays` yields a
 *  usable ray field and the atmosphere pass actually builds its entry. */
function perspectiveOnly(near: number, far: number, f: number): Float32Array {
  // prettier-ignore
  return new Float32Array([
    f, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0,
  ])
}

/** An RHI stub that COUNTS releases. Everything else is inert; the only modelled facts are
 *  that create/destroy come in pairs and that a destroyed handle is the one that was made. */
function countingRhi() {
  const destroyedPipelines: unknown[] = []
  const destroyedBuffers: unknown[] = []
  const destroyedSamplers: unknown[] = []
  let pipelines = 0
  let buffers = 0
  let samplers = 0
  return {
    destroyedPipelines,
    destroyedBuffers,
    destroyedSamplers,
    counts: () => ({ pipelines, buffers, samplers }),
    rhi: {
      backend: 'webgpu',
      caps: { shaderLanguage: 'wgsl' },
      createBindGroupLayout: () => ({}),
      createPipeline: () => ({ __pipeline: ++pipelines }),
      createBindGroup: () => ({ __bg: true }),
      createBuffer: () => ({ __buf: ++buffers }),
      createSampler: () => ({ __sampler: ++samplers }),
      writeBuffer: () => undefined,
      destroyPipeline: (p: unknown) => destroyedPipelines.push(p),
      destroyBuffer: (b: unknown) => destroyedBuffers.push(b),
      destroySampler: (s: unknown) => destroyedSamplers.push(s),
    },
  }
}

function fakePass() {
  const p = {
    end: () => undefined,
    setPipeline: () => undefined,
    setBindGroup: () => undefined,
    setVertexBuffer: () => undefined,
    draw: () => undefined,
  }
  return p
}

/** A frame context at a given sampleCount. `scene` is smaller than `screen` so the
 *  scene-upscale pass's "scaled pair" precondition holds. */
function makeCtx(sampleCount: number): FrameContext {
  const enc = { beginRenderPass: vi.fn(() => fakePass()), __rhiEncoder: true }
  return {
    rhiEncoder: enc,
    rhiScreenView: { __screen: true },
    rhiColorView: { __color: true },
    rhiStencilView: { __stencil: true },
    rhiSceneResolveView: { __resolve: true },
    rhiColorViewScreen: { __colorScreen: true },
    rhiSceneColorSampleView: { __sceneSample: true },
    passScope: (_l: string, fn: () => void) => fn(),
    projection: makeProjectionToken(7, 20, 30),
    scene: { w: 400, h: 300, dpr: 1 },
    screen: { w: 800, h: 600, dpr: 1 },
    sampleCount,
    useResolve: true,
  } as unknown as FrameContext
}

describe('AtmospherePass — the outgoing entry is released on a sampleCount flip (#2337)', () => {
  function host(rhi: unknown) {
    return {
      _atmosphere: { innerColor: [0.5, 0.7, 1, 0.9], outerColor: [0, 0, 0.1, 0], sky: null },
      camera: {
        globeMode: true,
        getViewForProjection: () => ({
          matrix: perspectiveOnly(1, 100, 1),
          far: 1e7,
          logDepthFc: 1,
        }),
      },
      ctx: { rhi, format: 'bgra8unorm' },
    }
  }

  it('destroys the old Material AND its uniform buffer before building the replacement', () => {
    const c = countingRhi()
    const h = host(c.rhi)
    const scene = {} as unknown as SceneView

    atmospherePass.execute(makeCtx(4), scene, h as never)
    const afterFirst = c.counts()
    expect(afterFirst.pipelines).toBeGreaterThan(0) // the entry really was built
    expect(afterFirst.buffers).toBe(1)
    expect(c.destroyedPipelines).toHaveLength(0)

    atmospherePass.execute(makeCtx(1), scene, h as never)
    // Pre-fix both of these were 0: the entry was overwritten with no release call.
    expect(c.destroyedPipelines.length).toBe(afterFirst.pipelines)
    expect(c.destroyedBuffers).toHaveLength(1)
    // …and the replacement was genuinely built at the new sample count.
    expect(c.counts().pipelines).toBeGreaterThan(afterFirst.pipelines)
    expect(c.counts().buffers).toBe(2)
  })

  it('CONTROL — a REPEAT execute at the same sampleCount releases nothing', () => {
    // Separates "replacement releases" from "every frame destroys and rebuilds", which
    // would be a far worse bug than the leak.
    const c = countingRhi()
    const h = host(c.rhi)
    const scene = {} as unknown as SceneView

    atmospherePass.execute(makeCtx(4), scene, h as never)
    const afterFirst = c.counts()
    atmospherePass.execute(makeCtx(4), scene, h as never)

    expect(c.destroyedPipelines).toHaveLength(0)
    expect(c.destroyedBuffers).toHaveLength(0)
    expect(c.counts().pipelines).toBe(afterFirst.pipelines)
    expect(c.counts().buffers).toBe(1)
  })
})

describe('SceneUpscalePass — the outgoing draper is released on a sampleCount flip (#2337)', () => {
  const host = (rhi: unknown) => ({ ctx: { rhi, format: 'bgra8unorm' } })

  it('destroys the old Material AND its sampler before building the replacement', () => {
    const c = countingRhi()
    const h = host(c.rhi)
    const scene = {} as unknown as SceneView

    sceneUpscalePass.execute(makeCtx(4), scene, h as never)
    const afterFirst = c.counts()
    expect(afterFirst.pipelines).toBeGreaterThan(0)
    expect(afterFirst.samplers).toBe(1)

    sceneUpscalePass.execute(makeCtx(1), scene, h as never)
    // Pre-fix both were 0. The sampler matters as much as the pipeline: this draper is the
    // one that owns one, and `Material.destroy()` alone would not reach it.
    expect(c.destroyedPipelines.length).toBe(afterFirst.pipelines)
    expect(c.destroyedSamplers).toHaveLength(1)
    expect(c.counts().samplers).toBe(2)
  })

  it('CONTROL — a REPEAT execute at the same sampleCount releases nothing', () => {
    const c = countingRhi()
    const h = host(c.rhi)
    const scene = {} as unknown as SceneView

    sceneUpscalePass.execute(makeCtx(4), scene, h as never)
    const afterFirst = c.counts()
    sceneUpscalePass.execute(makeCtx(4), scene, h as never)

    expect(c.destroyedPipelines).toHaveLength(0)
    expect(c.destroyedSamplers).toHaveLength(0)
    expect(c.counts().samplers).toBe(1)
    expect(c.counts().pipelines).toBe(afterFirst.pipelines)
  })
})
