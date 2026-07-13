// ═══ map ↔ render-loop value-import cycle stays broken (co-located, #1005) ═══
//
// map.ts VALUE-imports render-loop.ts; a value import of ./map from
// render-loop.ts re-forms the runtime cycle. `import type` is erased by tsc,
// so it does not. The original gate (runtime arch-invariants Gate 2) asserts
// this over a file that lives HERE in @xgis/map — but the gate itself sits in
// the retiring runtime/ tree and evaporates with it (#1005). This is the
// co-located successor (regex carried verbatim; see commit 605479a5 for the
// original cycle break).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

describe('map ↔ render-loop value-import cycle stays broken (#1005 Gate-2 port)', () => {
  it('render-loop.ts imports ./map as `import type` only', () => {
    const s = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'render-loop.ts'), 'utf8')
    const valueImport = /^\s*import\s+(?!type\b)[^\n]*from\s+['"]\.\/map['"]/m
    expect(
      valueImport.test(s),
      'render-loop.ts must import ./map with `import type` only (see commit 605479a5) — ' +
        'a value import re-creates the map↔render-loop runtime cycle',
    ).toBe(false)
  })

  it('the gate is non-vacuous: render-loop.ts does reference ./map (as a type import)', () => {
    // If the ./map import disappears entirely (refactor), this fails loudly so
    // the gate is re-pointed instead of passing green-while-dead (#996 lesson).
    const s = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'render-loop.ts'), 'utf8')
    expect(/from\s+['"]\.\/map['"]/.test(s)).toBe(true)
  })
})
