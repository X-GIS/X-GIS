import { describe, it, expect, vi } from 'vitest'
import { xgisToGraph } from '../import'

// A no-URL geojson source is the converter's inline/missing-data stub.
// It (and layers wired to it) must be skipped so one bad source can't
// blank the whole imported style at runtime.
const SRC = `source maplibre {
  type: tilejson
  url: "https://demotiles.maplibre.org/tiles/tiles.json"
}

source crimea {
  type: geojson
}

layer countries {
  source: maplibre
  sourceLayer: "countries"
  | fill-#D6C7FF
}

layer crimea_fill {
  source: crimea
  | fill-#D6C7FF
}
`

describe('xgisToGraph — skips unusable no-URL geojson sources', () => {
  it('drops the urless geojson source and its dependent layer, keeps the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const g = xgisToGraph(SRC)
    warn.mockRestore()

    const sources = g.nodes.filter((n) => n.type === 'source')
    expect(sources.map((s) => s.data.name)).toEqual(['maplibre'])
    // no geojson source survives without a url
    expect(sources.some((s) => s.data.type === 'geojson' && !s.data.url.trim())).toBe(false)

    const layers = g.nodes.filter((n) => n.type === 'layer')
    expect(layers.map((l) => l.data.name)).toEqual(['countries'])

    // the kept layer is still wired to its source + the map sink
    const map = g.nodes.find((n) => n.type === 'map')!
    const lay = layers[0]
    expect(g.edges.some((e) => e.to.node === lay.id && e.to.pin === 'source')).toBe(true)
    expect(g.edges.some((e) => e.from.node === lay.id && e.to.node === map.id)).toBe(true)
    // no dangling edges referencing dropped nodes
    const ids = new Set(g.nodes.map((n) => n.id))
    expect(g.edges.every((e) => ids.has(e.from.node) && ids.has(e.to.node))).toBe(true)
  })
})
