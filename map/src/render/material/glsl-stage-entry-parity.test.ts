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
} from '../../shaders/dsl/arrow-retained'
import {
  emitArrowRetainedAdvectedGlsl,
  emitArrowRetainedAdvectedGlslStages,
} from '../../shaders/dsl/arrow-advected'
import {
  emitParticleRetainedGlsl,
  emitParticleRetainedGlslStages,
} from '../../shaders/dsl/particle-retained'
import { emitIconGlsl, emitIconGlslStages } from '../../shaders/dsl/icon'
import { emitTextGlsl, emitTextGlslStages } from '../../shaders/dsl/text'
import { emitPointGlsl, emitPointGlslStages } from '../../shaders/dsl/point'
import { emitHeatmapAccumGlsl, emitHeatmapAccumGlslStages } from '../../shaders/dsl/heatmap-accum'
import { emitHeatmapBlurGlsl, emitHeatmapBlurGlslStages } from '../../shaders/dsl/heatmap-blur'
import {
  emitHeatmapComposeGlsl,
  emitHeatmapComposeGlslStages,
} from '../../shaders/dsl/heatmap-compose'
import { emitFlowAdvectGlsl, emitFlowAdvectGlslStages } from '../../shaders/dsl/flow-advect'
import { emitGlslModule, emitGlslStages, fn, f32T, f32, boolT } from '@xgis/shader-dsl'
import { buildRasterModule } from '../../shaders/dsl/raster'
import { buildUnderOccluderModule } from '../../shaders/dsl/under-occluder'
import { buildCoverageModule } from '../../shaders/dsl/coverage-ramp'
import { COVERAGE_FILTER_FN } from '../../shaders/dsl/coverage-filter'

/** A stand-in for a compiled `filter:` predicate — the SHAPE a style produces
 *  (`FnHandle<{v, zoom}, 'bool'>` under the name the coverage module calls), built by hand
 *  so this gate needs no dependency on the style compiler. What matters here is only that
 *  the fragment scope gains a callee: the two spellings differ in lowering ORDER (stages
 *  lowers the whole module once and splits; the legacy pair prunes to the stage and lowers
 *  twice), so a module-global optimizer effect could in principle move VERTEX bytes when a
 *  fragment-only function is present. The filter-free row cannot see that; this one can. */
