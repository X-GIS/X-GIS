// ═══ WebGL2 restore-token stash (#1196) ═══
//
// A WebGL2 context is canvas-sticky, and a deliberate device teardown
// (`WebGl2Device.destroy()` → `WEBGL_lose_context.loseContext()`) leaves the
// canvas's ONLY possible context lost. The WebGL spec makes `getExtension()`
// return null on a lost context — so the re-boot's ensure-restored preamble
// (rhi-webgpu gpu.ts) can never re-acquire the extension it needs to call
// `restoreContext()`. The extension OBJECT captured before the loss stays
// functional across the loss, so the destroyer stashes it here, keyed on the
// one identity both boots share: the canvas.
//
// Backend-neutral home (@xgis/rhi) because the WRITER is @xgis/rhi-webgl2 and
// the READER is @xgis/rhi-webgpu's boot path — the two adapters stay mutually
// blind (#929) and meet only on this neutral surface, exactly like
// BackendUnavailableError. The stash survives restore cycles (the same
// context object persists across lose/restore, and its extension object with
// it), so it is written on every destroy and never consumed/cleared.

/** Minimal structural view of WEBGL_lose_context — keeps this module free of
 *  a DOM-lib type that older TS lib configs name inconsistently. */
export interface Gl2RestoreToken {
  restoreContext(): void
  loseContext(): void
}

const KEY = '__xgisGl2RestoreToken'

type Stash = { [KEY]?: Gl2RestoreToken }

/** Called by the WebGL2 device's destroy() BEFORE losing the context. */
export function stashGl2RestoreToken(canvas: unknown, ext: Gl2RestoreToken): void {
  if (canvas && typeof canvas === 'object') (canvas as Stash)[KEY] = ext
}

/** Called by the boot path when `getExtension('WEBGL_lose_context')` returns
 *  null on an already-lost context. */
export function peekGl2RestoreToken(canvas: unknown): Gl2RestoreToken | null {
  if (canvas && typeof canvas === 'object') return (canvas as Stash)[KEY] ?? null
  return null
}
