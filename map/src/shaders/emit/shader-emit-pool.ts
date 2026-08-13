// ═══ Shader emit pool — the main thread's client for the emit worker ═══
//
// Two calls, because a draw loop cannot await:
//   • `peekShaderSources` — already here? Then build the pipeline this frame.
//   • `requestShaderSources` — start it (idempotent per key) and draw nothing yet.
//
// A draper that skips a frame while its shader is in flight is not a regression: the
// layer had nothing to draw anyway (its tiles are still in the air), and every frame it
// skips is a frame the rest of the map keeps rendering instead of being frozen inside
// the optimizer fixpoint.
//
// NO-WORKER FALLBACK. Node (every unit test), and any host without `Worker`, emit
// synchronously through the SAME `emitFor` the worker calls. That is not a degradation
// to paper over — it is the only way this seam is testable without a browser, and using
// one dispatch for both is what stops the paths diverging.
//
// The BODY rides on each request rather than being configured once: it is a per-map ctor
// knob that rewrites EARTH_R / EARTH_E2 / WGS84_A / WGS84_E2 into the emitted source as
// literals (measured — Earth and Moon produce different bytes), so a worker primed for
// one map would answer the next one wrongly.

import { activeBody } from '@xgis/shared'
import { xlog } from '@xgis/shared'
import {
  emitFor,
  shaderRequestKey,
  type ShaderEmitRequest,
  type ShaderSources,
} from './shader-emit-request'
import { bodyEpochValue } from '../../body-epoch'
import type { EmitInMsg, EmitOutMsg } from './shader-emit-worker'

/** An emit posted to the worker and not yet answered. The REQUEST is retained beside the
 *  resolver because every failure path settles it through the main-thread `emitFor` — see
 *  `settleOnMainThread`. Without the request there is nothing to fall back TO, which is
 *  how the dropped-resolver bug (#1572 A) survived: the pool stored a bare resolver, so
 *  the only thing an error reply could do with it was throw it away. */
interface PendingEmit {
  readonly resolve: (s: ShaderSources) => void
  readonly req: ShaderEmitRequest
  readonly wantWgsl: boolean
}

const done = new Map<string, ShaderSources>()
const inFlight = new Map<string, Promise<ShaderSources>>()
const pending = new Map<number, PendingEmit>()
let _worker: Worker | null = null
let _workerUnavailable = false
let nextTask = 1

/** The worker, or null when this host has none (node, SSR) or construction failed.
 *  A failure is remembered so a broken bundle costs one attempt, not one per request. */
function getWorker(): Worker | null {
  if (_worker) return _worker
  if (_workerUnavailable || typeof Worker === 'undefined') return null
  try {
    _worker = new Worker(new URL('./shader-emit-worker.ts', import.meta.url), { type: 'module' })
  } catch (err) {
    // Bundler/CSP refusal is a legitimate host state, not a fault: fall back to the
    // synchronous emit rather than leaving every layer permanently blank.
    xlog.debug('[shader-emit] worker unavailable, emitting on the main thread', err)
    _workerUnavailable = true
    return null
  }
  _worker.addEventListener('message', (ev: MessageEvent) => {
    const m = ev.data as EmitOutMsg
    const p = pending.get(m.taskId)
    if (!p) return
    pending.delete(m.taskId)
    if (m.kind === 'sources') p.resolve(m.sources)
    else {
      // #1572 A — the resolver used to be deleted and only logged, so the promise never
      // settled: `inFlight` kept the key forever, `shaderEmitPending()` stayed true for
      // the page lifetime (both keep-rendering predicates pinned hot), and the layer was
      // permanently blank with no retry possible. Settling through the SAME synchronous
      // emit a worker-less host uses turns a failed worker into the documented fallback.
      xlog.error('[shader-emit] worker emit failed, emitting on the main thread', m.message)
      settleOnMainThread(p)
    }
  })
  _worker.addEventListener('error', (ev: ErrorEvent) => {
    // #1572 A — the second half: `try/catch` above covers SYNCHRONOUS construction only,
    // so an async worker-load failure (404'd module chunk on a deploy rollover, CSP
    // block) left `_worker` non-null and every later request posted into a dead worker
    // and hung. All three sibling pools register this listener; this one did not.
    //
    // A worker whose script failed to load never recovers, so it is retired rather than
    // retried: `_workerUnavailable` routes every LATER request straight to the main
    // thread, and the orphans it was holding settle there too.
    xlog.error('[shader-emit] worker failed, falling back to main-thread emit', ev.message)
    _worker = null
    _workerUnavailable = true
    const orphans = [...pending.values()]
    pending.clear()
    for (const p of orphans) settleOnMainThread(p)
  })
  return _worker
}

/** Settle a worker request the worker cannot answer, using the main-thread emit.
 *  Resolving rather than rejecting is deliberate: the sole production caller is
 *  `hillshade-material.ts:87`, which fires this as `void requestShaderSources(...)` every
 *  frame until the sources land, so a rejection here would be an unhandled rejection per
 *  frame — and there is a real answer available, which is strictly better than an error. */
