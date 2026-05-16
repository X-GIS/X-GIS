import { describe, it, expect } from 'vitest'
import { computeNodeIssues } from '../diagnostics'
import { uid, type BPEdge, type BPNode } from '../types'

const n = (type: BPNode['type'], data: Record<string, string>): BPNode => ({
  id: uid('n'),
  type,
  x: 0,
  y: 0,
  data,
})

describe('computeNodeIssues', () => {
  it('flags an empty name, missing url, and unwired layer/map', () => {
    const src = n('source', { name: '', type: 'geojson', url: '' })
    const lay = n('layer', { name: 'roads' })
    const map = n('map', {})
    const issues = computeNodeIssues([src, lay, map], [])
    expect(issues.get(src.id)).toEqual(expect.arrayContaining(['name is empty', 'url is empty']))
    expect(issues.get(lay.id)).toContain('no source wired')
    expect(issues.get(map.id)).toContain('no layers wired')
  })

  it('flags duplicate source / layer names', () => {
    const a = n('source', { name: 'world', url: 'a.geojson' })
    const b = n('source', { name: 'world', url: 'b.geojson' })
    const issues = computeNodeIssues([a, b], [])
    expect(issues.get(a.id)).toContain('duplicate source name')
    expect(issues.get(b.id)).toContain('duplicate source name')
  })

  it('a fully wired graph is clean', () => {
    const src = n('source', { name: 'world', type: 'geojson', url: 'w.geojson' })
    const lay = n('layer', { name: 'countries' })
    const map = n('map', {})
    const edges: BPEdge[] = [
      { id: uid('e'), from: { node: src.id, pin: 'out' }, to: { node: lay.id, pin: 'source' } },
      { id: uid('e'), from: { node: lay.id, pin: 'out' }, to: { node: map.id, pin: 'layers' } },
    ]
    const issues = computeNodeIssues([src, lay, map], edges)
    expect(issues.size).toBe(0)
  })
})
