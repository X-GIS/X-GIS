import { describe, it, expect, vi } from 'vitest'
import { BlueprintEditor } from '../editor'
import { History } from '../history'
import type { BPGraph, BPNode } from '../types'

// ── Harness ───────────────────────────────────────────────────────────
// BlueprintEditor's constructor builds a live DOM scene (createElementNS,
// getBoundingClientRect, requestAnimationFrame, navigator.clipboard…) and
// blueprint ships no DOM test environment (no jsdom/happy-dom dep; the
// repo vitest config runs bare Node). So we construct the instance WITHOUT
// running that DOM-heavy constructor — Object.create + the handful of
// fields load()/undo()/record()/restore() actually touch — and stub only
// the two render side-effects (renderAll/emit). The undo/redo/snapshot/
// restore/record machinery and a REAL History run unmodified, so this is a
// faithful end-to-end exercise of the load→mutate→load→undo path that
// site/blueprint.astro applyGraph() drives on every Style→blueprint import.
function makeEditor() {
  const ed = Object.create(BlueprintEditor.prototype) as BlueprintEditor
  const e = ed as unknown as {
    nodes: BPNode[]
    edges: unknown[]
    frames: unknown[]
    selNodes: Set<string>
    selFrames: Set<string>
    selEdge: string | null
    history: History
    snap: boolean
    renderAll: () => void
    emit: () => void
  }
  e.nodes = []
  e.edges = []
  e.frames = []
  e.selNodes = new Set()
  e.selFrames = new Set()
  e.selEdge = null
  e.history = new History()
  e.snap = false
  // The only DOM-touching methods on the load/undo path; neutralise them.
  e.renderAll = () => {}
  e.emit = () => {}
  return ed
}

const graph = (name: string): BPGraph => ({
  nodes: [{ id: 'n_' + name, type: 'source', x: 0, y: 0, data: { name } }],
  edges: [],
  frames: [],
})

describe('BlueprintEditor.load() resets undo history', () => {
  it('undo after load is a no-op — load() does NOT revert to a pre-load graph', () => {
    const ed = makeEditor()

    // 1. Open graph A, then make a recorded mutation so past[] holds a
    //    pre-mutation snapshot of A (this is the snapshot the bug replays).
    ed.load(graph('A'))
    ;(ed as unknown as { record: () => void }).record()
    ;(ed as unknown as { nodes: BPNode[] }).nodes[0].data.name = 'A-edited'

    // 2. Open graph B (file-open: must discard A's history).
    ed.load(graph('B'))

    // 3. Undo. With reset() it is a no-op; without it, undo pops A's stale
    //    snapshot and clobbers the freshly-loaded B.
    ed.undo()

    const after = ed.getGraph()
    expect(after.nodes.map((n) => n.data.name)).toEqual(['B'])
    // Explicit anti-regression: the stale A snapshots must be gone.
    expect(after.nodes.some((n) => n.data.name === 'A' || n.data.name === 'A-edited')).toBe(false)
  })

  it('load() calls history.reset() at the seam', () => {
    const ed = makeEditor()
    const reset = vi.spyOn((ed as unknown as { history: History }).history, 'reset')
    ed.load(graph('A'))
    expect(reset).toHaveBeenCalledTimes(1)
  })
})
