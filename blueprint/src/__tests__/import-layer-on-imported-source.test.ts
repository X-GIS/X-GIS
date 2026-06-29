import { describe, it, expect, vi } from 'vitest'
import { xgisToGraph } from '../import'
import { graphToXgis } from '../codegen'
import { computeNodeIssues } from '../diagnostics'

// A layer that reads from a source brought in by a splice `import "url"`
// (e.g. `openmaptiles` from an OpenFreeMap / MapLibre style). The import
// node has no source node to wire to, so the reference must survive as a
// bare name on the layer — otherwise the round-trip orphans the layer.
const SRC = `import "https://tiles.openfreemap.org/styles/bright"

layer my_water {
  source: openmaptiles
  sourceLayer: "water"
  | fill-red-500 opacity-50
}
`

describe('blueprint: layer referencing a splice-imported source', () => {
  it('round-trips the source reference instead of dropping it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const g = xgisToGraph(SRC)
    warn.mockRestore()

    const lay = g.nodes.find((n) => n.type === 'layer')!
    expect(lay.data.source).toBe('openmaptiles')

    const out = graphToXgis(g)
    expect(out).toContain('source: openmaptiles')
    expect(out).not.toContain('no source wired')
  })

  it('does not flag the layer as "no source wired"', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const g = xgisToGraph(SRC)
    warn.mockRestore()
    const lay = g.nodes.find((n) => n.type === 'layer')!
    const issues = computeNodeIssues(g.nodes, g.edges).get(lay.id) ?? []
    expect(issues).not.toContain('no source wired')
  })

  it('a wired source node still takes precedence over the bare name', () => {
    // local source + layer wired to it: data.source stays unset, wire wins
    const local = `source land { type: geojson url: "land.geojson" }

layer continents {
  source: land
  | fill-blue-400
}
`
    const g = xgisToGraph(local)
    const lay = g.nodes.find((n) => n.type === 'layer')!
    expect(lay.data.source).toBeUndefined()
    expect(graphToXgis(g)).toContain('source: land')
  })
})
