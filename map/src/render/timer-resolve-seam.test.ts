// ═══ The gpuTimer tail resolves through the RHI (#1046 F4 — Inc-B) ═══
//
// `resolveOnEncoder(encoder)` was the loop tail's second native: it took the
// unwrapped `GPUCommandEncoder`, so the loop had to keep a native local alive
// just to feed it. The seam: `GPUTimer.resolveOnRhi(frameEnc)` — the `markRhi`
// precedent — guards every early-out BEFORE unwrapping, so a disabled timer
// (or a non-WebGPU frame encoder once the chain runs on WebGl2Device) is a
// no-op, never an unwrap error. The guard-order unit lives with the timer
// (rhi-webgpu/src/gpu-timer-rhi-seam.test.ts); this file pins the LOOP side.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const loopSrc = (): string =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'render-loop.ts'), 'utf8')

describe('timer-resolve seam (#1046 F4 Inc-B)', () => {
  it('render-loop never hands the timer a NATIVE encoder', () => {
    expect(loopSrc().match(/resolveOnEncoder\(/g) ?? []).toHaveLength(0)
  })

  it('render-loop resolves the timer tail through the RHI frame encoder', () => {
    expect(loopSrc().match(/resolveOnRhi\(frameEnc\)/g) ?? []).toHaveLength(1)
  })
})
