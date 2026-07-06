import { describe, it, expect } from 'vitest'
import {
  backendProviderChain,
  initGPU,
  initGPUViaProviders,
  webGpuBackendProvider,
  webGl2BackendProvider,
} from './backend-providers'
import { FORCE_GL2, WebGPUUnavailableError, type GPUContext } from './gpu'
import type { RhiBackendProvider } from '@xgis/rhi'

// #795 → #833 M4 — backend precedence is DATA now: `backendProviderChain`
// derives an ordered RhiBackendProvider array from the caller's choice, and
// `initGPUViaProviders` walks it (first passing probe() boots). The old
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

describe('backendProviderChain — precedence as data (#833 M4)', () => {
  it('an explicit backend pins a single-provider chain, independent of ?forcegl2', () => {
    expect(backendProviderChain('webgpu').map((p) => p.id)).toEqual(['webgpu'])
    expect(backendProviderChain('webgl2').map((p) => p.id)).toEqual(['webgl2'])
  })

  it("'auto' defaults to the WebGPU chain when the ?forcegl2 override is off", () => {
    expect(FORCE_GL2).toBe(false) // vitest env: no window/URL flag
    expect(backendProviderChain('auto').map((p) => p.id)).toEqual(['webgpu'])
  })

  it("'auto' tracks the FORCE_GL2 override (the ONLY consumer of the flag)", () => {
    expect(backendProviderChain('auto').map((p) => p.id)).toEqual(
      FORCE_GL2 ? ['webgl2'] : ['webgpu'],
    )
  })

  it('exports the two real providers with their backend identities', () => {
    expect(webGpuBackendProvider.id).toBe('webgpu')
    expect(webGl2BackendProvider.id).toBe('webgl2')
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

  it('an exhausted chain throws WebGPUUnavailableError (the graceful-path type)', async () => {
    const log: string[] = []
    await expect(
      initGPUViaProviders(fakeCanvas({}), [provider('webgpu', false, log)]),
    ).rejects.toBeInstanceOf(WebGPUUnavailableError)
  })
})

describe('initGPU — backend construction option (#795)', () => {
  it('boots the WebGL2 backend from the option alone, WITHOUT the ?forcegl2 URL flag', async () => {
    // The exact path XGISMap takes: options.backend → _backend →
    // initGPU(canvas, { backend }) → [webGl2BackendProvider] → create().
    const ctx = await initGPU(fakeCanvas({} as WebGL2RenderingContext), { backend: 'webgl2' })
    expect(ctx.rhi?.backend).toBe('webgl2')
    expect(ctx.sampleCount).toBe(1) // slice-1 isolated single-sample topology
  })
})
