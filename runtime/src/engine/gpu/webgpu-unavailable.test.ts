import { describe, it, expect } from 'vitest'
import { initGPU, WebGPUUnavailableError } from '@xgis/rhi-webgpu'
import { installWebGPUStub, type StubInstallation } from '../../__test-support__/webgpu-stub'

// 0.3a: initGPU must classify a genuine WebGPU-absence (no navigator.gpu
// or no adapter) as WebGPUUnavailableError so the map layer can fire
// onWebGPUUnavailable() and degrade gracefully instead of throwing an
// uncaught error to window.onerror.

function bareCanvas(): HTMLCanvasElement {
  if (typeof HTMLCanvasElement === 'undefined') {
    ;(globalThis as { HTMLCanvasElement?: unknown }).HTMLCanvasElement = class {
      width = 8
      height = 8
      getContext(_t: string): unknown {
        return null
      }
    } as never
  }
  const c = { width: 8, height: 8 } as unknown as HTMLCanvasElement
  Object.setPrototypeOf(c, HTMLCanvasElement.prototype)
  return c
}

describe('initGPU WebGPU-unavailable classification', () => {
  it('throws WebGPUUnavailableError when navigator.gpu is absent', async () => {
    // No stub installed → navigator.gpu is undefined in the node env, and
    // initGPU short-circuits before touching the canvas.
    await expect(initGPU(bareCanvas())).rejects.toBeInstanceOf(WebGPUUnavailableError)
  })

  it('does not report unavailable when an adapter is present', async () => {
    const stub: StubInstallation = installWebGPUStub()
    try {
      await expect(initGPU(bareCanvas())).resolves.toBeDefined()
    } finally {
      stub.uninstall()
    }
  })
})
