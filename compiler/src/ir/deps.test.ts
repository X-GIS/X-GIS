// ═══════════════════════════════════════════════════════════════════
// deps.ts — DepBits derivation tests
// ═══════════════════════════════════════════════════════════════════
//
// Locks in the four-axis bitset mapping for every PropertyShape +
// ColorValue kind. Each case asserts both the bit value (cheap exact
// match) and the `formatDeps` string (readable failure message), so
// regressions in either layer surface immediately.

import { describe, expect, it } from 'vitest'
import {
  Dep,
  DEPS_NONE,
  DEPS_ZOOM,
  DEPS_TIME,
  DEPS_FEATURE,
  DEPS_ZOOM_TIME,
  depsSubsetOf,
  formatDeps,
  getColorDeps,
  getDataExprDeps,
  getPropertyShapeDeps,
  hasDep,
  mergeDeps,
} from './deps'
import type { ColorValue, DataExpr, ZoomStop, TimeStop } from './render-node'
import type { PropertyShape, RGBA } from './property-types'

const RED: RGBA = [1, 0, 0, 1]
const BLUE: RGBA = [0, 0, 1, 1]

const zoomStop = <T,>(zoom: number, value: T): ZoomStop<T> => ({ zoom, value })
const timeStop = <T,>(timeMs: number, value: T): TimeStop<T> => ({ timeMs, value })

describe('deps — bitset constants', () => {
  it('NONE is zero', () => {
    expect(DEPS_NONE).toBe(0)
  })

  it('ZOOM, TIME, FEATURE are disjoint single bits', () => {
    expect(DEPS_ZOOM & DEPS_TIME).toBe(0)
    expect(DEPS_ZOOM & DEPS_FEATURE).toBe(0)
    expect(DEPS_TIME & DEPS_FEATURE).toBe(0)
  })

  it('mergeDeps unions bits', () => {
    expect(mergeDeps(DEPS_ZOOM, DEPS_TIME)).toBe(DEPS_ZOOM_TIME)
    expect(mergeDeps(DEPS_NONE, DEPS_FEATURE)).toBe(DEPS_FEATURE)
    expect(mergeDeps(DEPS_FEATURE, DEPS_FEATURE)).toBe(DEPS_FEATURE)
  })

  it('hasDep tests membership', () => {
    expect(hasDep(DEPS_ZOOM_TIME, Dep.ZOOM)).toBe(true)
    expect(hasDep(DEPS_ZOOM_TIME, Dep.TIME)).toBe(true)
    expect(hasDep(DEPS_ZOOM_TIME, Dep.FEATURE)).toBe(false)
    expect(hasDep(DEPS_NONE, Dep.ZOOM)).toBe(false)
  })

  it('depsSubsetOf', () => {
    expect(depsSubsetOf(DEPS_NONE, DEPS_ZOOM)).toBe(true)
    expect(depsSubsetOf(DEPS_ZOOM, DEPS_ZOOM_TIME)).toBe(true)
    expect(depsSubsetOf(DEPS_FEATURE, DEPS_ZOOM)).toBe(false)
    expect(depsSubsetOf(DEPS_ZOOM, DEPS_ZOOM)).toBe(true)
  })

  it('formatDeps is stable and readable', () => {
    expect(formatDeps(DEPS_NONE)).toBe('none')
    expect(formatDeps(DEPS_ZOOM)).toBe('zoom')
    expect(formatDeps(DEPS_TIME)).toBe('time')
    expect(formatDeps(DEPS_FEATURE)).toBe('feature')
    expect(formatDeps(DEPS_ZOOM_TIME)).toBe('zoom+time')
    expect(formatDeps(mergeDeps(DEPS_ZOOM, DEPS_FEATURE))).toBe('zoom+feature')
    expect(formatDeps(mergeDeps(DEPS_ZOOM_TIME, DEPS_FEATURE))).toBe('zoom+time+feature')
  })
})

