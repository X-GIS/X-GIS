// ═══ The chain frame DRAINS the GL error queue (#1046 F4 Inc-E1, MINOR-5) ═══
//
// RhiDevice.takeGlErrors is the WebGL2 backend's frame-encoder error drain
// (optional on the interface; WebGPU returns undefined → `?? []`). Before
// this seam, ONLY the forced-WebGL2 twin consumed it — on a flipped
// `chainFrame` the queue would grow unboundedly and every GL error would be
// swallowed silently (drained ≠ surfaced; the Inc-A..C review banked this as
// the flip's hard precondition). The chain tail must mirror the twin's
// consumer: drain after the frame submit, route through the capped
// pushValidationError writer (#1153 P2 R6 — never log directly).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const loopSrc = (): string =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'render-loop.ts'), 'utf8')

describe('GL-error sink seam (#1046 F4 Inc-E1)', () => {
  it('the CHAIN tail drains takeGlErrors — receiver-pinned, exactly once', () => {
    const src = loopSrc()
    // Receiver-pinned (the Inc-A MINOR-1 lesson): the chain drains the FRAME
    // device (`rhiFrame`), the twin its own `rhi` local — counted separately
    // so a half-wired loop (either consumer missing) goes red. The twin row
    // retires with the twin (Inc-F updates this to 0).
    expect(src.match(/rhiFrame\.takeGlErrors\?\.\(\) \?\? \[\]/g) ?? []).toHaveLength(1)
    expect(src.match(/rhi\.takeGlErrors\?\.\(\) \?\? \[\]/g) ?? []).toHaveLength(1)
  })

  it('the chain drain sits AFTER the frame submit and routes through the capped writer', () => {
    const src = loopSrc()
    // WebGL2 executes immediately during encoding; finish() is the submit
    // boundary, so draining after it observes the whole frame's errors —
    // the same order the twin established.
    const finishAt = src.indexOf('frameEnc.finish()')
    const drainAt = src.indexOf('rhiFrame.takeGlErrors')
    expect(finishAt).toBeGreaterThan(-1)
    expect(drainAt).toBeGreaterThan(finishAt)
    // Both consumers route through pushValidationError (capped, #1153 P2 R6)
    // — one call site per consumer, no direct logging.
    expect(src.match(/pushValidationError\(this\.host\.ctx, /g) ?? []).toHaveLength(2)
  })
})
