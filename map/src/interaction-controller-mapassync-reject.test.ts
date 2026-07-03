// Issue #597 — pickAt throws "unhandled promise rejection" when mapAsync rejects
// (rapid re-pick on a still-mapped slot, or device-lost).
//
// FIX: interaction-controller.ts pickAt wraps `await slot.buf.mapAsync` in
// try/catch; on rejection the slot is freed (finally runs) and pickAt returns
// null instead of surfacing an unhandled rejection.

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  InteractionController,
  type InteractionControllerDeps,
} from './interaction-controller'
import type { LayerIdRegistry } from './layer'

// GPUMapMode is a WebGPU browser global absent in vitest — stub it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).GPUMapMode = { READ: 0 }

afterEach(() => vi.restoreAllMocks())

/** Build a controller whose staging buffer's mapAsync rejects immediately.
 *  Simulates: rapid re-pick on a still-mapped buffer, or WebGPU device-lost. */
function makeRejectController() {
  const getMappedRangeSpy = vi.fn()

  const mockBuffer = {
    mapAsync: vi.fn().mockRejectedValue(new DOMException('Buffer already mapped', 'OperationError')),
    getMappedRange: getMappedRangeSpy,
    unmap: vi.fn(),
  }

  const mockDevice = {
    createBuffer: vi.fn(),
    createCommandEncoder: vi.fn().mockReturnValue({
      copyTextureToBuffer: vi.fn(),
      finish: vi.fn().mockReturnValue({}),
    }),
    queue: { submit: vi.fn() },
  }

  const mockCanvas = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    width: 100,
    height: 100,
    clientWidth: 100,
  }

  const mockCtx = { device: mockDevice, canvas: mockCanvas }

  const deps: InteractionControllerDeps = {
    camera: {} as never,
    layerIds: { getName: () => null } as unknown as LayerIdRegistry,
    xgisLayers: new Map(),
    rawDatasets: new Map(),
    featureIndex: new Map(),
    getCtx: () => mockCtx as never,
    getPickTexture: () => ({} as GPUTexture),
    getPickTextureDevice: () => mockDevice as never,
    getProjectionName: () => 'mercator',
    getVectorTileShows: () => [],
  }

  const ctrl = new InteractionController(deps)

  // Pre-inject a staging slot to bypass the createBuffer path
  // (avoids needing GPUBufferUsage global).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(ctrl as any).pickReadbackPool = [{ buf: mockBuffer, inUse: false }]

  return { ctrl, getMappedRangeSpy, mockBuffer }
}

describe('pickAt — mapAsync rejection (#597)', () => {
  it('resolves to null (no throw) when mapAsync rejects', async () => {
    const { ctrl } = makeRejectController()

    // Must resolve, not reject — no unhandled promise rejection.
    await expect(ctrl.pickAt(50, 50)).resolves.toBeNull()
  })

  it('does not call getMappedRange after mapAsync rejects', async () => {
    const { ctrl, getMappedRangeSpy } = makeRejectController()

    await ctrl.pickAt(50, 50)

    expect(getMappedRangeSpy).not.toHaveBeenCalled()
  })

  it('frees the slot (inUse=false) after mapAsync rejects', async () => {
    const { ctrl } = makeRejectController()

    await ctrl.pickAt(50, 50)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((ctrl as any).pickReadbackPool[0].inUse).toBe(false)
  })

  it('slot is reusable — a second pickAt call after rejection does not hang', async () => {
    const { ctrl, mockBuffer } = makeRejectController()

    await ctrl.pickAt(50, 50)

    // After the first rejection the slot must be free, so a second call
    // reaches mapAsync again (rather than finding all slots in-use).
    expect(mockBuffer.mapAsync).toHaveBeenCalledTimes(1)
    await ctrl.pickAt(50, 50)
    expect(mockBuffer.mapAsync).toHaveBeenCalledTimes(2)
  })
})
