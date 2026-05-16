// Pure per-node lint. Returns id → human-readable issues; the editor
// renders the ⚠ badge from this. No DOM here so it's unit-testable.

import { NODE_SPECS, type BPEdge, type BPNode } from './types'

export function computeNodeIssues(nodes: BPNode[], edges: BPEdge[]): Map<string, string[]> {
  const dupe = (kind: string) => {
    const seen = new Map<string, number>()
    nodes
      .filter((n) => n.type === kind)
      .forEach((n) => {
        const k = (n.data.name || '').trim()
        if (k) seen.set(k, (seen.get(k) ?? 0) + 1)
      })
    return seen
  }
  const srcDupes = dupe('source')
  const layDupes = dupe('layer')
  const out = new Map<string, string[]>()
  for (const n of nodes) {
    const issues: string[] = []
    const hasName = NODE_SPECS[n.type].fields.some((f) => f.key === 'name')
    if (hasName && !(n.data.name || '').trim()) issues.push('name is empty')
    if (n.type === 'layer') {
      if (!edges.some((e) => e.to.node === n.id && e.to.pin === 'source')) issues.push('no source wired')
      if ((layDupes.get((n.data.name || '').trim()) ?? 0) > 1) issues.push('duplicate layer name')
    }
    if (n.type === 'source') {
      if (!(n.data.url || '').trim()) issues.push('url is empty')
      if ((srcDupes.get((n.data.name || '').trim()) ?? 0) > 1) issues.push('duplicate source name')
    }
    if (n.type === 'import' && !(n.data.path || '').trim()) issues.push('path is empty')
    if (n.type === 'map' && !edges.some((e) => e.to.node === n.id && e.to.pin === 'layers'))
      issues.push('no layers wired')
    if (issues.length) out.set(n.id, issues)
  }
  return out
}
