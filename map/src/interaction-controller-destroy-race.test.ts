// Lifecycle race: destroy() lands while a pickAt mapAsync readback is in-flight.
//
// BUG: pickAt entry guard passes (ctx non-null), then createCommandEncoder /
// copyTextureToBuffer / queue.submit / mapAsync all run on the device.
// If destroy() fires and nulls the signal DURING that window, the code
// post-await reads getMappedRange() on a buffer whose device is destroyed —
// and the caller (void pickAt, no .catch) surfaces an unhandled rejection.
//
// FIX (two-part, minimal):
//   1. map.ts: `getCtx: () => this._destroyed ? null : this.ctx`
//      (getCtx() returns null once _destroyed=true — the live signal)
//   2. interaction-controller.ts: re-check `this.getCtx()` AFTER the
//      `await mapAsync`; if null (destroy landed), bail with null BEFORE
//      calling getMappedRange / unmap, return null.
//
// TEST: simulate destroy() firing by having mapAsync's resolution flip a flag
// that makes getCtx() return null. Confirm that after the fix pickAt returns
// null and does NOT call getMappedRange on the dead buffer.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { InteractionController, type InteractionControllerDeps } from './interaction-controller'
import type { LayerIdRegistry } from './layer'

// GPUMapMode is a WebGPU browser global absent in vitest — stub it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).GPUMapMode = { READ: 0 }

afterEach(() => vi.restoreAllMocks())

/**
 * Build a minimal controller that simulates the destroy-race scenario.
 *
 * `useFixedGetCtx`: controls whether getCtx() reflects the fix:
 *   false → always returns ctx (buggy: destroy signal invisible post-await)
 *   true  → returns null once `destroyed` is flipped (fixed behaviour)
 *
 * The `mapAsync` mock flips `destroyed=true` before it resolves, simulating
 * destroy() landing during the ~1-frame GPU readback window.
 */
function makeRaceController(useFixedGetCtx: boolean) {
  let destroyed = false

  const getMappedRangeSpy = vi.fn().mockReturnValue(new ArrayBuffer(8))

  // Staging buffer: mapAsync fires destroy signal, then resolves.
  const mockBuffer = {
    mapAsync: vi.fn().mockImplementation(async () => {
      destroyed = true // destroy() races the await window
    }),
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
  const mockTexture = {} as GPUTexture

  const deps: InteractionControllerDeps = {
    camera: {} as never,
    layerIds: { getName: () => null } as unknown as LayerIdRegistry,
    xgisLayers: new Map(),
    rawDatasets: new Map(),
    featureIndex: new Map(),
    // Fixed: return null once destroyed; Buggy: always return ctx.
    getCtx: () => (useFixedGetCtx && destroyed ? null : (mockCtx as never)),
    getPickTexture: () => mockTexture,
    getPickTextureDevice: () => mockDevice as never,
    getProjectionName: () => 'mercator',
    getVectorTileShows: () => [],
  }

  const ctrl = new InteractionController(deps)

  // Pre-inject a staging slot to bypass the createBuffer path
  // (avoids needing GPUBufferUsage global).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(ctrl as any).pickReadbackPool = [{ buf: mockBuffer, inUse: false }]

  return { ctrl, getMappedRangeSpy, mockBuffer, destroyed: () => destroyed }
}

describe('pickAt destroy-race — getMappedRange must not be called after destroy', () => {
  it('FAIL-BEFORE: unfixed code calls getMappedRange on the destroyed buffer', async () => {
    // getCtx always returns ctx (unfixed: destroy signal invisible post-await).
    // mapAsync fires destroy(), but pickAt ignores it and reads getMappedRange.
    const { ctrl, getMappedRangeSpy, destroyed } = makeRaceController(false)

    const result = await ctrl.pickAt(50, 50)

    expect(destroyed()).toBe(true)
    // BUG: getMappedRange IS called on the dead buffer.
    // This expect PASSES on unfixed code, confirming fail-before.
    // After the fix is applied it will FAIL, and we switch to the PASS-AFTER test.
    expect(getMappedRangeSpy).toHaveBeenCalledTimes(1)
    // result is null only because featureId=0/layerId=0 sentinel (zero buffer),
    // not because pickAt detected destroy.
    expect(result).toBeNull()
  })

  it('PASS-AFTER: fixed code returns null without calling getMappedRange after destroy', async () => {
    // getCtx returns null once destroyed=true (fixed closure).
    // After mapAsync resolves, pickAt re-checks getCtx() → null → bail.
    const { ctrl, getMappedRangeSpy, destroyed } = makeRaceController(true)

    const result = await ctrl.pickAt(50, 50)

    expect(destroyed()).toBe(true)
    // FIX: getMappedRange must NOT be called (device is destroyed).
    expect(getMappedRangeSpy).not.toHaveBeenCalled()
    // FIX: pickAt returns null cleanly (no unhandled rejection).
    expect(result).toBeNull()
    // FIX: slot released even on bail path.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((ctrl as any).pickReadbackPool[0].inUse).toBe(false)
  })
})
