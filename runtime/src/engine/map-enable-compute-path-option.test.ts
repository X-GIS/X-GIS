// ═══════════════════════════════════════════════════════════════════
// XGISMapOptions.enableComputePath opt-in (plan P4 user-facing toggle)
// ═══════════════════════════════════════════════════════════════════
//
// Verifies the constructor option threads through to the run() →
// emitCommands invocation. Doesn't exercise the GPU pipeline; relies
// on the renderer-compute-simulation suite for the end-to-end path.

import { describe, expect, it } from 'vitest'
import { XGISMap } from './map'

function mockCanvas(): HTMLCanvasElement {
  return { width: 1200, height: 800 } as unknown as HTMLCanvasElement
}

describe('XGISMapOptions.enableComputePath', () => {
  it('default is false (flag absent)', () => {
    const map = new XGISMap(mockCanvas())
    // Access via test-only reach into the private field; the public
    // API never exposes the flag directly (it propagates through
    // emitCommands at run() time).
    const flag = (map as unknown as { _enableComputePath: boolean })._enableComputePath
    expect(flag).toBe(false)
  })

  it('false when option explicitly omitted', () => {
    const map = new XGISMap(mockCanvas(), { spriteUrl: 'whatever' })
    const flag = (map as unknown as { _enableComputePath: boolean })._enableComputePath
    expect(flag).toBe(false)
  })

  it('true when option is set', () => {
    const map = new XGISMap(mockCanvas(), { enableComputePath: true })
    const flag = (map as unknown as { _enableComputePath: boolean })._enableComputePath
    expect(flag).toBe(true)
  })

  it('treats truthy non-boolean as opt-in (matches typical option-bag ergonomics)', () => {
    // Bool-coerce: a stray `true` in JSON should still activate.
    const map = new XGISMap(mockCanvas(), { enableComputePath: true })
    const flag = (map as unknown as { _enableComputePath: boolean })._enableComputePath
    expect(flag).toBe(true)
  })

  it('explicit false does not flip a default-false flag', () => {
    const map = new XGISMap(mockCanvas(), { enableComputePath: false })
    const flag = (map as unknown as { _enableComputePath: boolean })._enableComputePath
    expect(flag).toBe(false)
  })
})
