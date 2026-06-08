// S16 — IconStage.reset() unit coverage.
//
// reset() drops the pending dispatch queue WITHOUT preparing, so a label-pass
// frame that skips iStage.prepare() (the S16 collision skip) cannot carry
// dispatched-but-unprepared icons into the next prepared set. Constructed via
// the Object.create stub pattern (icon-paired-position.test.ts) so no WebGPU
// device is needed — reset() only touches the `pending` array.

import { describe, it, expect } from 'vitest'
import { IconStage } from './icon-stage'

function makeIconStageStub(): IconStage {
  const stage = Object.create(IconStage.prototype) as IconStage
  ;(stage as unknown as { pending: unknown[] }).pending = []
  return stage
}

describe('IconStage.reset()', () => {
  it('empties a non-empty pending queue', () => {
    const stage = makeIconStageStub()
    const pending = stage as unknown as { pending: unknown[] }
    pending.pending.push({ a: 1 }, { b: 2 }, { c: 3 })
    expect(pending.pending.length).toBe(3)
    stage.reset()
    expect(pending.pending.length).toBe(0)
  })

  it('is a no-op on an already-empty queue (normal-frame path)', () => {
    const stage = makeIconStageStub()
    const pending = stage as unknown as { pending: unknown[] }
    stage.reset()
    expect(pending.pending.length).toBe(0)
  })
})
