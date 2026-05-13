import { describe, it, expect } from 'vitest'
import {
  colorValueToShape,
  opacityValueToShape,
  strokeWidthValueToShape,
  sizeValueToShape,
} from './to-property-shape'
import type { ColorValue, OpacityValue, StrokeWidthValue, SizeValue } from './render-node'

describe('RenderNode → PropertyShape conversion', () => {
  // ─── ColorValue ──────────────────────────────────────────────────

  it('ColorValue { none } → null', () => {
    const v: ColorValue = { kind: 'none' }
    expect(colorValueToShape(v)).toBeNull()
  })

  it('ColorValue { constant } → Static', () => {
    const v: ColorValue = { kind: 'constant', rgba: [1, 0, 0, 1] }
    expect(colorValueToShape(v)).toEqual({ kind: 'constant', value: [1, 0, 0, 1] })
  })

  it('ColorValue { zoom-interpolated } → ZoomOnly', () => {
    const v: ColorValue = {
      kind: 'zoom-interpolated',
      stops: [
        { zoom: 0, value: [0, 0, 0, 1] },
        { zoom: 10, value: [1, 1, 1, 1] },
      ],
      base: 1.2,
    }
    const shape = colorValueToShape(v)
    expect(shape).toMatchObject({ kind: 'zoom-interpolated', base: 1.2 })
    expect((shape as { stops: unknown[] }).stops).toHaveLength(2)
  })

  it('ColorValue { time-interpolated } → TimeOnly', () => {
    const v: ColorValue = {
      kind: 'time-interpolated',
      base: [0, 0, 0, 0],
      stops: [
        { timeMs: 0, value: [0, 0, 0, 1] },
        { timeMs: 1000, value: [1, 1, 1, 1] },
      ],
      loop: true,
      easing: 'ease-in',
      delayMs: 100,
    }
    const shape = colorValueToShape(v)
    expect(shape).toMatchObject({
      kind: 'time-interpolated',
      loop: true,
      easing: 'ease-in',
      delayMs: 100,
    })
  })

  it('ColorValue { data-driven } → FeatureOnly', () => {
    const expr = { ast: {} as never } as never
    const v: ColorValue = { kind: 'data-driven', expr }
    expect(colorValueToShape(v)).toEqual({ kind: 'data-driven', expr })
  })

  it('ColorValue { conditional } folds to its fallback', () => {
    const v: ColorValue = {
      kind: 'conditional',
      branches: [],
      fallback: { kind: 'constant', rgba: [0.5, 0.5, 0.5, 1] },
    }
    expect(colorValueToShape(v)).toEqual({
      kind: 'constant',
      value: [0.5, 0.5, 0.5, 1],
    })
  })

  // ─── OpacityValue ────────────────────────────────────────────────

  it('OpacityValue { constant } → Static', () => {
    expect(opacityValueToShape({ kind: 'constant', value: 0.7 })).toEqual({
      kind: 'constant', value: 0.7,
    })
  })

  it('OpacityValue { zoom-interpolated } → ZoomOnly', () => {
    const v: OpacityValue = {
      kind: 'zoom-interpolated',
      stops: [{ zoom: 3, value: 0.5 }, { zoom: 6, value: 1 }],
      base: 1,
    }
    expect(opacityValueToShape(v)).toMatchObject({ kind: 'zoom-interpolated', base: 1 })
  })

  it('OpacityValue { zoom-time } → ZoomTime', () => {
    const v: OpacityValue = {
      kind: 'zoom-time',
      zoomStops: [{ zoom: 3, value: 0.5 }],
      timeStops: [{ timeMs: 0, value: 1 }],
      loop: false,
      easing: 'linear',
      delayMs: 0,
    }
    expect(opacityValueToShape(v)).toMatchObject({ kind: 'zoom-time', loop: false })
  })

  // ─── StrokeWidthValue ────────────────────────────────────────────
  // Post-migration StrokeWidthValue is `PropertyShape<number>` and
  // strokeWidthValueToShape is identity. The cases below verify each
  // PropertyShape variant survives the shim unchanged.

  it('StrokeWidthValue { constant } → Static', () => {
    expect(strokeWidthValueToShape({ kind: 'constant', value: 3 })).toEqual({
      kind: 'constant', value: 3,
    })
  })

  it('StrokeWidthValue { zoom-interpolated } → ZoomOnly', () => {
    const v: StrokeWidthValue = {
      kind: 'zoom-interpolated',
      stops: [{ zoom: 0, value: 1 }, { zoom: 14, value: 6 }],
    }
    expect(strokeWidthValueToShape(v)).toMatchObject({ kind: 'zoom-interpolated' })
  })

  it('StrokeWidthValue { data-driven } → FeatureOnly', () => {
    const expr = { ast: {} as never } as never
    const v: StrokeWidthValue = { kind: 'data-driven', expr }
    expect(strokeWidthValueToShape(v)).toEqual({ kind: 'data-driven', expr })
  })

  // ─── SizeValue ───────────────────────────────────────────────────

  it('SizeValue { none } → null', () => {
    expect(sizeValueToShape({ kind: 'none' })).toBeNull()
  })

  it('SizeValue { constant } → Static (drops unit)', () => {
    expect(sizeValueToShape({ kind: 'constant', value: 12, unit: 'px' })).toEqual({
      kind: 'constant', value: 12,
    })
  })

  it('SizeValue { zoom-interpolated } → ZoomOnly', () => {
    const v: SizeValue = {
      kind: 'zoom-interpolated',
      stops: [{ zoom: 0, value: 10 }, { zoom: 8, value: 14 }],
    }
    expect(sizeValueToShape(v)).toMatchObject({ kind: 'zoom-interpolated' })
  })
})
