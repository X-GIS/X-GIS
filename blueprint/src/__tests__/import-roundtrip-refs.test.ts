import { describe, it, expect, vi } from 'vitest'
import { xgisToGraph } from '../import'
import { graphToXgis } from '../codegen'

function rt(src: string): string {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const out = graphToXgis(xgisToGraph(src))
  warn.mockRestore()
  return out
}

describe('blueprint round-trip: splice-imported style ref (#691)', () => {
  it('preserves a layer style: ref to an imported style', () => {
    const src = `import "./shared-styles.xgis"

source land { type: geojson url: "land.geojson" }

layer districts {
  source: land
  style: ocean_blue
  | opacity-80
}
`
    const g = xgisToGraph(src)
    const lay = g.nodes.find((n) => n.type === 'layer')!
    expect(lay.data.style).toBe('ocean_blue')
    expect(rt(src)).toContain('style: ocean_blue')
  })

  it('a wired style node still wins over the bare name', () => {
    const src = `style oceans { fill: blue-400 }

source land { type: geojson url: "land.geojson" }

layer districts {
  source: land
  style: oceans
  | opacity-80
}
`
    const g = xgisToGraph(src)
    const lay = g.nodes.find((n) => n.type === 'layer')!
    expect(lay.data.style).toBeUndefined()
    expect(rt(src)).toContain('style: oceans')
  })
})

describe('blueprint round-trip: named import (#692)', () => {
  it('keeps `import { a, b } from "path"` instead of dropping it', () => {
    const src = `import { railway_tie, cliff } from "./mod.xgis"

source land { type: geojson url: "land.geojson" }

layer l { source: land | fill-red-500 }
`
    const g = xgisToGraph(src)
    const imp = g.nodes.find((n) => n.type === 'import')
    expect(imp, 'named import node should exist').toBeTruthy()
    expect(imp!.data.mode).toBe('named')
    expect(imp!.data.names).toBe('railway_tie, cliff')
    expect(imp!.data.path).toBe('./mod.xgis')
    expect(rt(src)).toContain('import { railway_tie, cliff } from "./mod.xgis"')
  })

  it('splice import still works', () => {
    const src = `import "https://tiles.openfreemap.org/styles/bright"

source land { type: geojson url: "land.geojson" }

layer l { source: land | fill-red-500 }
`
    expect(rt(src)).toContain('import "https://tiles.openfreemap.org/styles/bright"')
  })
})
