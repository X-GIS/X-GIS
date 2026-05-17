// Pin: XGISLayerStyle.extrude getter / setter behave consistently with
// the sibling opacity / fill / strokeWidth / visible setters. Added in
// 55ae0cd; ensures a future refactor of the setter contract doesn't
// silently regress the new API surface.

import { describe, it, expect, vi } from 'vitest'
import { XGISLayer } from './layer'
import type { ShowCommand } from './render/renderer'

function makeShow(extrude: ShowCommand['extrude'] = { kind: 'none' }): ShowCommand {
  // Minimal ShowCommand stub — only fields the extrude getter / setter
  // touches need to be real; everything else can be filler. Mirrors
  // the rest of the layer.ts setter contracts (StyleHost reads `show`
  // and calls `invalidate`).
  return {
    targetName: 'src',
    fill: null,
    stroke: null,
    strokeWidth: 1,
    projection: 'mercator',
    visible: true,
    pointerEvents: 'auto',
    opacity: 1,
    size: null,
    shaderVariant: null,
    filterExpr: null,
    geometryExpr: null,
    sizeUnit: null,
    sizeExpr: null,
    billboard: false,
    shape: null,
    extrude,
    extrudeBase: { kind: 'none' },
    paintShapes: {
      fill: { kind: 'constant', value: [0, 0, 0, 1] as never },
      stroke: { kind: 'constant', value: [0, 0, 0, 1] as never },
      opacity: { kind: 'constant', value: 1 },
      strokeWidth: { kind: 'constant', value: 1 },
      size: { kind: 'constant', value: 0 },
    },
  } as unknown as ShowCommand
}

describe('XGISLayer.extrude getter / setter', () => {
  it('reads null when the compiled extrude is `kind: none`', () => {
    const show = makeShow({ kind: 'none' })
    const layer = new XGISLayer('test', show, () => {})
    expect(layer.style.extrude).toBeNull()
  })

  it('reads the numeric value when the compiled extrude is `kind: constant`', () => {
    const show = makeShow({ kind: 'constant', value: 42 })
    const layer = new XGISLayer('test', show, () => {})
    expect(layer.style.extrude).toBe(42)
  })

  it('reads null when the compiled extrude is `kind: feature` (per-feature)', () => {
    // The public getter intentionally returns null for per-feature
    // dispatch — there is no single uniform value to report. The
    // per-feature AST stays untouched on show.extrude.
    const show = makeShow({
      kind: 'feature',
      expr: { ast: {} as never },
      fallback: 30,
    } as never)
    const layer = new XGISLayer('test', show, () => {})
    expect(layer.style.extrude).toBeNull()
  })

  it('setting a number replaces the extrude with `kind: constant`', () => {
    const invalidate = vi.fn()
    const show = makeShow({ kind: 'none' })
    const layer = new XGISLayer('test', show, invalidate)
    layer.style.extrude = 50
    expect(show.extrude).toEqual({ kind: 'constant', value: 50 })
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('setting null flattens the layer (`kind: none`)', () => {
    const invalidate = vi.fn()
    const show = makeShow({ kind: 'constant', value: 50 })
    const layer = new XGISLayer('test', show, invalidate)
    layer.style.extrude = null
    expect(show.extrude).toEqual({ kind: 'none' })
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('reset() restores the compiled default', () => {
    const show = makeShow({ kind: 'constant', value: 100 })
    const layer = new XGISLayer('test', show, () => {})
    layer.style.extrude = 25
    expect(show.extrude).toEqual({ kind: 'constant', value: 25 })
    layer.style.reset('extrude')
    expect(show.extrude).toEqual({ kind: 'constant', value: 100 })
  })
})
