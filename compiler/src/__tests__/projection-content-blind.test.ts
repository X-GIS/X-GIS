// #1001 — the compiler is content-BLIND about map projection.
//
// WHICH projection to render is a runtime/content decision, not the style
// compiler's. The compiler must emit the style's projection AS-IS — the
// empty-string "unset" sentinel when the style names none — and let the runtime
// supply the Web Mercator default (map/src/render/viewport-mode-controller.ts
// `projectionName = 'mercator'`, projType 0). Nothing renders from this per-show
// field: the viewport projection is owned by the runtime, so an unset ('') value
// resolves to Web Mercator without the compiler ever baking a projection name.

import { describe, it, expect } from 'vitest'
import { Lexer, Parser, lower } from '../index'
import { emitCommands } from '../ir/emit-commands'

function projectionOf(source: string): string {
  const scene = lower(new Parser(new Lexer(source).tokenize()).parse())
  return emitCommands(scene).shows[0]!.projection
}

const base = (utilities: string) => `
source countries {
  type: geojson
  url: "x.geojson"
}

layer world {
  source: countries
  | fill-#ff0000${utilities}
}
`

describe('#1001 — compiler emits projection content-blind (unset → empty sentinel)', () => {
  it('a projection-less style emits the empty "unset" sentinel, NOT a baked mercator', () => {
    expect(projectionOf(base(''))).toBe('')
  })

  it('an explicit projection utility is emitted AS-IS (the style decides, not a default)', () => {
    expect(projectionOf(base(' projection-natural_earth'))).toBe('natural_earth')
  })
})
