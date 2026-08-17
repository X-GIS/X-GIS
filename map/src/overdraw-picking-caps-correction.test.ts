// ═══ `?debug=overdraw` must not cost picking on a device that cannot run it (#1615) ═══
//
// `quality.ts:resolveQuality()` is evaluated at MODULE LOAD (`export const QUALITY =
// resolveQuality()`), where no `RhiDevice` and no caps exist — and engine must not import
// map, so it cannot reach `isOverdrawActive(caps)` either. It therefore clamps
// `{ msaa: 1, picking: false }` from the URL flag ALONE. That is correct for boot and
// permanent afterwards: on an `executionModel: 'immediate'` device (WebGL2) the overdraw
// compose pass — raw WebGPU — never runs, so `?debug=overdraw&picking=1` draws the ordinary
// scene with picking silently off and nothing revisits the decision. The other 19 flag
// consumers ask `isOverdrawActive(caps)` per read (#1594); this one value is latched, so it
// takes an explicit correction: `reconcileOverdrawQualityClamp(caps)`, run once per device
// boot from `gpu-boot.ts` — the single boot authority `run()` and `runBinary()` share.
//
// FAIL-BEFORE: on pre-fix code `reconcileOverdrawQualityClamp` does not exist and the clamp
// is unconditional, so the WebGL2 arm below reads `picking === false`.
//
// The boot-shaped module re-import (`vi.resetModules()` + a stubbed `window.location`) is
// the idiom from `engine/src/gpu/quality-url-flags.test.ts`: `QUALITY` is a module-load
// value, so a URL flag can only be exercised by re-evaluating the module. Importing once
// and mutating afterwards would test `setQuality()`, a different seam.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

type Caps = { executionModel: string }

/** WebGL2 — immediate execution model, so the overdraw compose pass cannot run. */
const WEBGL2: Caps = { executionModel: 'immediate' }
/** WebGPU — the mode really does engage here, so the clamp is genuinely earned. */
const WEBGPU: Caps = { executionModel: 'deferred' }

async function bootWith(search: string) {
  vi.resetModules()
  vi.stubGlobal('window', { location: { href: `https://x-gis.test/demo.html${search}` } })
  const engine = await import('@xgis/engine')
  const flags = await import('./debug-flags')
  return {
    QUALITY: engine.QUALITY,
    resolveQuality: engine.resolveQuality,
    updateQuality: engine.updateQuality,
    reconcile: flags.reconcileOverdrawQualityClamp,
  }
}

describe('#1615 — the eager ?debug=overdraw clamp is corrected once caps exist', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.unstubAllGlobals())

  it('PREMISE 1: ?picking=1 alone turns picking on', async () => {
    // Non-vacuity for every arm below: if picking were off here too, "the clamp took it"
    // would be indistinguishable from the URL flag never working at all.
    const { QUALITY } = await bootWith('?picking=1')
    expect(QUALITY.picking).toBe(true)
  })

  it('PREMISE 2: ?debug=overdraw clamps picking off at BOOT, before any device', async () => {
    // The over-clamp itself — deliberate, and unchanged by this fix.
    const { QUALITY } = await bootWith('?debug=overdraw&picking=1')
    expect(QUALITY.picking).toBe(false)
    expect(QUALITY.msaa).toBe(1)
  })

  it('the omitted-argument resolve is the boot behaviour verbatim', async () => {
    // The compatibility half of the engine change: `resolveQuality()` with no argument must
    // still produce exactly what `QUALITY` was built from, or every non-overdraw boot moved.
    const { QUALITY, resolveQuality } = await bootWith('?debug=overdraw&picking=1')
    expect(resolveQuality()).toEqual(QUALITY)
  })

  it('THE FIX: on a device that cannot run the mode, picking comes back', async () => {
    const { QUALITY, reconcile } = await bootWith('?debug=overdraw&picking=1')
    reconcile(WEBGL2)
    expect(
      QUALITY.picking,
      'the overdraw compose pass never runs on an immediate device, so the mode is off and ' +
        'its picking clamp is pure loss — ?debug=overdraw&picking=1 on WebGL2 must pick',
    ).toBe(true)
    expect(
      QUALITY.msaa,
      'msaa stays 1: that clamp is a pipeline-variant-matrix cost argument, not a ' +
        'capability one, so the device has no say in it',
    ).toBe(1)
  })

  it('CONTROL: on a device that DOES run the mode, the clamp stands', async () => {
    // A blanket "restore picking" satisfies the arm above while breaking the mode it was
    // written for — the uint pick attachment is exactly what confuses the r16float
    // accumulator routing. This arm is what distinguishes the two.
    const { QUALITY, reconcile } = await bootWith('?debug=overdraw&picking=1')
    reconcile(WEBGPU)
    expect(QUALITY.picking).toBe(false)
    expect(QUALITY.msaa).toBe(1)
  })

  it('restores the URL’s OWN answer, not a blanket on', async () => {
    // No ?picking=1 in the URL ⇒ nothing was taken ⇒ nothing to give back.
    const { QUALITY, reconcile } = await bootWith('?debug=overdraw')
    reconcile(WEBGL2)
    expect(QUALITY.picking).toBe(false)
  })

  it('is idempotent, and re-settles across a re-boot onto another backend', async () => {
    // Called once per device boot (`map.run()` re-boots replace the device wholesale), so it
    // must neither drift on repetition nor fossilise the first device's answer.
    const { QUALITY, reconcile } = await bootWith('?debug=overdraw&picking=1')
    reconcile(WEBGL2)
    reconcile(WEBGL2)
    expect(QUALITY.picking).toBe(true)
    reconcile(WEBGPU)
    expect(QUALITY.picking).toBe(false)
  })

  it('CUT THE MECHANISM: without the flag it touches nothing the host set', async () => {
    // Severing the `DEBUG_OVERDRAW` guard makes this arm fail: `resolveQuality(false).picking`
    // is `true` for this URL, so an unguarded reconcile would resurrect a picking the host had
    // just switched off through `map.setQuality({ picking: false })`.
    const { QUALITY, updateQuality, reconcile } = await bootWith('?picking=1')
    updateQuality({ picking: false })
    reconcile(WEBGL2)
    expect(QUALITY.picking).toBe(false)
  })
})
