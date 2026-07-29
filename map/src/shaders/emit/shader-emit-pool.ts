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
import type { EmitInMsg, EmitOutMsg } from './shader-emit-worker'

const done = new Map<string, ShaderSources>()
const inFlight = new Map<string, Promise<ShaderSources>>()
const pending = new Map<number, (s: ShaderSources) => void>()
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
    const resolve = pending.get(m.taskId)
    if (!resolve) return
    pending.delete(m.taskId)
    if (m.kind === 'sources') resolve(m.sources)
    else xlog.error('[shader-emit] worker emit failed', m.message)
  })
  return _worker
}

/** Sources for `req` if they have already arrived. Cheap — call it every frame. */
export function peekShaderSources(req: ShaderEmitRequest): ShaderSources | undefined {
  return done.get(shaderRequestKey(req))
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

  const worker = getWorker()
  const p = worker
    ? new Promise<ShaderSources>((resolve) => {
        const taskId = nextTask++
        pending.set(taskId, resolve)
        const msg: EmitInMsg = { taskId, req, wantWgsl, body: activeBody() }
        worker.postMessage(msg)
      })
    : Promise.resolve(emitFor(req, wantWgsl))

  const tracked = p.then((s) => {
    done.set(key, s)
    inFlight.delete(key)
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
}
