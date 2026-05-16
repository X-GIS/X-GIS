import { describe, it, expect } from 'vitest'
import { Lexer, Parser } from '@xgis/compiler'
import { NODE_SPECS, starterGraph, uid, type BPGraph } from '../types'
import { graphToXgis } from '../codegen'

const parses = (src: string) => {
  new Parser(new Lexer(src).tokenize()).parse()
}

// The schema-driven NODE_SPECS must keep the EXACT field keys and pin
// ids that codegen.ts emits/resolves. If the schema or overlay drifts
// these fail loudly.
const FIELD_KEYS: Record<string, string[]> = {
  import: ['mode', 'names', 'path'],
  source: ['name', 'type', 'url', 'layers'],
  symbol: ['name', 'path', 'anchor'],
  style: ['name', 'fill', 'stroke', 'strokeWidth', 'opacity'],
  preset: ['name', 'pipe'],
  fn: ['name', 'params', 'ret', 'body'],
  layer: ['name', 'sourceLayer', 'minzoom', 'maxzoom', 'filter', 'pipe'],
  background: ['fill'],
}

describe('@xgis/blueprint codegen contract', () => {
  it('all editor node types are present', () => {
    expect(Object.keys(NODE_SPECS).sort()).toEqual(
      ['background', 'fn', 'import', 'layer', 'map', 'preset', 'reroute', 'source', 'style', 'symbol'].sort(),
    )
  })

  for (const [type, keys] of Object.entries(FIELD_KEYS)) {
    it(`${type} keeps exact codegen field keys`, () => {
      expect(NODE_SPECS[type as keyof typeof NODE_SPECS].fields.map((f) => f.key)).toEqual(keys)
    })
  }

  it('layer keeps its 4 typed input pins', () => {
    expect(NODE_SPECS.layer.inputs.map((p) => `${p.id}:${p.type}`)).toEqual([
      'source:source',
      'style:style',
      'apply:preset',
      'symbol:symbol',
    ])
    expect(NODE_SPECS.layer.inputs.find((p) => p.id === 'apply')?.multi).toBe(true)
    expect(NODE_SPECS.layer.inputs.find((p) => p.id === 'source')?.required).toBe(true)
  })

  it('producing constructs expose an `out` pin; map/reroute keep their pins', () => {
    expect(NODE_SPECS.source.outputs).toEqual([{ id: 'out', label: 'source', type: 'source' }])
    expect(NODE_SPECS.layer.outputs[0]).toMatchObject({ id: 'out', type: 'layer' })
    expect(NODE_SPECS.map.inputs[0]).toMatchObject({ id: 'layers', type: 'layer', multi: true })
    expect(NODE_SPECS.map.singleton).toBe(true)
    expect(NODE_SPECS.reroute.passthrough).toBe(true)
    expect(NODE_SPECS.reroute.inputs[0].id).toBe('in')
    expect(NODE_SPECS.reroute.outputs[0].id).toBe('out')
  })

  it('starter graph round-trips through the real compiler', () => {
    const src = graphToXgis(starterGraph())
    expect(src).toContain('source world')
    expect(src).toMatch(/layer countries/)
    expect(() => parses(src)).not.toThrow()
  })

  it('reroute knots are transparent in codegen', () => {
    const s = { id: uid('n'), type: 'source' as const, x: 0, y: 0, data: { name: 'world', type: 'geojson', url: 'w.geojson', layers: '' } }
    const r1 = { id: uid('n'), type: 'reroute' as const, x: 0, y: 0, data: {} }
    const l = { id: uid('n'), type: 'layer' as const, x: 0, y: 0, data: { name: 'countries', sourceLayer: '', minzoom: '', maxzoom: '', filter: '', pipe: 'fill-blue-400' } }
    const r2 = { id: uid('n'), type: 'reroute' as const, x: 0, y: 0, data: {} }
    const m = { id: uid('n'), type: 'map' as const, x: 0, y: 0, data: { order: '' } }
    const g: BPGraph = {
      nodes: [s, r1, l, r2, m],
      edges: [
        { id: uid('e'), from: { node: s.id, pin: 'out' }, to: { node: r1.id, pin: 'in' } },
        { id: uid('e'), from: { node: r1.id, pin: 'out' }, to: { node: l.id, pin: 'source' } },
        { id: uid('e'), from: { node: l.id, pin: 'out' }, to: { node: r2.id, pin: 'in' } },
        { id: uid('e'), from: { node: r2.id, pin: 'out' }, to: { node: m.id, pin: 'layers' } },
      ],
    }
    const src = graphToXgis(g)
    expect(src).toContain('source: world')
    expect(src).toMatch(/layer countries/)
    expect(() => parses(src)).not.toThrow()
  })
})
