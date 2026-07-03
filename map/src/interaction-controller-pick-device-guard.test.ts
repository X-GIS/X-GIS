// #792 — pickAt must not issue a cross-device readback in the window between a
// `map.run()` re-init (new GPUDevice) and the first post-swap frame that
// reallocates the pick render-target on that new device.
//
// The pick RT is minted inside `RenderTargets.ensure*` on that class's tracked
// device; after a re-run the context's device swaps but the pick texture is not
// reallocated until the next frame. In that window `getPickTextureDevice()`
// (the RT's device) lags `getCtx().device`, so `copyTextureToBuffer` would copy
// an old-device texture on the new device — WebGPU rejects it. The guard skips
// the readback (returns null, a miss) until the devices agree.

import { describe, it, expect, vi } from 'vitest'
import { InteractionController, type InteractionControllerDeps } from './interaction-controller'
import type { LayerIdRegistry } from './layer'

// WebGPU browser globals absent under vitest — stub what pickAt touches.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).GPUMapMode = { READ: 0 }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).GPUBufferUsage ??= { MAP_READ: 1, COPY_DST: 2 }

const mockCanvas = {
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
  width: 100,
  height: 100,
  clientWidth: 100,
}

function makeController(pickDevice: unknown, ctxDevice: unknown): InteractionController {
  const mockCtx = { device: ctxDevice, canvas: mockCanvas }
  const deps: InteractionControllerDeps = {
    camera: {} as never,
    layerIds: { getName: () => null } as unknown as LayerIdRegistry,
    xgisLayers: new Map(),
    rawDatasets: new Map(),
    featureIndex: new Map(),
    getCtx: () => mockCtx as never,
    getPickTexture: () => ({}) as GPUTexture,
    getPickTextureDevice: () => pickDevice as never,
    getProjectionName: () => 'mercator',
    getVectorTileShows: () => [],
  }
  return new InteractionController(deps)
}

describe('InteractionController.pickAt — device-mismatch guard (#792)', () => {
  it('skips the readback (returns null, no encoder) when the pick texture is on a STALE device', async () => {
    const newDevice = {
      createCommandEncoder: vi.fn(),
      createBuffer: vi.fn(),
      queue: { submit: vi.fn() },
    }
    const oldDevice = { id: 'destroyed-prior-device' }
    const ctrl = makeController(oldDevice, newDevice)

    const r = await ctrl.pickAt(50, 50)

    // Without the guard the code would build a command encoder on the NEW
    // device and copyTextureToBuffer the OLD device's texture — a cross-device
    // copy WebGPU rejects. The guard bails first: null + no encoder.
    expect(r).toBeNull()
    expect(newDevice.createCommandEncoder).not.toHaveBeenCalled()
    expect(newDevice.createBuffer).not.toHaveBeenCalled()
  })

  it('proceeds to the readback when the pick texture device MATCHES the context (steady state)', async () => {
    const device = {
      createBuffer: vi.fn().mockReturnValue({
        mapAsync: vi.fn().mockResolvedValue(undefined),
        getMappedRange: () => new ArrayBuffer(8),
        unmap: vi.fn(),
      }),
      createCommandEncoder: vi.fn().mockReturnValue({
        copyTextureToBuffer: vi.fn(),
        finish: vi.fn().mockReturnValue({}),
      }),
      queue: { submit: vi.fn() },
    }
    // Same device object for both the pick texture and the context.
    const ctrl = makeController(device, device)

    await ctrl.pickAt(50, 50)

    // Guard passed → the readback path ran (encoder built on the live device).
    expect(device.createCommandEncoder).toHaveBeenCalled()
  })
})
