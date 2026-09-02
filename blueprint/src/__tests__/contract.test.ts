import { describe, it, expect } from 'vitest'
import { Lexer, Parser } from '@xgis/compiler'
import { NODE_SPECS, starterGraph, uid, type BPGraph } from '../types'
import { graphToXgis } from '../codegen'
import { xgisToGraph } from '../import'

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
  preset: ['name', 'params', 'pipe'],
  fn: ['name', 'params', 'body'],
  struct: ['name', 'fields'],
  layer: ['name', 'sourceLayer', 'minzoom', 'maxzoom', 'filter', 'pipe', 'ramp', 'range'],
  background: ['fill'],
}

describe('@xgis/blueprint codegen contract', () => {
  it('all editor node types are present', () => {
    expect(Object.keys(NODE_SPECS).sort()).toEqual(
      [
        'background',
        'fn',
        'import',
        'input',
        'layer',
        'map',
        'preset',
        'reroute',
        'source',
        'struct',
        'symbol',
      ].sort(),
    )
  })

  for (const [type, keys] of Object.entries(FIELD_KEYS)) {
    it(`${type} keeps exact codegen field keys`, () => {
      expect(NODE_SPECS[type as keyof typeof NODE_SPECS].fields.map((f) => f.key)).toEqual(keys)
    })
  }

  it('layer keeps its 4 typed input pins', () => {
    // `style:` references a preset since the style+preset merge (#1072).
    expect(NODE_SPECS.layer.inputs.map((p) => `${p.id}:${p.type}`)).toEqual([
      'source:source',
      'style:preset',
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
    // Names match the starter graph defaults in src/types.ts —
    // commit 7e0e711 renamed `world → land` + `countries → continents`
    // so the default `url: "land.geojson"` resolves under both site
    // and playground (site/public/data ships land.geojson; playground/
    // public/data mirrors it under the same name).
    expect(src).toContain('source land')
    expect(src).toMatch(/layer continents/)
    expect(() => parses(src)).not.toThrow()
  })

  it('coverage ramp/range round-trip codegen → compiler → import (#2348)', () => {
    // #1158 INC-D made ramp/range real `layer` properties and
    // buildConstructSpec auto-surfaced them in the editor, but codegen and
    // import were never taught about them. The editor collected the values and
    // BOTH directions dropped them: export omitted the properties, and import
    // blanked them — so opening a hand-written coverage style and saving it
    // DESTROYED two properties of the user's file, silently.
    const l = {
      id: uid('n'),
      type: 'layer' as const,
      x: 0,
      y: 0,
      data: {
        name: 'speed',
        source: 'currents',
        sourceLayer: '',
        minzoom: '',
        maxzoom: '',
        filter: '',
        ramp: 'viridis',
        range: '[0, 2]',
        pipe: '',
      },
    }
    const src = graphToXgis({ nodes: [l], edges: [] })
    expect(src).toContain('ramp: "viridis"')
    expect(src).toContain('range: [0, 2]')
    // The emitted shape must be real X-GIS, not just the right substring.
    expect(() => parses(src)).not.toThrow()

    const back = xgisToGraph(src)
    const node = back.nodes.find((n) => n.type === 'layer')!
    expect(node.data.ramp).toBe('viridis')
    expect(node.data.range).toBe('[0, 2]')
  })

  it('a layer with no ramp/range emits neither property (#2348 guard)', () => {
    // The control: the emit is conditional on the same `?.trim()` truthiness
    // every other optional property uses, so every non-coverage layer's output
    // stays byte-identical. A fix that emitted `ramp: ""` would pass the
    // round-trip test above and corrupt every other style.
    const l = {
      id: uid('n'),
      type: 'layer' as const,
      x: 0,
      y: 0,
      data: {
        name: 'countries',
        source: 'world',
        sourceLayer: '',
        minzoom: '',
        maxzoom: '',
        filter: '',
        ramp: '',
        range: '   ',
        pipe: 'fill-blue-400',
      },
    }
    const src = graphToXgis({ nodes: [l], edges: [] })
    expect(src).not.toContain('ramp:')
    expect(src).not.toContain('range:')
    expect(() => parses(src)).not.toThrow()
  })

  it('parameterized presets round-trip codegen → compiler → import (#1536)', () => {
    const p = {
      id: uid('n'),
      type: 'preset' as const,
      x: 0,
      y: 0,
      data: { name: 'glow', params: 'color, radius', pipe: 'fill-[color] stroke-[radius]' },
    }
    const g: BPGraph = { nodes: [p], edges: [] }
    const src = graphToXgis(g)
    expect(src).toContain('preset glow(color, radius) {')
    expect(() => parses(src)).not.toThrow()

    const back = xgisToGraph(src)
    const node = back.nodes.find((n) => n.type === 'preset')!
    expect(node.data.params).toBe('color, radius')
  })

  it('fn nodes round-trip codegen → compiler → import (#1535)', () => {
    const f = {
      id: uid('n'),
      type: 'fn' as const,
      x: 0,
      y: 0,
      data: { name: 'halo', params: 'width, base', body: 'clamp(width * 1.5 + base, 1, 24)' },
    }
    const g: BPGraph = { nodes: [f], edges: [] }
    const src = graphToXgis(g)
    expect(src).toContain('fn halo(width, base) { return clamp(width * 1.5 + base, 1, 24) }')
    expect(() => parses(src)).not.toThrow()

    const back = xgisToGraph(src)
    const node = back.nodes.find((n) => n.type === 'fn')!
    expect(node.data.params).toBe('width, base')
    expect(node.data.body).toBe('clamp(width * 1.5 + base, 1, 24)')
  })

  it('struct nodes round-trip codegen → compiler → import (#1537)', () => {
    const s = {
      id: uid('n'),
      type: 'struct' as const,
      x: 0,
      y: 0,
      data: { name: 'Track', fields: 'speed: f32, name: string' },
    }
    const g: BPGraph = { nodes: [s], edges: [] }
    const src = graphToXgis(g)
    expect(src).toContain('struct Track { speed: f32, name: string }')
    expect(() => parses(src)).not.toThrow()

    const back = xgisToGraph(src)
    expect(back.nodes.find((n) => n.type === 'struct')!.data.fields).toBe(
      'speed: f32, name: string',
    )
  })

  it('reroute knots are transparent in codegen', () => {
    const s = {
      id: uid('n'),
      type: 'source' as const,
      x: 0,
      y: 0,
      data: { name: 'world', type: 'geojson', url: 'w.geojson', layers: '' },
    }
    const r1 = { id: uid('n'), type: 'reroute' as const, x: 0, y: 0, data: {} }
    const l = {
      id: uid('n'),
      type: 'layer' as const,
      x: 0,
      y: 0,
      data: {
        name: 'countries',
        sourceLayer: '',
        minzoom: '',
        maxzoom: '',
        filter: '',
        pipe: 'fill-blue-400',
      },
    }
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
