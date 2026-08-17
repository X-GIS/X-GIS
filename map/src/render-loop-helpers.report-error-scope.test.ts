// Audit ⑧ B2 — `reportErrorScope` must surface BOTH validation-error
// outcomes. The bug it fixes: the popErrorScope REJECTION branch was
// `.catch(() => {})`, silently dropping a scope-stack-mismatch / device-lost
// signal. These tests pin that (1) a resolved validation error is logged,
// (2) a resolved `null` (clean frame) logs nothing, and (3) a REJECTED pop
// is logged instead of swallowed.
//
// #1599 adds a SECOND sink to the resolved branch: the tagged message is handed
// to an INJECTED `queueValidation` callback. The render loop passes
// `(msg) => pushValidationError(this.host.ctx, msg)`, which lands the message on
// the shared capped queue the WebGPU `uncapturederror` listener and the WebGL2
// `takeGlErrors` drain already write, so the per-frame drain can re-emit it as a
// typed map `'error'` event. The sink is a parameter and not a RenderContext
// precisely so this helper module holds NO concrete-backend import (#991's
// backend-adapter ratchet) — the final describe below pins which branches call it.

import { describe, it, expect, vi, beforeEach } from 'vitest'

import { reportErrorScope } from './render-loop-helpers'
import { xlog } from '@xgis/shared'

// Spy on the shared xlog singleton's error() to assert calls without console
// noise. A module-replacement vi.mock('@xgis/shared') binds too late here:
// render-loop-helpers is eagerly loaded by the global projection setup (which
// imports configureProjections from the @xgis/map barrel that now re-exports this
// file), so it captures the REAL xlog before any mock takes effect. xlog is a
// shared singleton object, so spying on its method intercepts render-loop-helpers'
// calls regardless of module load order.
vi.spyOn(xlog, 'error').mockImplementation(() => {})

// Recorder standing in for the render loop's `pushValidationError` closure.
function sink(): { queued: string[]; queueValidation: (msg: string) => void } {
  const queued: string[] = []
  return {
    queued,
    queueValidation: (msg) => {
      queued.push(msg)
    },
  }
}
const noSink = (): void => {}

// reportErrorScope is fire-and-forget — flush the microtask queue so the
// .then/.catch handlers run before we assert.
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

describe('reportErrorScope (Audit ⑧ B2 — un-swallow validation rejections)', () => {
  beforeEach(() => {
    vi.mocked(xlog.error).mockClear()
  })

  it('logs a resolved validation error with the tag', async () => {
    reportErrorScope(Promise.resolve('bind group layout mismatch'), 'pass:fill', noSink)
    await flush()
    expect(xlog.error).toHaveBeenCalledTimes(1)
    const [prefix, msg] = vi.mocked(xlog.error).mock.calls[0]!
    expect(prefix).toContain('pass:fill')
    expect(msg).toBe('bind group layout mismatch')
  })

  it('logs NOTHING on a clean frame (resolves null)', async () => {
    reportErrorScope(Promise.resolve(null), 'frame-validation', noSink)
    await flush()
    expect(xlog.error).not.toHaveBeenCalled()
  })

  it('logs the REJECTION instead of swallowing it', async () => {
    reportErrorScope(
      Promise.reject(new Error('scope stack unbalanced')),
      'frame-validation',
      noSink,
    )
    await flush()
    expect(xlog.error).toHaveBeenCalledTimes(1)
    const [prefix, msg] = vi.mocked(xlog.error).mock.calls[0]!
    expect(prefix).toContain('frame-validation')
    expect(prefix).toContain('rejected')
    expect(msg).toBe('scope stack unbalanced')
  })

  it('stringifies a non-Error rejection reason', async () => {
    reportErrorScope(Promise.reject('device lost'), 'pass:line', noSink)
    await flush()
    expect(xlog.error).toHaveBeenCalledTimes(1)
    expect(vi.mocked(xlog.error).mock.calls[0]![1]).toBe('device lost')
  })
})

describe('reportErrorScope → injected validation sink (#1599 shared fault sink)', () => {
  beforeEach(() => {
    vi.mocked(xlog.error).mockClear()
  })

  it('queues a RESOLVED validation message, tagged with the pass label', async () => {
    const s = sink()
    reportErrorScope(Promise.resolve('bind group layout mismatch'), 'pass:fill', s.queueValidation)
    await flush()
    // The tag rides along so the drained event keeps the pass locality the
    // console line has — a bare message would name no pass.
    expect(s.queued).toEqual(['pass:fill: bind group layout mismatch'])
  })

  it('queues NOTHING on a clean frame (resolves null)', async () => {
    const s = sink()
    reportErrorScope(Promise.resolve(null), 'frame-validation', s.queueValidation)
    await flush()
    expect(s.queued).toEqual([])
  })

  it('does NOT queue a rejected pop — a scope/device condition, not a message', async () => {
    const s = sink()
    reportErrorScope(
      Promise.reject(new Error('scope stack unbalanced')),
      'pass:line',
      s.queueValidation,
    )
    await flush()
    expect(s.queued).toEqual([])
    // …but it is still LOGGED (the Audit ⑧ B2 guarantee is untouched).
    expect(xlog.error).toHaveBeenCalledTimes(1)
  })

  it('accumulates one entry per resolved fault across calls', async () => {
    const s = sink()
    reportErrorScope(Promise.resolve('a'), 'pass:fill', s.queueValidation)
    reportErrorScope(Promise.resolve('b'), 'pass:line', s.queueValidation)
    reportErrorScope(Promise.resolve(null), 'pass:text', s.queueValidation)
    await flush()
    expect(s.queued).toEqual(['pass:fill: a', 'pass:line: b'])
  })
})
