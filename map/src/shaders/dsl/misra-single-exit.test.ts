import { describe, it, expect } from 'vitest'
import { checkSingleExit } from '@xgis/shader-dsl/dev'
import { lintModule } from '@xgis/shader-dsl/dev'
import { fn, module, f32T, f32 } from '@xgis/shader-dsl'
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

  // single-exit is a LINT rule (lintModule / full ruleset), NOT an emit-time validate()
  // gate — validate runs only CORE_RULES so it never false-flags a legitimately
  // early-returning compute kernel (e.g. eval_match).
  it('lintModule flags an un-deviated early return as a single-exit error', () => {
    const bad = module({
      funcs: [
        fn('bad', { x: f32T }, f32T, ({ x }, b) => {
          b.if(x.gt(f32(0)), (c) => { c.ret(x) }) // early return, no deviation
          b.ret(f32(0))
        }),
      ],
    })
    const errs = lintModule(bad).filter((d) => d.ruleId === 'single-exit')
    expect(errs.length).toBeGreaterThan(0)
    expect(errs[0].severity).toBe('error')
  })

  it('the same fn with a documented deviation has no single-exit diagnostic', () => {
    const ok = module({
      funcs: [
        fn('ok', { x: f32T }, f32T, ({ x }, b) => {
          b.if(x.gt(f32(0)), (c) => { c.ret(x) })
          b.ret(f32(0))
        }, { allowEarlyReturn: true }),
      ],
    })
    expect(lintModule(ok).filter((d) => d.ruleId === 'single-exit')).toEqual([])
  })
})
