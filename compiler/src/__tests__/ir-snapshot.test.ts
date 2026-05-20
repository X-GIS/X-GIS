// IR shape snapshot tests. Pins the converter output for each of the
// 4 production-style fixtures so silent IR changes (a converter pass
// that drops or wraps a property differently) get caught at PR time
// even when the regenerated style still loads and looks plausible.
//
// Snapshots live in vitest's inline format so reviewers see the diff
// directly in the PR. Update via:
//   bunx vitest run compiler/src/__tests__/ir-snapshot.test.ts -u

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'

const FIXTURE_DIR = join(__dirname, 'fixtures')

function compileToIR(stylePath: string) {
  const raw = readFileSync(join(FIXTURE_DIR, stylePath), 'utf8')
  const style = JSON.parse(raw)
  const xgis = convertMapboxStyle(style)
  const tokens = new Lexer(xgis).tokenize()
  const ast = new Parser(tokens).parse()
  return lower(ast)
}

// Strip volatile / verbose fields from IR before snapshotting so the
// signal-to-noise stays high. We care about counts + types + filter
// shape, not literal coordinates or full expression ASTs.
function summariseIR(ir: ReturnType<typeof lower>) {
  return {
    sourceCount: ir.sources?.length ?? 0,
    sourceTypes: (ir.sources ?? []).map(s => (s as { kind?: string }).kind ?? 'unknown').sort(),
    renderNodeCount: ir.renderNodes?.length ?? 0,
    renderNodeKinds: (ir.renderNodes ?? [])
      .map(rn => (rn as { kind?: string }).kind ?? 'unknown')
      .reduce<Record<string, number>>((acc, k) => { acc[k] = (acc[k] ?? 0) + 1; return acc }, {}),
    symbolCount: ir.symbols?.length ?? 0,
    hasBackground: !!(ir as { background?: unknown }).background,
    diagnosticCount: ir.diagnostics?.length ?? 0,
  }
}

describe('IR snapshot — production fixtures', () => {
  it('maplibre-demotiles compiles to a stable IR shape', () => {
    const ir = compileToIR('maplibre-demotiles.json')
    expect(summariseIR(ir)).toMatchInlineSnapshot(`
      {
        "diagnosticCount": 0,
        "hasBackground": false,
        "renderNodeCount": 15,
        "renderNodeKinds": {
          "unknown": 15,
        },
        "sourceCount": 2,
        "sourceTypes": [
          "unknown",
          "unknown",
        ],
        "symbolCount": 0,
      }
    `)
  })

  it('openfreemap-bright compiles to a stable IR shape', () => {
    const ir = compileToIR('openfreemap-bright.json')
    expect(summariseIR(ir)).toMatchInlineSnapshot(`
      {
        "diagnosticCount": 0,
        "hasBackground": false,
        "renderNodeCount": 121,
        "renderNodeKinds": {
          "unknown": 121,
        },
        "sourceCount": 1,
        "sourceTypes": [
          "unknown",
        ],
        "symbolCount": 0,
      }
    `)
  })

  it('openfreemap-liberty compiles to a stable IR shape', () => {
    const ir = compileToIR('openfreemap-liberty.json')
    expect(summariseIR(ir)).toMatchInlineSnapshot(`
      {
        "diagnosticCount": 0,
        "hasBackground": false,
        "renderNodeCount": 113,
        "renderNodeKinds": {
          "unknown": 113,
        },
        "sourceCount": 2,
        "sourceTypes": [
          "unknown",
          "unknown",
        ],
        "symbolCount": 0,
      }
    `)
  })

  it('openfreemap-positron compiles to a stable IR shape', () => {
    const ir = compileToIR('openfreemap-positron.json')
    expect(summariseIR(ir)).toMatchInlineSnapshot(`
      {
        "diagnosticCount": 0,
        "hasBackground": false,
        "renderNodeCount": 57,
        "renderNodeKinds": {
          "unknown": 57,
        },
        "sourceCount": 1,
        "sourceTypes": [
          "unknown",
        ],
        "symbolCount": 0,
      }
    `)
  })
})
