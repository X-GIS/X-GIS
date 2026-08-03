// ═══ Chain-vs-twin routing derives from the DEVICE's capability (#1046 Inc-4) ═══
//
// `_chainRunsOnWebgl2` is no longer a hardcoded hold: it reads
// `rhi.caps.chainFrame` — the device's own claim that it can host the unified
// chain's whole frame (encoder + passes + the loop tail). The loop tail landed
// on the RHI (Inc-A..D + the E1 preconditions), so WebGl2Device now answers
// TRUE (the Inc-E2 flip): `?rhichain=1` routes the REAL chain BY THE DEVICE'S
// WORD, exactly as Inc-4 designed — the flip was a one-line cap edit with no
// render-loop change. Both gate sites must stay the SAME expression — a fork
// that flips one site but not the other would render the twin AND the chain
// (double frame) or neither.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RenderLoop } from '../render-loop'

const readsCap = (chainFrame: boolean): boolean => {
  const host = { ctx: { rhi: { caps: { chainFrame } } } }
  const loop = Object.create(RenderLoop.prototype) as RenderLoop
  ;(loop as unknown as { host: unknown }).host = host
  return (loop as unknown as { _chainRunsOnWebgl2: boolean })._chainRunsOnWebgl2
}

describe('chain routing capability (#1046 Inc-4)', () => {
  it('derives from rhi.caps.chainFrame — true routes the chain, false holds the twin', () => {
    expect(readsCap(true)).toBe(true)
    expect(readsCap(false)).toBe(false)
  })

  it('a device-less frame (rhi undefined) holds the twin — never throws', () => {
    const loop = Object.create(RenderLoop.prototype) as RenderLoop
    ;(loop as unknown as { host: unknown }).host = { ctx: {} }
    expect((loop as unknown as { _chainRunsOnWebgl2: boolean })._chainRunsOnWebgl2).toBe(false)
  })

  it('BOTH gate sites use the identical predicate (no half-flipped routing)', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'render-loop.ts'),
      'utf8',
    )
    // The FULL negated form, not the inner conjunction: a polarity flip at one
    // site (`!` dropped) leaves the substring intact but breaks routing — the
    // mutation this pin exists to catch, so the `!(...)` must be part of it.
    const sites = src.match(/!\(RHI_CHAIN && this\._chainRunsOnWebgl2\)/g) ?? []
    // Exactly the two documented gates: the resize fork and the twin dispatch.
    expect(sites).toHaveLength(2)
  })

  it("the two backends' caps answer as documented (BOTH host the chain — the Inc-E2 flip)", async () => {
    // The SOURCE literals — instance values are pinned in rhi-webgpu's
    // rhi-caps.test.ts; pinning the literal text here made the flip a
    // REVIEWED one-line diff (this row was red until Inc-E2 updated it), and
    // now pins the flipped state the same way against an un-reviewed revert.
    const { readFileSync: rf } = await import('node:fs')
    const here = dirname(fileURLToPath(import.meta.url))
    const gl2 = rf(join(here, '../../../rhi-webgl2/src/rhi-webgl2.ts'), 'utf8')
    const gpu = rf(join(here, '../../../rhi-webgpu/src/rhi-webgpu.ts'), 'utf8')
    expect(gl2).toMatch(/chainFrame: true/)
    expect(gpu).toMatch(/chainFrame: true/)
  })
})
