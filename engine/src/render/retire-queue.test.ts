// ═══ #2405 — the one deferred-destroy queue the six hand-mirrored lists collapse into ═══
//
// The invariant under test is not "the queue empties". It is that a resource
// retired in frame N is destroyed EXACTLY ONCE, at the drain, and NOT BEFORE —
// because destroying at the retire site is the bug this class exists to remove
// (`[Buffer "…"] used in submit while destroyed`). So every arm records the
// order of destroy calls against the retires, not just the final state: a queue
// that destroyed eagerly and then cleared would satisfy an emptiness check while
// being precisely the defect.

import { describe, it, expect } from 'vitest'
import { RetireQueue } from './retire-queue'
import type { RhiBuffer, RhiDevice, RhiTexture } from '@xgis/rhi'

/** Records destroys in call order so an arm can tell WHEN one happened, not
 *  merely that the queue is empty afterwards. */
function recordingRhi() {
  const destroyed: string[] = []
  const rhi = {
    destroyBuffer: (b: RhiBuffer) => void destroyed.push(`buf:${(b as unknown as Tagged).__tag}`),
    destroyTexture: (t: RhiTexture) => void destroyed.push(`tex:${(t as unknown as Tagged).__tag}`),
  }
  return { rhi: rhi as unknown as RhiDevice, destroyed }
}

interface Tagged {
  __tag: string
}
const buf = (tag: string) => ({ __tag: tag }) as unknown as RhiBuffer
const tex = (tag: string) => ({ __tag: tag }) as unknown as RhiTexture

describe('#2405 RetireQueue — deferred destroy', () => {
  it('does NOT destroy at the retire site — only at the drain', () => {
    // The whole point. A queue that destroyed on push would pass every
    // "is it empty afterwards" assertion while reintroducing the mid-frame
    // destroy that every one of the six mirrored lists exists to avoid.
    const { rhi, destroyed } = recordingRhi()
    const q = new RetireQueue()

    q.retireBuffer(buf('a'))
    q.retireTexture(tex('t'))
    expect(destroyed, 'nothing may be destroyed before the drain').toEqual([])
    expect(q.size, 'but both are held').toBe(2)

    expect(q.drain(rhi)).toBe(2)
    expect(destroyed).toEqual(['buf:a', 'tex:t'])
    expect(q.size, 'and the queue is emptied by the drain').toBe(0)
  })

  it('destroys every retired resource exactly once', () => {
    const { rhi, destroyed } = recordingRhi()
    const q = new RetireQueue()
    q.retireBuffer(buf('a'))
    q.retireBuffer(buf('b'))
    q.retireTexture(tex('t'))

    q.drain(rhi)

    expect(destroyed.filter((d) => d === 'buf:a')).toHaveLength(1)
    expect(destroyed.sort()).toEqual(['buf:a', 'buf:b', 'tex:t'])
  })

  it('a SECOND drain destroys nothing — a per-frame drain plus a teardown drain cannot double-free', () => {
    // Both current callers drain per frame AND at destroy(); WebGPU treats a
    // double destroy as a no-op but the RHI liveness ledger (#783, promoted to
    // always-on in P0) THROWS on it, so this is a real failure mode, not a
    // theoretical one.
    const { rhi, destroyed } = recordingRhi()
    const q = new RetireQueue()
    q.retireBuffer(buf('a'))

    expect(q.drain(rhi)).toBe(1)
    expect(q.drain(rhi), 'the second drain has nothing to do').toBe(0)
    expect(destroyed, 'and destroyed nothing a second time').toEqual(['buf:a'])
  })

  it('resources retired AFTER a drain survive it and go on the next one', () => {
    // The frame-to-frame contract: drain at the top of frame N+1 destroys what
    // frame N retired, and must not swallow what N+1 retires afterwards — that
    // would destroy a resource in the very frame that can still reference it.
    const { rhi, destroyed } = recordingRhi()
    const q = new RetireQueue()

    q.retireBuffer(buf('frameN'))
    q.drain(rhi)
    q.retireBuffer(buf('frameN+1'))

    expect(destroyed, 'the later retire is NOT destroyed by the earlier drain').toEqual([
      'buf:frameN',
    ])
    expect(q.size).toBe(1)

    q.drain(rhi)
    expect(destroyed).toEqual(['buf:frameN', 'buf:frameN+1'])
  })

  it('CONTROL — a null or undefined retire is a no-op, not a queued entry', () => {
    // Every owner retires from a record whose buffers are nullable
    // (`tile.lineSegmentBuffer`, `slot.featBuffer`), so the guard lives here
    // rather than at each call site. Without the control an implementation that
    // queued nulls would blow up inside the drain instead of at the push.
    const { rhi, destroyed } = recordingRhi()
    const q = new RetireQueue()

    q.retireBuffer(null)
    q.retireBuffer(undefined)
    q.retireTexture(null)

    expect(q.size).toBe(0)
    expect(q.drain(rhi)).toBe(0)
    expect(destroyed).toEqual([])
  })

  it('CONTROL — an empty drain touches the device at all', () => {
    // Guards the early-out: `drain` on an empty queue must not call into the
    // RHI, since both callers run it every frame whether or not anything was
    // retired.
    const { rhi, destroyed } = recordingRhi()
    expect(new RetireQueue().drain(rhi)).toBe(0)
    expect(destroyed).toEqual([])
  })
})
