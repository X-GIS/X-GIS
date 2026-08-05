// ═══ The flow pass must DECLARE "no field" on the eviction frame (#1419, #1046 Inc-F2c) ═══
//
// `FlowRenderer.setArrowFields` is not an update — it is the DECLARATION the
// arrow draw binds from. Its own call site says so: "BEFORE the early return,
// not after it: what the arrow draw binds is whatever this last declared, so a
// frame with no field has to say so or the draw keeps the evicted region's (now
// destroyed) textures bound." That is #1419: `destroyed texture
// "coverage-flow-v" used in a submit`.
//
// The declaration therefore has to survive the frame where the LAST flow region
// evicts — which is exactly the frame `scene.hasFlow` turns false, because
// `hasFlow` IS `coverageRenderer.hasFlowField()` (scene-view.ts). A `shouldRun`
// gate on `hasFlow` skips the whole execute on that frame, so the inner
// before-the-early-return placement never gets a chance to run: the outer gate
// swallows the requirement its own comment states.
//
// The forced-WebGL2 twin (deleted, #1046 Inc-F3a) never had this hole — it called
// setArrowFields unconditionally, outside its `if`, with a comment naming #1419.
// That is why this went unnoticed until the twin's deletion left the chain as the
// only frame.
//
// This gate drives the pass THROUGH THE SCHEDULER's contract (shouldRun decides
// whether execute runs), not execute directly, because the defect lives in that
// composition and a test that called execute unconditionally would pass while
// the product broke.

import { describe, it, expect, vi } from 'vitest'
import { flowPass } from './flow-pass'
import type { SceneView } from '../scene-view'
import type { FrameContext } from '../frame-context'
import type { FlowPassHost } from './pass'

/** Run the pass the way the chain runs it: `shouldRun` gates `execute`. */
function runScheduled(host: FlowPassHost, hasFlow: boolean): void {
  const scene = { hasFlow } as unknown as SceneView
  if (!flowPass.shouldRun(scene)) return
  const ctx = {
    passScope: (_l: string, fn: () => void) => fn(),
    elapsedMs: 0,
    rhiEncoder: {},
  } as unknown as FrameContext
  flowPass.execute(ctx, scene, host as never)
}

function makeHost(fields: Map<string, unknown>) {
  const setArrowFields = vi.fn()
  const step = vi.fn()
  const host = {
    flowRenderer: { setArrowFields, step },
    coverageRenderer: {
      // `activeFlowField` and `hasFlowField` agree by construction, as they do
      // on the real renderer: no regions ⇒ no field.
      activeFlowField: () => (fields.size > 0 ? { __field: true } : null),
      flowFields: () => fields,
      hasFlowField: () => fields.size > 0,
      hasDrapedFlowField: () => false,
    },
  } as unknown as FlowPassHost
  return { host, setArrowFields, step }
}

describe('flow pass — the eviction frame still declares (#1419, #1046 Inc-F2c)', () => {
  it('a frame WITH a field declares that field', () => {
    const fields = new Map<string, unknown>([['cbofs', { __f: 1 }]])
    const { host, setArrowFields } = makeHost(fields)
    runScheduled(host, true)
    expect(setArrowFields).toHaveBeenCalledTimes(1)
    expect(setArrowFields.mock.calls[0]![0]).toBe(fields)
  })

  it('the frame the LAST region evicts still declares — with an EMPTY map', () => {
    // The scheduler's own signal (`hasFlow`) is false on this frame; the
    // declaration must happen anyway, or the arrow draw keeps binding the
    // destroyed region textures.
    const { host, setArrowFields, step } = makeHost(new Map())
    runScheduled(host, false)
    expect(
      setArrowFields,
      'setArrowFields was never called on the eviction frame — the arrow draw keeps the ' +
        'evicted region bound and resubmits a DESTROYED texture view (#1419)',
    ).toHaveBeenCalledTimes(1)
    expect((setArrowFields.mock.calls[0]![0] as Map<string, unknown>).size).toBe(0)
    // …and nothing is advected: there is no field to step.
    expect(step).not.toHaveBeenCalled()
  })

  it('a map that never had a flow field declares empty too (idle style, no crash path)', () => {
    const { host, setArrowFields, step } = makeHost(new Map())
    runScheduled(host, false)
    expect(setArrowFields).toHaveBeenCalledTimes(1)
    expect(step).not.toHaveBeenCalled()
  })
})