const probeFilter = () =>
  fn(COVERAGE_FILTER_FN, { v: f32T, zoom: f32T }, boolT, ({ v, zoom }) => v.gt(zoom.mul(f32(0.5))))

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
  {
    id: 'point',
    stages: () => emitPointGlslStages(null),
    legacy: (s) => emitPointGlsl(null, s),
  },
  // raster + under-occluder go through the GENERIC shader-dsl emitters (no per-family
  // `emit…Glsl` wrapper), which is why they were absent here. They belong for two
  // reasons. `raster-material.ts` moved from two `emitGlslModule` calls to one
  // `emitGlslStages` (#1473 residue, this change) — these rows are what proves that move
  // is BYTE-NEUTRAL for the shipped raster shader, which shader-dsl's own
  // glsl-stages-parity cannot, since it runs over the example corpus and not over these
  // modules. And `shaders/baked/registry.ts` bakes both families, spelling raster the
  // `emitGlslStages` way and under-occluder the per-stage way because that is what each
  // draper spells; the substitution being free is exactly this assertion.
  {
    id: 'raster (raster-material, both pick states are one module each)',
    stages: () => emitGlslStages(buildRasterModule(false)),
    legacy: (s) => emitGlslModule(buildRasterModule(false), s),
  },
  {
    id: 'raster pick (rg32uint MRT twin)',
    stages: () => emitGlslStages(buildRasterModule(true)),
    legacy: (s) => emitGlslModule(buildRasterModule(true), s),
  },
  {
    id: 'under-occluder (under-occluder-renderer)',
    stages: () => emitGlslStages(buildUnderOccluderModule(false)),
    legacy: (s) => emitGlslModule(buildUnderOccluderModule(false), s),
  },
  {
    id: 'under-occluder pick',
    stages: () => emitGlslStages(buildUnderOccluderModule(true)),
    legacy: (s) => emitGlslModule(buildUnderOccluderModule(true), s),
  },
  // #1679 increment 0 — the five families whose drapers moved to a one-lowering GLSL half in
  // the same change. The three heatmap passes and flow-advect grew their own `…GlslStages`
  // emitter (each carrying the GL twin `vsFullGl`, not the WGSL `vsFull`); coverage goes
  // through the GENERIC emitters like raster / under-occluder above. Coverage's `filter` is
  // style-derived and OPEN-set, so what is pinned here is the FILTER-FREE module — the
  // substitution's validity is a property of the emitter pair, not of the predicate, and a
  // filter only adds one more callee to the fragment scope.
  {
    id: 'coverage ramp, no filter (coverage-material)',
    stages: () => emitGlslStages(buildCoverageModule()),
    legacy: (s) => emitGlslModule(buildCoverageModule(), s),
  },
  {
    // The shape a coverage draper ACTUALLY builds in production — `filter` is optional, so
    // both rows ship. Probed against two real compiled predicates before being written as a
    // hand-built one; the emitter pair held for both.
    id: 'coverage ramp, WITH a filter predicate (coverage-material)',
    stages: () => emitGlslStages(buildCoverageModule(probeFilter())),
    legacy: (s) => emitGlslModule(buildCoverageModule(probeFilter()), s),
  },
  { id: 'heatmap accum', stages: emitHeatmapAccumGlslStages, legacy: emitHeatmapAccumGlsl },
  { id: 'heatmap blur', stages: emitHeatmapBlurGlslStages, legacy: emitHeatmapBlurGlsl },
  { id: 'heatmap compose', stages: emitHeatmapComposeGlslStages, legacy: emitHeatmapComposeGlsl },
  { id: 'flow advect (IBFV)', stages: emitFlowAdvectGlslStages, legacy: emitFlowAdvectGlsl },
]

describe('emitGlslStages entry selection is byte-identical to pruning before lowering', () => {
  it('covers every family a draper actually builds (a silent drop must fail loudly)', () => {
    expect(FAMILIES.length).toBeGreaterThanOrEqual(22)
  })

  for (const f of FAMILIES) {
    it(`${f.id}: both stages match the prune-first emitter`, () => {
      const both = f.stages()
      expect(both.vertex).toBe(f.legacy('vertex'))
      expect(both.fragment).toBe(f.legacy('fragment'))
    })
  }
})

// ═══ #1592 — a needsFeatureBuffer polygon variant emits GLSL (no opt-in needed) ═══
//
// `needsFeatureBuffer: true` appends the `feat_data` storage binding, and WebGL2 has no
// SSBO. The GLSL backend's storage→data-texture lowering used to be opt-in per call site,
// and this emitter never passed the flag — so every data-driven polygon variant threw
// `UnsupportedFeatureError: … missing capabilities: storageBuffer` on the WebGL2 path.
// The lowering is now default-on (#1647), so the emitter needs no change: this pins the
// consumer end of that contract. The null-variant control emits as it always did — the
// byte-neutrality of a storage-FREE module is pinned by the shader-dsl emit goldens.
describe('emitPolygonGlslStages — a feat_data variant emits on the WebGL2 path (#1592)', () => {
  const featVariant = {
    preamble: null,
    fillExpr: null,
    strokeExpr: null,
    fillPreamble: null,
    strokePreamble: null,
    needsFeatureBuffer: true,
  } as const

  it('emits both stages instead of fail-closing on the storage binding', () => {
    const both = emitPolygonGlslStages(featVariant, false)
    expect(both.vertex.startsWith('#version 300 es')).toBe(true)
    expect(both.fragment.startsWith('#version 300 es')).toBe(true)
  })

  it('the null-variant control still emits (no storage binding, untouched path)', () => {
    const both = emitPolygonGlslStages(null, false)
    expect(both.vertex.startsWith('#version 300 es')).toBe(true)
    expect(both.fragment.startsWith('#version 300 es')).toBe(true)
  })
})
