import { describe, it, expect } from 'vitest'
import { BlueprintEditor } from '../editor'
import { History } from '../history'
import type { BPEdge, BPGraph, BPNode } from '../types'

// ── Harness ──────────────────────────────────────────────
// Same shape as load-history-reset.test.ts / wire-undo-reconnect.test.ts:
// BlueprintEditor's real constructor builds a live DOM scene and blueprint
// ships no DOM test environment, so we Object.create the instance and seed
// only the fields the deserialization paths touch, stubbing the DOM render
// side-effects. The History, record(), spawn(), restore() and load()
// machinery run unmodified, so this faithfully exercises the paste/undo/
// load trust boundary that the editor drives on untrusted JSON.
interface Internals {
  nodes: BPNode[]
  edges: BPEdge[]
  frames: unknown[]
  selNodes: Set<string>
  selFrames: Set<string>
  selEdge: string | null
  history: History
  snap: boolean
  renderAll: () => void
  refreshSelection: () => void
  renderInspector: () => void
  scheduleRedraw: () => void
  mountNode: (n: BPNode) => void
  mountFrame: (f: unknown) => void
  emit: () => void
  spawn: (g: BPGraph, dx: number, dy: number) => void
  restore: (s: string) => void
}

function makeEditor(): Internals {
  const ed = Object.create(BlueprintEditor.prototype) as unknown as Internals
  ed.nodes = []
  ed.edges = []
  ed.frames = []
  ed.selNodes = new Set()
  ed.selFrames = new Set()
  ed.selEdge = null
  ed.history = new History()
  ed.snap = false
  // DOM side-effects on the spawn / restore paths — neutralise them.
  ed.renderAll = () => {}
  ed.refreshSelection = () => {}
  ed.renderInspector = () => {}
  ed.scheduleRedraw = () => {}
  ed.mountNode = () => {}
  ed.mountFrame = () => {}
  ed.emit = () => {}
  return ed
}

// History.past is private; read its depth structurally for the undo-stack
// consistency assertion.
const pastLen = (ed: Internals): number =>
  (ed.history as unknown as { past: unknown[] }).past.length

describe('blueprint deserialization rejects unknown node types', () => {
  it('spawn() drops an unknown-type node instead of throwing (paste/duplicate seam)', () => {
    const ed = makeEditor()
    ed.nodes = [{ id: 'existing', type: 'map', x: 0, y: 0, data: {} }]

    // A foreign/forward-version clipboard payload: one good node, one node
    // whose `type` is absent from NODE_SPECS, and an edge referencing it.
    const payload: BPGraph = {
      nodes: [
        { id: 'good', type: 'source', x: 10, y: 10, data: { name: 'world' } },
        {
          id: 'alien',
          type: 'totally-unknown' as unknown as BPNode['type'],
          x: 20,
          y: 20,
          data: {},
        },
      ],
      edges: [
        { id: 'e_bad', from: { node: 'good', pin: 'out' }, to: { node: 'alien', pin: 'in' } },
      ],
      frames: [],
    }

    const before = pastLen(ed)

    // On clean HEAD spawn() reads NODE_SPECS['totally-unknown'].singleton
    // → undefined.singleton → TypeError thrown mid-loop (after record() and
    // after the good node was already pushed).
    expect(() => ed.spawn(payload, 0, 0)).not.toThrow()

    // The good node landed; the alien node was dropped.
    expect(ed.nodes.some((n) => n.type === 'source')).toBe(true)
    expect(ed.nodes.some((n) => (n.type as string) === 'totally-unknown')).toBe(false)
    // The edge to the dropped node must not survive.
    expect(ed.edges.some((e) => e.to.node === 'alien')).toBe(false)
    // Exactly one undo snapshot for the whole gesture (no junk / no double).
    expect(pastLen(ed) - before).toBe(1)
  })

  it('restore() (undo/redo replay) survives an unknown-type node in the snapshot', () => {
    const ed = makeEditor()
    const snap = JSON.stringify({
      nodes: [
        { id: 'good', type: 'layer', x: 0, y: 0, data: {} },
        { id: 'alien', type: 'totally-unknown', x: 0, y: 0, data: {} },
      ],
      edges: [
        { id: 'e', from: { node: 'alien', pin: 'out' }, to: { node: 'good', pin: 'source' } },
      ],
      frames: [],
    })

    // On clean HEAD restore() → renderAll() → mountNode reads
    // NODE_SPECS['totally-unknown'] → undefined and throws.
    expect(() => ed.restore(snap)).not.toThrow()
    expect(ed.nodes.some((n) => (n.type as string) === 'totally-unknown')).toBe(false)
    expect(ed.nodes.some((n) => n.type === 'layer')).toBe(true)
    expect(ed.edges.some((e) => e.from.node === 'alien')).toBe(false)
  })
})
