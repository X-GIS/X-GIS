import { describe, it, expect } from 'vitest'
import { xgisToGraph } from '../import'
import { graphToXgis } from '../codegen'

// A splice `import "url" keep (...)` layer-subset clause has no editor field, so
// (like the source:/style: fallbacks in #688/#691) it rides on the import
// node's data verbatim and must survive a visual-editor round-trip — otherwise
// the filter is silently dropped when a keep-style is opened and re-saved.

describe('blueprint: splice import `keep (...)` clause round-trip', () => {
  it('captures a next-line keep clause into the import node', () => {
    const g = xgisToGraph(`import "https://tiles.openfreemap.org/styles/bright"
  keep (transportation, place)`)
    const imp = g.nodes.find((n) => n.type === 'import')!
    expect(imp.data.mode).toBe('splice')
    expect(imp.data.keep).toBe('transportation, place')
  })

  it('captures a same-line keep clause and unwraps quoted names', () => {
    const g = xgisToGraph(`import "s" keep (water, "transportation_name")`)
    expect(g.nodes.find((n) => n.type === 'import')!.data.keep).toBe('water, transportation_name')
  })

  it('emits the keep clause and round-trips stably', () => {
    const once = graphToXgis(xgisToGraph(`import "s" keep (transportation, place)`))
    expect(once).toContain('import "s" keep (transportation, place)')
    // Re-parsing the emitted output keeps the clause (no drift on re-open).
    const twice = xgisToGraph(once)
    expect(twice.nodes.find((n) => n.type === 'import')!.data.keep).toBe('transportation, place')
  })

  it('a plain splice import carries no keep and is unchanged', () => {
    const g = xgisToGraph(`import "s"`)
    expect(g.nodes.find((n) => n.type === 'import')!.data.keep).toBeUndefined()
    expect(graphToXgis(g)).toContain('import "s"')
  })
})
