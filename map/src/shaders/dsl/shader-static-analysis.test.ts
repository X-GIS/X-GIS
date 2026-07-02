import { describe, it, expect } from 'vitest'
import { lintModule } from '@xgis/shader-dsl/dev'
import { getPROJECTION_MODULE } from './projections'
import { ICON_MODULE } from './icon'
import { TEXT_MODULE } from './text'
import { SDF_MODULE } from './sdf'
import { LOG_DEPTH_MODULE } from './log-depth'
import { buildLineModule } from './line'
import { buildRasterModule } from './raster'
import { buildPointModule } from './point'

// The full lint ruleset run over every DSL module we can reach directly — including the
// big render shaders (line / point / raster). The error gate is what validate() already
// enforces at emit; this centralises it + surfaces the warning inventory (style/perf
// findings) for the real shaders. (polygon is composed per-variant, so it stays gated
// inside emitPolygonWgsl rather than linted here.)
const modules = (): Record<string, ReturnType<typeof getPROJECTION_MODULE>> => ({
  projection: getPROJECTION_MODULE(),
  icon: ICON_MODULE,
  text: TEXT_MODULE,
  sdf: SDF_MODULE,
  'log-depth': LOG_DEPTH_MODULE,
  line: buildLineModule(false),
  raster: buildRasterModule(false),
  point: buildPointModule(),
})

describe('shader static analysis — full lint ruleset', () => {
  it('no reachable module has an error-severity diagnostic', () => {
    for (const [name, m] of Object.entries(modules())) {
      const errors = lintModule(m).filter((d) => d.severity === 'error')
      expect(errors, `${name}: ${errors.map((e) => `${e.ruleId} ${e.message}`).join(' | ')}`).toEqual([])
    }
  })

  it('surfaces the warning inventory (informational, not asserted)', () => {
    const warnings = Object.entries(modules()).flatMap(([name, m]) =>
      lintModule(m)
        .filter((d) => d.severity === 'warning')
        .map((d) => `${name}/${d.fn ?? '-'}: ${d.ruleId} — ${d.message}`),
    )
    console.log(`[shader-lint] ${warnings.length} warning(s) across reachable modules:\n${warnings.join('\n')}`)
    expect(Array.isArray(warnings)).toBe(true)
  })
})
