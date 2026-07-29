// ═══ Selecting the stage entry AFTER lowering ≡ pruning it BEFORE (byte gate) ═══
//
// Every shader family here declares more entries than GLSL can spell — a module carries
// `fs_fill` AND `fs_fill_pattern`, `fs_line` AND `fs_line_max` AND `fs_line_pattern` —
// and GLSL allows exactly one `main` per stage. The families expressed that by DELETING
// the other entries from the module before each emit, which is exactly what made the two
// stages lower two different modules and therefore pay the optimizer fixpoint twice.
// Measured, that fixpoint is the whole cost: `buildPolygonModule` is 2 ms against 80 ms
// for the vertex emit alone.
//
// `emitGlslStages({ vertexEntry, fragmentEntry })` names the entry instead, so both
// stages share ONE lowering. That is only a legal substitution if naming-after produces
// the same bytes as pruning-before, which rests on a real property — every optimizer pass
// is per-FUNCTION, so a surviving func's body cannot depend on which other funcs were in
// the module — and on `stageScope` collecting the same helpers from the same kept entry.
//
// Neither is obvious enough to assume: `stageScope` walks the module, `sanitizeReservedIdents`
// renames against it, and a future cross-function pass (inlining, a global mangle) would
// silently break it. So this asserts the equality directly, per family, over the real
// shipped modules — the same discipline as hillshade-glsl-stages-parity, one level deeper.

import { describe, it, expect } from 'vitest'
import { configureProjections } from '../../shaders/dsl/projections'
import { PROJECTIONS } from '@xgis/geo'
import { emitPolygonGlsl, emitPolygonGlslStages } from '../../shaders/dsl/polygon'
import {
  emitCircleRetainedGlsl,
  emitCircleRetainedGlslStages,
} from '../../shaders/dsl/circle-retained'
import { emitIconRetainedGlsl, emitIconRetainedGlslStages } from '../../shaders/dsl/icon-retained'
import {
  emitArrowRetainedGlsl,
  emitArrowRetainedGlslStages,
  emitArrowRetainedAdvectedGlsl,
  emitArrowRetainedAdvectedGlslStages,
} from '../../shaders/dsl/arrow-retained'
import {
  emitParticleRetainedGlsl,
  emitParticleRetainedGlslStages,
} from '../../shaders/dsl/particle-retained'
import { emitIconGlsl, emitIconGlslStages } from '../../shaders/dsl/icon'
import { emitTextGlsl, emitTextGlslStages } from '../../shaders/dsl/text'
import { emitPointGlsl, emitPointGlslStages } from '../../shaders/dsl/point'

configureProjections(PROJECTIONS)

/** One family: the SHIPPED stages emitter and the per-stage emitter it must match
 *  byte-for-byte. Every entry here is a real draper call site, so a regression shows up
 *  as a failing family rather than a diffuse "some shader changed". */
const FAMILIES: ReadonlyArray<{
  id: string
  stages: () => { vertex: string; fragment: string }
  legacy: (stage: 'vertex' | 'fragment') => string
}> = [
  {
    id: 'polygon flat fill (VTR ground + bake)',
    stages: () => emitPolygonGlslStages(null, false),
    legacy: (s) => emitPolygonGlsl(null, false, s),
  },
  {
    id: 'polygon pick (VTR)',
    stages: () => emitPolygonGlslStages(null, true),
    legacy: (s) => emitPolygonGlsl(null, true, s),
  },
  {
    id: 'polygon fill-pattern (VTR ground twin, #1059)',
    stages: () => emitPolygonGlslStages(null, false, { fragment: 'fs_fill_pattern' }),
    legacy: (s) => emitPolygonGlsl(null, false, s, s === 'vertex' ? undefined : 'fs_fill_pattern'),
  },
  {
    id: 'polygon graticule line (#1062)',
    stages: () => emitPolygonGlslStages(null, false, { vertex: 'vs_main', fragment: 'fs_stroke' }),
    legacy: (s) => emitPolygonGlsl(null, false, s, s === 'vertex' ? 'vs_main' : 'fs_stroke'),
  },
  {
    id: 'circle retained',
    stages: emitCircleRetainedGlslStages,
    legacy: emitCircleRetainedGlsl,
  },
  { id: 'icon retained', stages: emitIconRetainedGlslStages, legacy: emitIconRetainedGlsl },
  { id: 'arrow retained', stages: emitArrowRetainedGlslStages, legacy: emitArrowRetainedGlsl },
  {
    id: 'arrow retained advected (#1419)',
    stages: emitArrowRetainedAdvectedGlslStages,
    legacy: emitArrowRetainedAdvectedGlsl,
  },
  {
    id: 'particle retained',
    stages: emitParticleRetainedGlslStages,
    legacy: emitParticleRetainedGlsl,
  },
  { id: 'icon', stages: emitIconGlslStages, legacy: emitIconGlsl },
  { id: 'text', stages: emitTextGlslStages, legacy: emitTextGlsl },
  { id: 'point', stages: emitPointGlslStages, legacy: emitPointGlsl },
]

describe('emitGlslStages entry selection is byte-identical to pruning before lowering', () => {
  it('covers every family a draper actually builds (a silent drop must fail loudly)', () => {
    expect(FAMILIES.length).toBeGreaterThanOrEqual(12)
  })

  for (const f of FAMILIES) {
    it(`${f.id}: both stages match the prune-first emitter`, () => {
      const both = f.stages()
      expect(both.vertex).toBe(f.legacy('vertex'))
      expect(both.fragment).toBe(f.legacy('fragment'))
    })
  }
})
