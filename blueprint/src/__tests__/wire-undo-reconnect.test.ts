import { describe, it, expect } from 'vitest'
import { BlueprintEditor } from '../editor'
import { History } from '../history'
import type { BPEdge, BPNode, PinSpec, PinType } from '../types'

// ── Harness ───────────────────────────────────────────────────────────
// Same shape as load-history-reset.test.ts: the real constructor builds a
// live DOM scene and blueprint ships no DOM test environment, so we
// Object.create the instance and seed only the fields the wire/undo paths
// touch, stubbing the DOM render side-effects. The History, record(),
// startWire(), tryConnect() and insertReroute() machinery run unmodified,
// so this faithfully exercises the gesture→undo bookkeeping.
type Pin = { dataset: { node: string; pin: string; dir: 'in' | 'out'; ptype: PinType } }

interface Internals {
  nodes: BPNode[]
  edges: BPEdge[]
  frames: unknown[]
  selNodes: Set<string>
  selFrames: Set<string>
  selEdge: string | null
  history: History
  snap: boolean
  pinEls: Map<string, Pin>
  drag: { kind: 'wire'; from: { node: string; pin: string; ptype: PinType }; reconnected?: boolean } | null
  renderAll: () => void
  renderEdges: () => void
  renderInspector: () => void
  refreshSelection: () => void
  mountNode: (n: BPNode) => void
  emit: () => void
  showPinHints: () => void
  toWorld: (x: number, y: number) => { x: number; y: number }
  startWire: (nodeId: string, p: PinSpec, dir: 'in' | 'out') => void
  tryConnect: (
    a: { node: string; pin: string; ptype: PinType },
    b: { node: string; pin: string; dir: 'in' | 'out'; ptype: PinType },
    skipRecord?: boolean,
  ) => void
  insertReroute: (edgeId: string, clientX: number, clientY: number) => void
  deleteSelection: () => void
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
  ed.pinEls = new Map()
  ed.drag = null
  // DOM side-effects on the wire / reroute / delete paths — neutralise them.
  ed.renderAll = () => {}
  ed.renderEdges = () => {}
  ed.renderInspector = () => {}
  ed.refreshSelection = () => {}
  ed.mountNode = () => {}
  ed.emit = () => {}
  ed.showPinHints = () => {}
  ed.toWorld = (x, y) => ({ x, y })
  return ed
}

// A pin lookup entry as the real DOM would carry on its dataset; pinDir/
// pinType read `dataset.dir` / `dataset.ptype` off pinEls.get(`node:pin`).
function pin(node: string, p: string, dir: 'in' | 'out', ptype: PinType): [string, Pin] {
  return [`${node}:${p}`, { dataset: { node, pin: p, dir, ptype } }]
}

const node = (id: string): BPNode => ({ id, type: 'reroute', x: 0, y: 0, data: {} })

// History.past is private; read its depth structurally for the undo-count
// assertions (the test deliberately inspects the undo stack size).
const pastLen = (ed: Internals): number =>
  (ed.history as unknown as { past: unknown[] }).past.length

describe('blueprint wire undo correctness', () => {
  it('reconnecting an input wire records ONE undo step for the whole gesture (#bug4)', () => {
    const ed = makeEditor()
    // reroute nodes give stable any-typed in/out pins with no schema deps.
    ed.nodes = [node('s'), node('l')]
    ed.pinEls = new Map([pin('s', 'out', 'out', 'any'), pin('l', 'in', 'in', 'any')])
    // Existing wire s.out → l.in is what the user grabs off the input pin.
    ed.edges = [{ id: 'e_old', from: { node: 's', pin: 'out' }, to: { node: 'l', pin: 'in' } }]

    const before = pastLen(ed)

    // 1. Grab the wire at the input pin l.in (detaches it from s.out).
    ed.startWire('l', { id: 'in', label: '', type: 'any' }, 'in')
    expect(ed.drag?.kind).toBe('wire')

    // 2. Drop — replay exactly what onUp does for a wire drop: re-issue
    //    tryConnect with d.from and the gesture's own reconnect signal.
    const d = ed.drag!
    ed.tryConnect(d.from, { node: 'l', pin: 'in', dir: 'in', ptype: 'any' }, d.reconnected)

    // One user gesture ⇒ exactly one snapshot on the undo stack
    // (unpatched code records twice — startWire AND tryConnect).
    expect(pastLen(ed) - before).toBe(1)
  })

  it('a standalone connect still records normally', () => {
    const ed = makeEditor()
    ed.nodes = [node('s'), node('l')]
    ed.pinEls = new Map([pin('s', 'out', 'out', 'any'), pin('l', 'in', 'in', 'any')])

    const before = pastLen(ed)
    ed.tryConnect({ node: 's', pin: 'out', ptype: 'any' }, { node: 'l', pin: 'in', dir: 'in', ptype: 'any' })
    expect(pastLen(ed) - before).toBe(1)
    expect(ed.edges.some((e) => e.from.node === 's' && e.to.node === 'l')).toBe(true)
  })
})

describe('insertReroute clears the stale edge selection (#bug5)', () => {
  it('nulls selEdge for the split edge so a later Delete is a clean no-op', () => {
    const ed = makeEditor()
    ed.nodes = [node('a'), node('b')]
    ed.pinEls = new Map([pin('a', 'out', 'out', 'any'), pin('b', 'in', 'in', 'any')])
    ed.edges = [{ id: 'e1', from: { node: 'a', pin: 'out' }, to: { node: 'b', pin: 'in' } }]
    // A wire pointerdown selects the edge (editor.ts ~1070).
    ed.selEdge = 'e1'

    ed.insertReroute('e1', 0, 0)

    // The split edge is gone…
    expect(ed.edges.some((e) => e.id === 'e1')).toBe(false)
    // …and the selection must no longer dangle on the deleted edge id.
    expect(ed.selEdge).toBe(null)

    // With selEdge cleared, Delete hits deleteSelection's no-op guard and
    // records nothing (unpatched: stale selEdge bypasses the guard → a
    // phantom record() + edge-filter that matches nothing).
    const before = pastLen(ed)
    ed.deleteSelection()
    expect(pastLen(ed) - before).toBe(0)
  })
})
