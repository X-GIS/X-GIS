// ═══ WebGl2Device liveness latch (#1570) ═══
//
// WebGPU has a device OBJECT that `destroy()` invalidates: every later call fails by
// spec, and an allocation on a destroyed device allocates nothing. WebGL2 has no such
// object. `WebGl2Device.destroy()` loses the CONTEXT — and `gpu.ts` deliberately hands
// back and RESTORES the same `gl` on a remount, because a per-page context pool is the
// only way a second mount on the same canvas can work at all.
//
// The consequence: a stale `WebGl2Device` stayed fully callable, and its calls landed
// on a context that was alive again — belonging to somebody else. That is why this is
// a LATCH rather than an `isContextLost()` check: at the moment it matters the context
// is not lost.
//
// The reachable path is an in-flight raster/DEM tile fetch (network >> reboot time).
// On resume `rhi.createTexture` no longer threw, bypassing the lost-context catch its
// caller relies on, and the texture landed in a tile cache `buildSceneRenderers` had
// already replaced — unreachable, undrawable, and never evicted, since eviction is
// render-driven and nothing renders that cache any more. Up to MAX_CONCURRENT_LOADS
// per renderer could strand per swap. Failing loud instead is exactly what that
// caller's catch is written for.
//
// It lives in its own module because rhi-webgl2.ts is at its LOC ceiling and this
// reasoning is worth more than the four lines it costs there.

import { stashGl2RestoreToken } from '@xgis/rhi'

export class DeviceLifecycle {
  private _destroyed = false

  /** Latch the device as torn down. Idempotent. */
  markDestroyed(): void {
    this._destroyed = true
  }

  get destroyed(): boolean {
    return this._destroyed
  }

  /** Throw if the device was destroyed — call at every ALLOCATING entry point, so a
   *  stale device cannot mint a GPU resource nothing can reach. */
  assertLive(what: string): void {
    if (this._destroyed)
      throw new Error(
        `webgl2: ${what} on a destroyed device — the context may have been restored for a ` +
          `LATER boot, so this resource would be orphaned (#1570)`,
      )
  }
}

// ── The teardown itself ────────────────────────────────────────────────────
//
// Moved here from WebGl2Device.destroy() (#1570) to pay for the latch above under
// that file's LOC ceiling; the logic is unchanged.

/** Lose the context on an INTENTIONAL teardown, leaving it RESTORABLE (#1153 P2 R3).
 *
 *  The teardown must (a) NOT fire device-lost recovery — that would resurrect a
 *  destroyed map — yet (b) leave the context restorable for a remount on this canvas.
 *  `loseContext()` dispatches `webglcontextlost` as a deferred TASK and the browser
 *  sets `restore_allowed_ = event.defaultPrevented()` at that dispatch; if the event
 *  is not preventDefault'd the context is PERMANENTLY unrestorable, so a remount's
 *  ensure-restored preamble (gpu.ts) would call `restoreContext()` to no-op
 *  (INVALID_OPERATION) and never see `webglcontextrestored` — the exact restorability
 *  invariant the device constructor's lost-handler documents.
 *
 *  So: drop the FAN-OUT listeners (kills recovery — the 'destroyed'-reason analog of
 *  the WebGPU `device.lost` guard) but leave a bare one-shot preventDefault listener
 *  for the deferred loss, self-removing so nothing outlives the teardown. */
export function loseGl2ContextForTeardown(
  gl: WebGL2RenderingContext,
  onLost: EventListener | null | undefined,
  onRestored: EventListener | null | undefined,
): void {
  const canvas = gl.canvas as HTMLCanvasElement | undefined
  if (canvas?.removeEventListener) {
    if (onLost) canvas.removeEventListener('webglcontextlost', onLost)
    if (onRestored) canvas.removeEventListener('webglcontextrestored', onRestored)
    // Only when loseContext() will actually dispatch a NEW loss: an already-lost
    // context dispatches nothing, so a once-listener would leak (never firing) — and
    // its restorability was already set by the natural loss that the fan-out handler
    // preventDefaulted.
    if (canvas.addEventListener && !gl.isContextLost?.())
      canvas.addEventListener('webglcontextlost', (e) => e.preventDefault(), { once: true })
  }
  // #1196 — stash the extension OBJECT before losing: on a lost context getExtension()
  // returns null (WebGL spec), so the remount's ensure-restored preamble can only call
  // restoreContext() through a handle captured pre-loss. The canvas is the identity
  // both boots share.
  const loseExt = gl.getExtension('WEBGL_lose_context')
  if (loseExt && canvas) stashGl2RestoreToken(canvas, loseExt)
  loseExt?.loseContext()
}
