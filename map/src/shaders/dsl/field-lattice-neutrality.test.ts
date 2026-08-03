// ═══ The ground-lattice layer names no domain, and cannot start to (#1547) ═══
//
// `field-lattice.ts` + `field-lattice-uniform.ts` answer one question — "given a camera and a
// georeferenced grid domain, where are the ground nodes, where do they land on screen, and how big
// is one unit of grid-uv there?" — and that question has nothing to do with currents. Wind is the
// named next consumer; S-111 is simply the first.
//
// THE BOUNDARY IS ALREADY TRUE IN SUBSTANCE, which is exactly why it needs a gate rather than a
// comment. Neither module imports a band table, a glyph, or a catalogue today; the failure mode is
// not a wrong dependency, it is the NEXT change quietly reaching for one because the layer used to
// be called `arrow-view` and still feels like the arrow renderer's private property. A comment
// saying "keep this neutral" does not fail CI. This does.
//
// Two levels, because they fail differently:
//
//   • the SOURCE must not name a domain — an import, a type, a constant, a comment that presumes
//     the consumer draws an arrow;
//   • the EMITTED WGSL must not either, since the shader text is what a second consumer's module
//     splices in. A domain name that survives into the emit is a binding or a function a wind
//     module would have to adopt, or fork.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { module, emitModule } from '@xgis/shader-dsl'
import { getGpuProjectionFuncs, PROJECTION_CONSTS } from './projections'
import { UNPROJECT_FUNCS } from './unproject-dsl'
import { FIELD_LATTICE_FUNCS, fieldViewU } from './field-lattice'
import { pointU } from './point'

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

/** Words that name THIS domain rather than the lattice's own subject matter.
 *
 *  `band` and `knot` are the catalogue's; `arrow`, `scarow` and `glyph` are the portrayal's;
 *  `s111` and `current` name the product. `train`, `drift` and `phase` are here because they were
 *  the specific things that DID live in this module before #1547 — a streamline train is what one
 *  consumer makes of a node, not a property of the node. */
const DOMAIN = [
  'arrow',
  'scarow',
  's111',
  'glyph',
  'band',
  'knot',
  'train',
  'drift',
  'current',
] as const

/** Where a domain word is legitimate: prose explaining WHY the boundary exists has to name the
 *  thing on the other side of it, or the explanation is unreadable. Restricted to the header block
 *  and to lines that are explicitly about the split, so it cannot become a blanket exemption. */
const isBoundaryProse = (line: string): boolean =>
  /^\s*(\/\/|\*|\/\*)/.test(line) && /#1547|#1534|#1520|portrayal|consumer|neutral/i.test(line)

function offendingLines(text: string): string[] {
  return text.split('\n').filter((l) => {
    if (isBoundaryProse(l)) return false
    const lower = l.toLowerCase()
    return DOMAIN.some((w) => lower.includes(w))
  })
}

describe('the ground-lattice layer is domain-neutral (#1547)', () => {
  for (const [name, rel] of [
    ['field-lattice.ts', './field-lattice.ts'],
    ['field-lattice-uniform.ts', '../../render/field-lattice-uniform.ts'],
  ] as const) {
    it(`${name} names no domain`, () => {
      const bad = offendingLines(src(rel))
      expect(bad, `${name} reached for the S-111 domain:\n${bad.join('\n')}`).toEqual([])
    })
  }

  it('…and neither does the WGSL it emits — the text a second consumer splices in', () => {
    // Emitted on its own, with only what it genuinely depends on: the projection ladder, the
    // backward map, and the frame camera uniform. That this module ALONE produces a complete,
    // domain-free emit is the reusability claim, stated as an artifact rather than as an intention.
    const wgsl = emitModule(
      module({
        consts: [...PROJECTION_CONSTS],
        structs: [pointU.struct, fieldViewU.struct],
        bindings: [pointU.binding, fieldViewU.binding],
        funcs: [...getGpuProjectionFuncs(), ...UNPROJECT_FUNCS, ...FIELD_LATTICE_FUNCS],
      }),
    )
    const bad = DOMAIN.filter((w) => wgsl.toLowerCase().includes(w))
    expect(bad, `the emitted lattice WGSL names: ${bad.join(', ')}`).toEqual([])
    // …and it is a real emit, not an empty one that passes by having nothing in it.
    expect(wgsl).toContain('fn field_node_uv(')
    expect(wgsl).toContain('fn field_node_ndc(')
    expect(wgsl).toContain('fn field_uv_basis(')
    expect(wgsl).toContain('struct FieldView')
  })

  it('the fail-before: the gate FIRES on a domain word', () => {
    // Cut the specific mechanism (§12) — a gate that cannot go red is not a gate. Both levels are
    // exercised, because they read different text.
    expect(offendingLines('const ARROW_TRAIN_GLYPHS = 4')).toHaveLength(1)
    expect(offendingLines('/** the speed band, in knots */')).toHaveLength(1)
    expect(DOMAIN.filter((w) => 'fn arrow_node_uv()'.includes(w))).toEqual(['arrow'])
    // …and it does NOT fire on the lattice's own vocabulary, or it would be unsatisfiable.
    expect(
      offendingLines('export const FIELD_MAX_GROUND_NODES = 4096\nconst uv = gridUv(lonlat)'),
    ).toEqual([])
  })
})
