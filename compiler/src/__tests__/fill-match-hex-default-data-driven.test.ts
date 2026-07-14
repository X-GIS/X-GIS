// #725 — a per-feature `fill match(.field) { …, _ -> <default> }` must lower to
// `{ kind: 'data-driven' }` REGARDLESS of how the default arm is spelled.
//
// Pre-fix, lower-bindings-fill collapsed the whole match to a CONSTANT of the
// `_` arm whenever that arm was a resolvable hex (`extractMatchDefaultColor`) —
// a placeholder from before the per-feature fill path (compiled variant +
// feat_data[fid]) existed. A Tailwind-token default fell through to data-driven
// and rendered per-feature, so behaviour silently depended on `#hex` vs token
// spelling. The collapse gate (`bypassExtractMatchDefaultColor`) is retired;
// the match AST still carries its own `_` arm, so unmatched features get the
// default INSIDE the variant instead of the default swallowing the layer.
//
// (Mapbox-converted styles usually never reach this arm — expand-color-match
// splits a fill-color match into per-colour sublayers at convert time. This is
// the direct-authored `.xgis` path, e.g. playground continent-match.)

import { describe, it, expect } from 'vitest'
import { Lexer, Parser, lower } from '../index'
import { evaluate } from '../eval/evaluator'
import { withPragma } from './_pragma'

const src = (defaultArm: string) => `
source countries {
  type: geojson
  url: "x.geojson"
}

layer continents {
  source: countries
  | fill match(.CONTINENT) {
      "Africa" -> #ff0000,
      "Asia"   -> #00ff00,
      _        -> ${defaultArm}
    }
}
`

function fillOf(source: string) {
  const scene = lower(new Parser(new Lexer(withPragma(source)).tokenize()).parse())
  return scene.renderNodes[0]!.fill
}

describe('#725 — hex-default fill match stays data-driven (symmetric with token default)', () => {
  it('a #hex default arm no longer collapses the match to a constant', () => {
    expect(fillOf(src('#888888')).kind).toBe('data-driven')
  })

  it('a token default arm lowers identically (the previously-working asymmetric twin)', () => {
    expect(fillOf(src('gray-400')).kind).toBe('data-driven')
  })
})

describe('#725 — hex-default fill match bakes >=2 distinct per-feature colours (pack level)', () => {
  it('the data-driven fill expr evaluates to a distinct colour per feature — no collapse to the default', () => {
    // Lowering keeps the match data-driven (above); this pins the
    // downstream intent. The per-feature bake — the worker / GPU variant
    // runs the SAME match AST through evaluate() per feature — must yield
    // distinct colours, not the single collapsed default the retired
    // constant path produced.
    const fill = fillOf(src('#888888'))
    expect(fill.kind).toBe('data-driven')
    if (fill.kind !== 'data-driven') throw new Error('expected data-driven fill')
    const colours = ['Africa', 'Asia', 'Europe'].map((c) =>
      evaluate(fill.expr.ast, { CONTINENT: c }),
    )
    expect(colours).toEqual(['#ff0000', '#00ff00', '#888888'])
    expect(new Set(colours).size).toBeGreaterThanOrEqual(2)
  })
})
