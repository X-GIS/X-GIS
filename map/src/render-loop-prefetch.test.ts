// ═══ The anticipatory prefetch runs where it can see something (#1587) ═══
//
// Both prefetch routes had never run in the product. `beginFrame` cleared the frame tile selection
// and the pump read it sixteen lines later in the same straight-line block, so
// `pumpPrefetch`'s `if (!cache) return` fired on every frame forever.
//
// WHY THE ORDERING IS ASSERTED AGAINST THE SOURCE TEXT. The defect is not inside any function — it
// is the ORDER of two statements in a frame body that needs a GPU device, a real camera and a live
// tile catalog to execute. `vtr-fallback-drape-draw.test.ts` established this pattern for exactly
// that situation: anchor on the source, assert the relative position, and guard the anchors so a
// rename fails loudly instead of vacuously (#996). A unit test that called `pumpPrefetch` directly
// is what let this defect live — `vtr-pump-prefetch.test.ts` seeds the cache by hand and never
// calls `beginFrame`, so it verified delegation while the product's ordering made delegation
// unreachable.

import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pumpFramePrefetch } from './render-loop-prefetch'
import type { Camera } from './camera'

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'render-loop.ts'), 'utf8')

/** The WebGPU frame's pass-chain loop — what populates every source's frame tile selection. */
const NODE_LOOP = 'for (const node of this._nodes) {'
/** The frame's pump call. */
const WGPU_PUMP = 'pumpFramePrefetch(this.host, projType, ctx.scene)'

// #1046 Inc-F3a deleted the forced-WebGL2 twin (`renderFrameViaRhi`), so this file's
// twin-arm anchors (`rhi.endScreenPass(pass)`, the twin's own pump call) no longer
// resolve and its twin-ordering case has no subject. The ordering property itself did
// not weaken — it STRENGTHENED: both backends now run this one chain frame, so the
// single pump asserted below is the whole product, not one of two arms.

describe('prefetch ordering in the frame body (#1587)', () => {
  it('every anchor still resolves — a renamed anchor must fail loudly, not vacuously', () => {
    // #996: a gate whose anchors have drifted is green for the wrong reason. Without this, the
    // position assertions below would silently compare -1 to -1 and pass over a moved pump.
    for (const [name, anchor] of [
      ['node loop', NODE_LOOP],
      ['frame pump', WGPU_PUMP],
    ] as const) {
      expect(
        SOURCE.indexOf(anchor),
        `${name} anchor not found: ${JSON.stringify(anchor)}`,
      ).toBeGreaterThan(-1)
    }
  })

  it('the WebGPU frame pumps AFTER the pass chain, not before it', () => {
    // THE DEFECT, stated as a position. Before the pass chain the selection does not exist yet:
    // `beginFrame` cleared it and nothing has run `selectForFrame`, so the pump reads null and
    // returns. This is the assertion that is red on the unfixed tree.
    expect(
      SOURCE.indexOf(WGPU_PUMP),
      'the pump must follow the node loop — ahead of it the frame tile selection is empty and ' +
        'the pump silently does nothing, which is exactly how #1587 stayed invisible',
    ).toBeGreaterThan(SOURCE.indexOf(NODE_LOOP))
  })

  it('exactly ONE arm pumps — the pick pass must not', () => {
    // `pickViaRhi` renders an offscreen hit-test at whatever cadence the host asks questions. It
    // is not a display frame, so pumping there would sample the pan velocity over a dt unrelated
    // to on-screen motion, and would double-pump any frame that also serviced a pick.
    // Was 2 while the forced-WebGL2 twin existed; #1046 Inc-F3a deleted it, so the single
    // chain frame is now the only display path on BOTH backends.
    const calls = SOURCE.split('pumpFramePrefetch(').length - 1
    expect(
      calls,
      'expected exactly 1 pump call site (the frame body); a second is probably the pick pass, ' +
        'which must stay out — see skipPrefetchForPickPass',
    ).toBe(1)
  })
})

describe('pumpFramePrefetch fans out once per source (#1587)', () => {
  const camera = {} as Camera
  const scene = { w: 1024, h: 768, dpr: 2 }

  it('pumps every attached source exactly once, with the frame’s own scene dims', () => {
    const a = vi.fn()
    const b = vi.fn()
    pumpFramePrefetch(
      {
        vtSources: [
          ['a', { renderer: { pumpPrefetch: a } }],
          ['b', { renderer: { pumpPrefetch: b } }],
        ],
        camera,
      },
      7,
      scene,
    )
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    // projType is the render-loop's camera-resolved value, and the dims are the frame's — a
    // source reading stale dims would speculate over the wrong frustum.
    expect(a).toHaveBeenCalledWith(camera, 7, 1024, 768, 2)
  })

  it('a map with no vector sources is a no-op, not a crash', () => {
    expect(() => pumpFramePrefetch({ vtSources: [], camera }, 0, scene)).not.toThrow()
  })
})
