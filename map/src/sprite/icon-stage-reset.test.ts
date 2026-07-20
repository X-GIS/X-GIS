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
  ;(stage as unknown as { inlineImages: unknown[] }).inlineImages = [] // #777 I-G — prepare() reads it (ctor bypassed by the Object.create stub)
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

describe('IconStage.isAtlasTerminal()', () => {
  // The S16 skip must NOT fire while the sprite atlas is still loading, or icons
  // would be frozen before they resolve. Terminal = loaded OR failed.
  function stubWithStatus(status: string): IconStage {
    const stage = Object.create(IconStage.prototype) as IconStage
    ;(stage as unknown as { inlineImages: unknown[] }).inlineImages = [] // #777 I-G — prepare() reads it (ctor bypassed by the Object.create stub)
    ;(stage as unknown as { host: { getState(): { status: string } } }).host = {
      getState: () => ({ status }),
    }
    return stage
  }

  it('false while loading / idle (skip would freeze pre-resolution icons)', () => {
    expect(stubWithStatus('idle').isAtlasTerminal()).toBe(false)
    expect(stubWithStatus('loading').isAtlasTerminal()).toBe(false)
  })

  it('true once loaded or failed (no further resolution can arrive)', () => {
    expect(stubWithStatus('loaded').isAtlasTerminal()).toBe(true)
    expect(stubWithStatus('failed').isAtlasTerminal()).toBe(true)
  })
})
