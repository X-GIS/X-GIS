import { describe, it, expect } from 'vitest'
import {
  backendProviderChain,
  initGPU,
  initGPUViaProviders,
  makeWebGpuBackendProvider,
  makeWebGl2BackendProvider,
} from './backend-providers'
import { FORCE_GL2, WebGPUUnavailableError, type GPUContext } from './gpu'
import type { RhiBackendProvider } from '@xgis/rhi'
import { WebGl2Device } from '@xgis/rhi-webgl2'

// #795 → #833 M4 — backend precedence is DATA now: `backendProviderChain`
// derives an ordered RhiBackendProvider array from the caller's choice, and
// `initGPUViaProviders` walks it (first passing probe() boots; a passing probe
// whose create() rejects falls back to the next — WebGPU→WebGL2). The old
// `resolveBackend` function authority is retired; these tests pin the same
// precedence contract on the chain CONTENTS, plus the chain-walk semantics.
// In the vitest env there is no window/URL, so `FORCE_GL2` is false — the
// flag=true → [webgl2] arm is covered by the ?forcegl2=1 e2e gates.

function fakeCanvas(gl: unknown): HTMLCanvasElement {
  return {
    width: 8,
    height: 8,
    clientWidth: 8,
    clientHeight: 8,
    getContext(type: string): unknown {
      return type === 'webgl2' ? gl : null
    },
  } as unknown as HTMLCanvasElement
}

// The boot values the composition root would derive from its quality policy
// (#929 B) — any value works for chain-content assertions.
const BOOT = { sampleCount: 4 }
// Composition-root WebGL2 device factory the map layer injects (#834 M5) — the
// test plays that role so a real WebGL2 boot can assemble a WebGl2Device.
const makeWebGl2Device = (gl: WebGL2RenderingContext): WebGl2Device => new WebGl2Device(gl)

describe('backendProviderChain — precedence as data (#833 M4)', () => {
  it('an explicit backend pins a single-provider chain, independent of ?forcegl2', () => {
    expect(backendProviderChain('webgpu', BOOT).map((p) => p.id)).toEqual(['webgpu'])
    expect(backendProviderChain('webgl2', BOOT).map((p) => p.id)).toEqual(['webgl2'])
  })

  it("'auto' chains WebGPU→WebGL2 (fallback) when the ?forcegl2 override is off", () => {
    expect(FORCE_GL2).toBe(false) // vitest env: no window/URL flag
    expect(backendProviderChain('auto', BOOT).map((p) => p.id)).toEqual(['webgpu', 'webgl2'])
  })

  it("'auto' tracks the FORCE_GL2 override (the ONLY consumer of the flag)", () => {
    expect(backendProviderChain('auto', BOOT).map((p) => p.id)).toEqual(
      FORCE_GL2 ? ['webgl2'] : ['webgpu', 'webgl2'],
    )
  })

  it('exports the two real providers with their backend identities', () => {
    expect(makeWebGpuBackendProvider(BOOT).id).toBe('webgpu')
    expect(makeWebGl2BackendProvider(makeWebGl2Device).id).toBe('webgl2')
  })
})

describe('initGPUViaProviders — chain-walk semantics (#833 M4)', () => {
  const booted = { rhi: { backend: 'webgl2' } } as unknown as GPUContext
  const provider = (
    id: 'webgpu' | 'webgl2',
    probe: boolean,
    log: string[],
  ): RhiBackendProvider<GPUContext> => ({
    id,
    probe: async () => (log.push(`probe:${id}`), probe),
    create: async () => (log.push(`create:${id}`), booted),
  })

  it('the first provider whose probe passes boots; later providers are never probed', async () => {
    const log: string[] = []
    const ctx = await initGPUViaProviders(fakeCanvas({}), [
      provider('webgpu', true, log),
      provider('webgl2', true, log),
    ])
    expect(ctx).toBe(booted)
    expect(log).toEqual(['probe:webgpu', 'create:webgpu'])
  })

  it('a failed probe falls through to the next provider', async () => {
    const log: string[] = []
    const ctx = await initGPUViaProviders(fakeCanvas({}), [
      provider('webgpu', false, log),
      provider('webgl2', true, log),
    ])
    expect(ctx).toBe(booted)
    expect(log).toEqual(['probe:webgpu', 'probe:webgl2', 'create:webgl2'])
  })

  it('a passing probe whose create() REJECTS falls back to the next provider', async () => {
    const log: string[] = []
    const failing: RhiBackendProvider<GPUContext> = {
      id: 'webgpu',
      probe: async () => (log.push('probe:webgpu'), true),
      create: async () => {
        log.push('create:webgpu')
        throw new Error('adapter-null') // the real WebGPU boot failure
      },
    }
    const ctx = await initGPUViaProviders(fakeCanvas({}), [failing, provider('webgl2', true, log)])
    expect(ctx).toBe(booted) // fell back to WebGL2 instead of dead-ending
    expect(log).toEqual(['probe:webgpu', 'create:webgpu', 'probe:webgl2', 'create:webgl2'])
  })

  it('an explicit single-provider chain whose create() rejects fails loud (no fallback)', async () => {
    const failing: RhiBackendProvider<GPUContext> = {
      id: 'webgpu',
      probe: async () => true,
      create: async () => {
        throw new Error('adapter-null')
      },
    }
    await expect(initGPUViaProviders(fakeCanvas({}), [failing])).rejects.toBeInstanceOf(
      WebGPUUnavailableError,
    )
  })

  it('an exhausted chain throws WebGPUUnavailableError (the graceful-path type)', async () => {
    const log: string[] = []
    await expect(
      initGPUViaProviders(fakeCanvas({}), [provider('webgpu', false, log)]),
    ).rejects.toBeInstanceOf(WebGPUUnavailableError)
  })
})

describe('initGPU — backend construction option (#795)', () => {
  it('boots the WebGL2 backend from the option alone, WITHOUT the ?forcegl2 URL flag', async () => {
    // The exact path XGISMap takes: options.backend → _backend → initGPU(canvas,
    // { backend, makeWebGl2Device }) → [webgl2 provider] → create(). The map
    // injects the WebGl2Device factory (#834 M5); the test supplies the same.
    const ctx = await initGPU(fakeCanvas({} as WebGL2RenderingContext), {
      backend: 'webgl2',
      makeWebGl2Device,
    })
    expect(ctx.rhi?.backend).toBe('webgl2')
    expect(ctx.sampleCount).toBe(1) // slice-1 isolated single-sample topology
  })
})
