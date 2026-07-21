import { describe, expect, it } from 'vitest'
import type { PropertyShape } from '@xgis/compiler'
import { PaintTransitionRegistry, type ColorAxis, type NumberAxis } from './paint-transitions'
import { resolveColorShape, resolveNumberShape } from './render/paint-shape-resolve'

// Paint-transition registry (#1255) — the setPaintProperty ramp machine.
// These tests drive the registry against the REAL paint-shape resolvers,
// so what they pin is the end-to-end contract the renderer sees: the ramp
// evaluates between from/to on the live evaluator, clamps at `to`, and
// settles back to a constant (the fast-path representation).

type Rgba = readonly [number, number, number, number]

function numberAxis(initial: PropertyShape<number>): NumberAxis & { shape: PropertyShape<number> } {
  const box = {
    shape: initial,
    get: () => box.shape,
    set: (s: PropertyShape<number>) => {
      box.shape = s
    },
  }
  return box
}

function colorAxis(
  initial: PropertyShape<Rgba> | null,
): ColorAxis & { shape: PropertyShape<Rgba> | null } {
  const box = {
    shape: initial,
    get: () => box.shape,
    set: (s: PropertyShape<Rgba> | null) => {
      box.shape = s
    },
  }
  return box
}

describe('PaintTransitionRegistry — numeric axes', () => {
  it('writes a two-stop ramp the live resolver evaluates between from and to', () => {
    const r = new PaintTransitionRegistry()
    const axis = numberAxis({ kind: 'constant', value: 2 })
    r.beginNumber(axis, 6, 1000, 300, 5)
    expect(axis.shape.kind).toBe('time-interpolated')
    // Mid-ramp on the REAL evaluator: at now+150 the value sits halfway.
    expect(resolveNumberShape(axis.shape, 5, 1150).value).toBeCloseTo(4, 10)
    // Clamps at `to` past the end even BEFORE settle runs.
    expect(resolveNumberShape(axis.shape, 5, 2000).value).toBe(6)
    expect(r.hasActive()).toBe(true)
  })

  it('settle() swaps the finished ramp for the terminal constant', () => {
    const r = new PaintTransitionRegistry()
    const axis = numberAxis({ kind: 'constant', value: 0 })
    r.beginNumber(axis, 1, 0, 300, 3)
    expect(r.settle(150)).toBe(true) // still in flight
    expect(axis.shape.kind).toBe('time-interpolated')
    expect(r.settle(300)).toBe(false) // done
    expect(axis.shape).toEqual({ kind: 'constant', value: 1 })
    expect(r.size).toBe(0)
  })

  it('equal from/to writes the constant directly — no entry, no keep-alive', () => {
    const r = new PaintTransitionRegistry()
    const axis = numberAxis({ kind: 'constant', value: 0.5 })
    r.beginNumber(axis, 0.5, 0, 300, 3)
    expect(axis.shape).toEqual({ kind: 'constant', value: 0.5 })
    expect(r.hasActive()).toBe(false)
  })

  it('re-set mid-ramp reverses smoothly from the CURRENT evaluated value', () => {
    const r = new PaintTransitionRegistry()
    const axis = numberAxis({ kind: 'constant', value: 0 })
    r.beginNumber(axis, 1, 0, 300, 3)
    // At t=150 the ramp reads 0.5; a reversal begins from there.
    r.beginNumber(axis, 0, 150, 300, 3)
    expect(resolveNumberShape(axis.shape, 3, 150).value).toBeCloseTo(0.5, 10)
    expect(resolveNumberShape(axis.shape, 3, 300).value).toBeCloseTo(0.25, 10)
    expect(resolveNumberShape(axis.shape, 3, 450).value).toBe(0)
  })

  it('ramps FROM a zoom-interpolated shape using the current camera zoom', () => {
    const r = new PaintTransitionRegistry()
    const axis = numberAxis({
      kind: 'zoom-interpolated',
      stops: [
        { zoom: 0, value: 0 },
        { zoom: 10, value: 10 },
      ],
    })
    r.beginNumber(axis, 0, 0, 300, 4) // current value at z4 = 4
    expect(resolveNumberShape(axis.shape, 4, 0).value).toBeCloseTo(4, 10)
    expect(resolveNumberShape(axis.shape, 4, 300).value).toBe(0)
  })
})

describe('PaintTransitionRegistry — colour axes', () => {
  const GREEN: Rgba = [0, 1, 0, 1]
  const BLUE: Rgba = [0, 0, 1, 1]

  it('ramps from a constant shape; the live colour resolver reads the midpoint', () => {
    const r = new PaintTransitionRegistry()
    const axis = colorAxis({ kind: 'constant', value: GREEN })
    r.beginColor(axis, BLUE, 1000, 300, 3, null)
    const mid = resolveColorShape(axis.shape!, 3, 1150)!
    expect(mid.value[1]).toBeCloseTo(0.5, 10)
    expect(mid.value[2]).toBeCloseTo(0.5, 10)
    expect(r.settle(1300)).toBe(false)
    expect(axis.shape).toEqual({ kind: 'constant', value: BLUE })
  })

  it('null current shape ramps from the static hex fallback when provided', () => {
    const r = new PaintTransitionRegistry()
    const axis = colorAxis(null)
    r.beginColor(axis, BLUE, 0, 300, 3, GREEN)
    expect(axis.shape!.kind).toBe('time-interpolated')
    expect(resolveColorShape(axis.shape!, 3, 0)!.value[1]).toBeCloseTo(1, 10)
  })

  it('no from-value at all (data-driven / no static) applies instantly', () => {
    const r = new PaintTransitionRegistry()
    const axis = colorAxis({ kind: 'data-driven', expr: {} as never })
    r.beginColor(axis, BLUE, 0, 300, 3, null)
    expect(axis.shape).toEqual({ kind: 'constant', value: BLUE })
    expect(r.hasActive()).toBe(false)
  })

  it('clear() drops pending ramps without settling them', () => {
    const r = new PaintTransitionRegistry()
    const axis = colorAxis({ kind: 'constant', value: GREEN })
    r.beginColor(axis, BLUE, 0, 300, 3, null)
    r.clear()
    expect(r.hasActive()).toBe(false)
    // The ramp shape survives on the (about-to-be-discarded) bundle; a
    // wholesale scene rebuild replaces it, so no settle write happens.
    expect(axis.shape!.kind).toBe('time-interpolated')
  })
})
