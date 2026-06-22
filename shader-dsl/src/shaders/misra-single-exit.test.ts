import { describe, it, expect } from 'vitest'
import { checkSingleExit } from '../core/passes/single-exit'
import { validate, ValidationError } from '../core/passes/validate'
import { fn, module, f32T, f32 } from '../core/ir'
import { getPROJECTION_MODULE } from './projections'
import { ICON_MODULE } from './icon'
import { TEXT_MODULE } from './text'
import { SDF_MODULE } from './sdf'
import { LOG_DEPTH_MODULE } from './log-depth'

// MISRA-C Rule 15.5 (single point of exit) as SHADER STATIC ANALYSIS over the DSL
// modules: every authored fn has exactly one return, as its final statement — or it
// carries a documented `allowEarlyReturn` deviation (the perf guards sdf_shape, and the
// projection dispatch hotspot). The render shaders (line / polygon / point / raster /
// heatmap …) are held to the SAME rule by validate(), which runs checkSingleExit at the
// top of every emit*Wgsl — so a regression there fails that shader's emit test. This file
// is the explicit, centralised view of the gate + its deviation set.

describe('MISRA single-exit — shader static analysis', () => {
  it('the projection module is single-exit (dispatch hotspot deviations documented)', () => {
    expect(getPROJECTION_MODULE().funcs.flatMap(checkSingleExit)).toEqual([])
  })

  for (const [name, m] of [
    ['icon', ICON_MODULE],
    ['text', TEXT_MODULE],
    ['sdf', SDF_MODULE],
    ['log-depth', LOG_DEPTH_MODULE],
  ] as const) {
    it(`the ${name} module is single-exit`, () => {
      expect(m.funcs.flatMap(checkSingleExit)).toEqual([])
    })
  }

  it('validate() is the live gate — an un-deviated early return throws ValidationError', () => {
    const bad = module({
      funcs: [
        fn('bad', { x: f32T }, f32T, (b, { x }) => {
          b.if(x.gt(f32(0)), (c) => { c.ret(x) }) // early return, no deviation
          b.ret(f32(0))
        }),
      ],
    })
    expect(() => validate(bad)).toThrow(ValidationError)
    expect(() => validate(bad)).toThrow(/single-exit/)
  })

  it('the same fn with a documented deviation passes', () => {
    const ok = module({
      funcs: [
        fn('ok', { x: f32T }, f32T, (b, { x }) => {
          b.if(x.gt(f32(0)), (c) => { c.ret(x) })
          b.ret(f32(0))
        }, { allowEarlyReturn: true }),
      ],
    })
    expect(() => validate(ok)).not.toThrow()
  })
})