describe('deps — ColorValue', () => {
  it('constant → NONE', () => {
    const v: ColorValue = { kind: 'constant', rgba: RED }
    expect(getColorDeps(v)).toBe(DEPS_NONE)
  })

  it('none → NONE', () => {
    const v: ColorValue = { kind: 'none' }
    expect(getColorDeps(v)).toBe(DEPS_NONE)
  })

  it('zoom-interpolated → ZOOM', () => {
    const v: ColorValue = {
      kind: 'zoom-interpolated',
      stops: [zoomStop(2, RED), zoomStop(10, BLUE)],
    }
    expect(getColorDeps(v)).toBe(DEPS_ZOOM)
  })

  it('time-interpolated → TIME', () => {
    const v: ColorValue = {
      kind: 'time-interpolated',
      base: RED,
      stops: [timeStop(0, RED), timeStop(1000, BLUE)],
      loop: true,
      easing: 'linear',
      delayMs: 0,
    }
    expect(getColorDeps(v)).toBe(DEPS_TIME)
  })

  it('data-driven match(.field) → FEATURE', () => {
    // match() with a field access classifies as per-feature-gpu →
    // bitset reports FEATURE.
    const expr: DataExpr = {
      ast: {
        kind: 'FnCall',
        callee: { kind: 'Identifier', name: 'match' },
        args: [{ kind: 'FieldAccess', object: null as never, name: 'class' }],
        matchBlock: {
          arms: [{ pattern: 'school', value: { kind: 'ColorLiteral', value: '#f00' } }],
          fallback: { kind: 'ColorLiteral', value: '#fff' },
        } as never,
      } as never,
    }
    expect(getColorDeps({ kind: 'data-driven', expr })).toBe(DEPS_FEATURE)
  })

  it('conditional → FEATURE (field-match) + recurse on branches', () => {
    const conditional: ColorValue = {
      kind: 'conditional',
      branches: [
        { field: 'school', value: { kind: 'constant', rgba: RED } },
        // Inner zoom-stops contributes ZOOM as well.
        {
          field: 'hospital',
          value: {
            kind: 'zoom-interpolated',
            stops: [zoomStop(0, BLUE), zoomStop(20, RED)],
          },
        },
      ],
      fallback: { kind: 'constant', rgba: BLUE },
    }
    const deps = getColorDeps(conditional)
    expect(hasDep(deps, Dep.FEATURE)).toBe(true)
    expect(hasDep(deps, Dep.ZOOM)).toBe(true)
    expect(hasDep(deps, Dep.TIME)).toBe(false)
  })
})

describe('deps — PropertyShape<number>', () => {
  it('constant → NONE', () => {
    const s: PropertyShape<number> = { kind: 'constant', value: 1.0 }
    expect(getPropertyShapeDeps(s)).toBe(DEPS_NONE)
  })

  it('zoom-interpolated → ZOOM', () => {
    const s: PropertyShape<number> = {
      kind: 'zoom-interpolated',
      stops: [zoomStop(2, 1), zoomStop(10, 4)],
    }
    expect(getPropertyShapeDeps(s)).toBe(DEPS_ZOOM)
  })

  it('time-interpolated → TIME', () => {
    const s: PropertyShape<number> = {
      kind: 'time-interpolated',
      stops: [timeStop(0, 0), timeStop(1000, 1)],
      loop: false,
      easing: 'ease-in-out',
      delayMs: 0,
    }
    expect(getPropertyShapeDeps(s)).toBe(DEPS_TIME)
  })

  it('zoom-time → ZOOM+TIME', () => {
    const s: PropertyShape<number> = {
      kind: 'zoom-time',
      zoomStops: [zoomStop(0, 0), zoomStop(20, 1)],
      timeStops: [timeStop(0, 0), timeStop(1000, 1)],
      loop: true,
      easing: 'linear',
      delayMs: 0,
    }
    expect(getPropertyShapeDeps(s)).toBe(DEPS_ZOOM_TIME)
  })

  it('data-driven .field → FEATURE', () => {
    const expr: DataExpr = {
      ast: { kind: 'FieldAccess', object: null as never, name: 'rank' } as never,
    }
    const s: PropertyShape<number> = { kind: 'data-driven', expr }
    expect(getPropertyShapeDeps(s)).toBe(DEPS_FEATURE)
  })
})

describe('deps — DataExpr classification round-trip', () => {
  it('zoom identifier → ZOOM', () => {
    const expr: DataExpr = { ast: { kind: 'Identifier', name: 'zoom' } as never }
    expect(getDataExprDeps(expr)).toBe(DEPS_ZOOM)
  })

  it('pure literal → NONE', () => {
    const expr: DataExpr = { ast: { kind: 'NumberLiteral', value: 42 } as never }
    expect(getDataExprDeps(expr)).toBe(DEPS_NONE)
  })
})
