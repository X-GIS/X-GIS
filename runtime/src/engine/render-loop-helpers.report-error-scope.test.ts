// Audit ⑧ B2 — `reportErrorScope` must surface BOTH validation-error
// outcomes. The bug it fixes: the popErrorScope REJECTION branch was
// `.catch(() => {})`, silently dropping a scope-stack-mismatch / device-lost
// signal. These tests pin that (1) a resolved validation error is logged,
// (2) a resolved `null` (clean frame) logs nothing, and (3) a REJECTED pop
// is logged instead of swallowed.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the logger so we can assert on error() calls without console noise.
vi.mock('@xgis/shared', () => ({
  xlog: { error: vi.fn(), warn: vi.fn(), log: vi.fn() },
}))

import { reportErrorScope } from './render-loop-helpers'
import { xlog } from '@xgis/shared'

// reportErrorScope is fire-and-forget — flush the microtask queue so the
// .then/.catch handlers run before we assert.
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

describe('reportErrorScope (Audit ⑧ B2 — un-swallow validation rejections)', () => {
  beforeEach(() => {
    vi.mocked(xlog.error).mockClear()
  })

  it('logs a resolved validation error with the tag', async () => {
    const err = { message: 'bind group layout mismatch' } as GPUError
    reportErrorScope(Promise.resolve(err), 'pass:fill')
    await flush()
    expect(xlog.error).toHaveBeenCalledTimes(1)
    const [prefix, msg] = vi.mocked(xlog.error).mock.calls[0]!
    expect(prefix).toContain('pass:fill')
    expect(msg).toBe('bind group layout mismatch')
  })

  it('logs NOTHING on a clean frame (resolves null)', async () => {
    reportErrorScope(Promise.resolve(null), 'frame-validation')
    await flush()
    expect(xlog.error).not.toHaveBeenCalled()
  })

  it('logs the REJECTION instead of swallowing it', async () => {
    reportErrorScope(Promise.reject(new Error('scope stack unbalanced')), 'frame-validation')
    await flush()
    expect(xlog.error).toHaveBeenCalledTimes(1)
    const [prefix, msg] = vi.mocked(xlog.error).mock.calls[0]!
    expect(prefix).toContain('frame-validation')
    expect(prefix).toContain('rejected')
    expect(msg).toBe('scope stack unbalanced')
  })

  it('stringifies a non-Error rejection reason', async () => {
    reportErrorScope(Promise.reject('device lost'), 'pass:line')
    await flush()
    expect(xlog.error).toHaveBeenCalledTimes(1)
    expect(vi.mocked(xlog.error).mock.calls[0]![1]).toBe('device lost')
  })
})
