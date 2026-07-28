// ═══ The SHIPPED hillshade GLSL is byte-unchanged by the shared-lowering emit ═══
//
// HillshadeDraper.materialFor switched from two emitGlslModule calls to one
// emitGlslStages call, which lowers + runs the optimizer fixpoint ONCE instead of once
// per stage. That is a pure first-paint win only if the bytes are identical: measured
// on this module, the old form cost 1605-1887 ms for `multidirectional` against
// 492-558 ms for the new one, and a shader that is 3x faster to build but one byte
// different is a silent render change, not an optimisation.
//
// shader-dsl's own glsl-stages-parity.test.ts pins the substitution over the example
// corpus. This pins it over the module that actually SHIPS — every specialised method
// plus the pick variant, which is both the largest fragment in the map and the one whose
// 5-way body made the cost visible in the first place.

import { describe, it, expect } from 'vitest'
import { emitGlslModule, emitGlslStages } from '@xgis/shader-dsl'
import { buildHillshadeModule } from '../../shaders/dsl/hillshade'
import { configureProjections } from '../../shaders/dsl/projections'
import { PROJECTIONS } from '@xgis/geo'

configureProjections(PROJECTIONS)

const METHODS = ['standard', 'basic', 'combined', 'igor', 'multidirectional']

describe('hillshade GLSL: shared lowering is byte-identical to per-stage lowering', () => {
  for (const pick of [false, true]) {
    for (let flag = 0; flag < METHODS.length; flag++) {
      it(`${METHODS[flag]}${pick ? ' (pick)' : ''}: both stages match emitGlslModule`, () => {
        const mod = buildHillshadeModule(pick, flag)
        const both = emitGlslStages(mod)
        expect(both.vertex).toBe(emitGlslModule(mod, 'vertex'))
        expect(both.fragment).toBe(emitGlslModule(mod, 'fragment'))
      })
    }
  }

  it('the un-specialised (5-way dispatch) module is covered too', () => {
    // methodFlag < 0 keeps the runtime `when` chain. Not built by any draper today —
    // specialisation is unconditional — but it is the fallback the builder still
    // supports, so a lowering that only broke on the branchy body would slip past.
    const mod = buildHillshadeModule(false, -1)
    const both = emitGlslStages(mod)
    expect(both.vertex).toBe(emitGlslModule(mod, 'vertex'))
    expect(both.fragment).toBe(emitGlslModule(mod, 'fragment'))
  })
})
