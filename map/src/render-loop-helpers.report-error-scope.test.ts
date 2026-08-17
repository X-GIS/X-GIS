// Audit ⑧ B2 — `reportErrorScope` must surface BOTH validation-error
// outcomes. The bug it fixes: the popErrorScope REJECTION branch was
// `.catch(() => {})`, silently dropping a scope-stack-mismatch / device-lost
// signal. These tests pin that (1) a resolved validation error is logged,
// (2) a resolved `null` (clean frame) logs nothing, and (3) a REJECTED pop
// is logged instead of swallowed.
//
// #1599 adds a SECOND sink to the resolved branch: the message is also queued
// on `ctx._validationErrors`, the shared capped queue the WebGPU
// `uncapturederror` listener and the WebGL2 `takeGlErrors` drain already write,
// so the render loop's per-frame drain can re-emit it as a typed map `'error'`
// event. The final describe below pins which branches write that queue.

import { describe, it, expect, vi, beforeEach } from 'vitest'

import { reportErrorScope } from './render-loop-helpers'
import { xlog } from '@xgis/shared'
import type { RenderContext } from '@xgis/engine'

// Spy on the shared xlog singleton's error() to assert calls without console
// noise. A module-replacement vi.mock('@xgis/shared') binds too late here:
// render-loop-helpers is eagerly loaded by the global projection setup (which
// imports configureProjections from the @xgis/map barrel that now re-exports this
// file), so it captures the REAL xlog before any mock takes effect. xlog is a
// shared singleton object, so spying on its method intercepts render-loop-helpers'
// calls regardless of module load order.
vi.spyOn(xlog, 'error').mockImplementation(() => {})

// The only context member `reportErrorScope` touches is the validation queue —
// the same minimal stand-in rhi-webgpu's own cap test uses for pushValidationError.
const fakeCtx = (): RenderContext => ({ _validationErrors: [] }) as unknown as RenderContext

// reportErrorScope is fire-and-forget — flush the microtask queue so the
// .then/.catch handlers run before we assert.
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

describe('reportErrorScope (Audit ⑧ B2 — un-swallow validation rejections)', () => {
  beforeEach(() => {
    vi.mocked(xlog.error).mockClear()
  })

  it('logs a resolved validation error with the tag', async () => {
    reportErrorScope(Promise.resolve('bind group layout mismatch'), 'pass:fill', fakeCtx())
    await flush()
    expect(xlog.error).toHaveBeenCalledTimes(1)
    const [prefix, msg] = vi.mocked(xlog.error).mock.calls[0]!
    expect(prefix).toContain('pass:fill')
    expect(msg).toBe('bind group layout mismatch')
  })

  it('logs NOTHING on a clean frame (resolves null)', async () => {
    reportErrorScope(Promise.resolve(null), 'frame-validation', fakeCtx())
    await flush()
    expect(xlog.error).not.toHaveBeenCalled()
  })

  it('logs the REJECTION instead of swallowing it', async () => {
    reportErrorScope(
      Promise.reject(new Error('scope stack unbalanced')),
      'frame-validation',
      fakeCtx(),
    )
    await flush()
    expect(xlog.error).toHaveBeenCalledTimes(1)
    const [prefix, msg] = vi.mocked(xlog.error).mock.calls[0]!
    expect(prefix).toContain('frame-validation')
    expect(prefix).toContain('rejected')
    expect(msg).toBe('scope stack unbalanced')
  })

  it('stringifies a non-Error rejection reason', async () => {
    reportErrorScope(Promise.reject('device lost'), 'pass:line', fakeCtx())
    await flush()
    expect(xlog.error).toHaveBeenCalledTimes(1)
    expect(vi.mocked(xlog.error).mock.calls[0]![1]).toBe('device lost')
  })
})

describe('reportErrorScope → ctx._validationErrors (#1599 shared fault sink)', () => {
  beforeEach(() => {
    vi.mocked(xlog.error).mockClear()
  })

  it('queues a RESOLVED validation message, tagged with the pass label', async () => {
    const ctx = fakeCtx()
    reportErrorScope(Promise.resolve('bind group layout mismatch'), 'pass:fill', ctx)
    await flush()
    expect(ctx._validationErrors).toHaveLength(1)
    // The tag rides along so the drained event keeps the pass locality the
    // console line has — a bare message would name no pass.
    expect(ctx._validationErrors[0]!.message).toBe('pass:fill: bind group layout mismatch')
    expect(typeof ctx._validationErrors[0]!.t).toBe('number')
  })

  it('queues NOTHING on a clean frame (resolves null)', async () => {
    const ctx = fakeCtx()
    reportErrorScope(Promise.resolve(null), 'frame-validation', ctx)
    await flush()
    expect(ctx._validationErrors).toEqual([])
  })

  it('does NOT queue a rejected pop — a scope/device condition, not a message', async () => {
    const ctx = fakeCtx()
    reportErrorScope(Promise.reject(new Error('scope stack unbalanced')), 'pass:line', ctx)
    await flush()
    expect(ctx._validationErrors).toEqual([])
    // …but it is still LOGGED (the Audit ⑧ B2 guarantee is untouched).
    expect(xlog.error).toHaveBeenCalledTimes(1)
  })

  it('accumulates one entry per resolved fault across calls', async () => {
    const ctx = fakeCtx()
    reportErrorScope(Promise.resolve('a'), 'pass:fill', ctx)
    reportErrorScope(Promise.resolve('b'), 'pass:line', ctx)
    reportErrorScope(Promise.resolve(null), 'pass:text', ctx)
    await flush()
    expect(ctx._validationErrors.map((e) => e.message)).toEqual(['pass:fill: a', 'pass:line: b'])
  })
})