function settleOnMainThread(p: PendingEmit): void {
  p.resolve(emitFor(p.req, p.wantWgsl))
}

/** Sources for `req` if they have already arrived. Cheap — call it every frame. */
export function peekShaderSources(req: ShaderEmitRequest): ShaderSources | undefined {
  return done.get(shaderRequestKey(req))
}

/** How many emits this pool has had to START since page load, published for the render
 *  gate (#1678). The seed count alone proves the artifact was READ; this proves the frame
 *  did not also emit — the difference between "seeded" and "served from the seed", which
 *  is the whole claim of the bake.
 *
 *  COUNTED AT THE DISPATCH, not at `emitFor`. `emitFor` is the ONE dispatch the worker
 *  and the main-thread fallback share, and in a browser the worker is the path that runs
 *  — so a counter on the main-thread call would read 0 in BOTH gate arms and the
 *  comparison would prove nothing (the §12 "assertion that failed either way" trap).
 *  What the pool actually moves is "a request that no cached source could answer", which
 *  is this line, and it counts the worker and the fallback identically. A worker failure
 *  re-settling through `settleOnMainThread` is deliberately NOT counted again: it is the
 *  same emit, recovered, and the question is how many emits the boot needed. */
let emitsStarted = 0
function countEmitStart(): void {
  emitsStarted++
  if (typeof window === 'undefined') return
  // `Object.assign` rather than a `window as unknown as {…}` cast — map/src is under the
  // forced-cast ratchet, and the assignment needs no type hole (see `publishSeedCount`).
  Object.assign(window, { __xgisShaderEmits: emitsStarted })
}

/** Publish sources for `req` that are already KNOWN, so `peekShaderSources` answers on
 *  the very first frame and no emit is ever started (#1678 — the build-time shader bake
 *  seeds every hillshade permutation here at device attach).
 *
 *  This is the pool's only write that does not come from an emit, and it is deliberately
 *  the same `done` map under the same `shaderRequestKey`: a second cache in front of this
 *  one would be a second authority for "which bytes belong to this request", and the
 *  worker / fallback / bake would then be three paths that must agree instead of one.
 *
 *  EPOCH-SCOPED BY CONSTRUCTION. `shaderRequestKey` folds `bodyEpochValue()` (#1568) into
 *  the key, so a later `map.setBody` moves every key and these entries simply stop being
 *  addressable — there is no stale seed to hunt down and drop, and the next boot re-seeds
 *  under the new epoch. Whether the bytes are valid for the live body AT ALL is the
 *  caller's call (`shaders/baked/body-guard.ts`); this function does not second-guess it. */
export function seedShaderSources(req: ShaderEmitRequest, sources: ShaderSources): void {
  done.set(shaderRequestKey(req), sources)
}

/** Start emitting `req` (idempotent per key), off the main thread where possible.
 *  `wantWgsl` is the device capability — a GLSL-only device never pays for the WGSL. */
export function requestShaderSources(
  req: ShaderEmitRequest,
  wantWgsl: boolean,
): Promise<ShaderSources> {
  const key = shaderRequestKey(req)
  const cached = done.get(key)
  if (cached) return Promise.resolve(cached)
  const running = inFlight.get(key)
  if (running) return running

  countEmitStart()
  const worker = getWorker()
  const p = worker
    ? new Promise<ShaderSources>((resolve) => {
        const taskId = nextTask++
        pending.set(taskId, { resolve, req, wantWgsl })
        const msg: EmitInMsg = { taskId, req, wantWgsl, body: activeBody() }
        worker.postMessage(msg)
      })
    : Promise.resolve(emitFor(req, wantWgsl))

  const epoch = bodyEpochValue()
  const tracked = p.then((s) => {
    inFlight.delete(key)
    // The worker path always matches: the body rides on the request, so the bytes belong
    // to the key. A main-thread fallback (#1572 A) emits under whatever body is active
    // WHEN IT RUNS, which a `map.setBody` between post and failure could have moved — and
    // `key` carries the body epoch (#1568), so caching then would serve one planet's
    // shader under another's key. Dropping it costs one re-emit under the new key.
    if (bodyEpochValue() === epoch) done.set(key, s)
    return s
  })
  inFlight.set(key, tracked)
  return tracked
}

/** Is anything still being emitted? The render loop ORs this into its keep-warm gate:
 *  a draper waiting on a shader draws nothing, so without this the loop can go idle with
 *  tiles cached and the layer permanently blank — the same freeze class as a fade ramp
 *  stranded mid-way. */
export function shaderEmitPending(): boolean {
  return inFlight.size > 0
}

/** Drop every cached source. Test-only seam — the process-global body is what makes this
 *  necessary: a suite that emits under one body must not serve those bytes to the next. */
export function _resetShaderEmitCache(): void {
  done.clear()
  inFlight.clear()
  emitsStarted = 0
}
