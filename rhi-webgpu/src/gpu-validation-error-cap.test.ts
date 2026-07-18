// R6 (#1153 P2) — the per-context validation-error queue was unbounded and the
// uncapturederror handler console.error'd EVERY event, so a sustained WebGPU
// validation defect floods ~60 logs/s and grows the heap without limit. The fix
// caps the queue (VALIDATION_ERROR_CAP, splice-trim — the _flickerLog idiom) via a
// single shared writer, and rate-limits the console.error (first 10, then every
// 100th; counter-based, no clock).
//
// The queue MUST stay a plain Array — the e2e drain helpers read `[...arr]` and set
// `.length = 0` in-page — so this pins Array-identity + the tail-retention contract.

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { RenderContext } from '@xgis/engine'
import { pushValidationError, VALIDATION_ERROR_CAP, createWebGpuContext } from './gpu'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('validation-error queue cap (#1153 P2 R6)', () => {
  it('pushValidationError caps at VALIDATION_ERROR_CAP, retains the tail, and stays a plain Array', () => {
    const ctx = { _validationErrors: [] } as unknown as RenderContext
    for (let i = 0; i < 500; i++) pushValidationError(ctx, `err ${i}`)

    // Fail-before: the pre-fix raw `.push` grows to 500 unbounded.
    expect(ctx._validationErrors.length).toBe(VALIDATION_ERROR_CAP)
    expect(VALIDATION_ERROR_CAP).toBe(100)
    // Most-recent errors kept (the drain helpers + e2e read the tail).
    expect(ctx._validationErrors[ctx._validationErrors.length - 1]!.message).toBe('err 499')
    // The in-page e2e contract: still a plain Array, `.length = 0` clears it.
    expect(Array.isArray(ctx._validationErrors)).toBe(true)
    ctx._validationErrors.length = 0
    expect(ctx._validationErrors.length).toBe(0)
  })

  it('the uncapturederror handler rate-limits console.error (first 10, then every 100th) and caps the queue', async () => {
    const captured: { handler?: (e: unknown) => void } = {}
    const device = {
      features: { has: () => false },
      // Never resolves: keep the device.lost chain inert during the test.
      lost: new Promise<never>(() => {}),
      addEventListener: (type: string, cb: (e: unknown) => void) => {
        if (type === 'uncapturederror') captured.handler = cb
      },
    }
    const adapter = { features: { has: () => false }, requestDevice: async () => device }
    const gpu = {
      requestAdapter: async () => adapter,
      getPreferredCanvasFormat: () => 'bgra8unorm',
    }
    // Node exposes `navigator` as a getter-only global, so assign `.gpu` on the
    // existing object (the webgpu-stub install pattern) rather than replacing it.
    const g = globalThis as unknown as { navigator?: { gpu?: unknown } }
    const navExisted = g.navigator !== undefined
    const priorGpu = g.navigator?.gpu
    if (!g.navigator) (g as { navigator?: unknown }).navigator = {}
    g.navigator!.gpu = gpu
    const canvas = {
      getContext: (t: string): unknown => (t === 'webgpu' ? { configure: () => {} } : null),
    } as unknown as HTMLCanvasElement

    try {
      const ctx = await createWebGpuContext(canvas, { sampleCount: 1 })
      expect(captured.handler).toBeTypeOf('function')

      // Spy AFTER boot so only handler logs are counted.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      for (let i = 0; i < 500; i++) captured.handler!({ error: { message: `boom ${i}` } })

      // 10 (first) + floor((500 - 10) / 100) = 14. Fail-before: unconditional
      // console.error → 500 calls.
      expect(errorSpy).toHaveBeenCalledTimes(10 + Math.floor((500 - 10) / 100))
      // First error always visible.
      expect(errorSpy.mock.calls[0]?.[1]).toBe('boom 0')
      // Queue capped (fail-before: 500).
      expect(ctx._validationErrors.length).toBe(VALIDATION_ERROR_CAP)
    } finally {
      if (!navExisted) delete (g as { navigator?: unknown }).navigator
      else if (priorGpu === undefined) delete g.navigator!.gpu
      else g.navigator!.gpu = priorGpu
    }
  })
})
